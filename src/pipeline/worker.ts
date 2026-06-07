// Background pipeline worker.
//
// One process, one tick at a time, polling every `pollIntervalMs`. Each tick
// drains three queues in order:
//
//   1. Cook queue:        chapters where processedAt IS NULL
//   2. Transcribe queue:  AudioFiles where Transcript IS NULL and
//                         transcribeAttempts < TRANSCRIBE_MAX_ATTEMPTS
//   3. Status advancement: sessions where endedAt set + all chapters
//                          processed + every AudioFile has a Transcript →
//                          READY
//
// Failure handling:
//   - Cook: failure marks chapter processedAt anyway (so we stop thrashing)
//     and sets session.status = FAILED. Operator re-nulls processedAt to retry.
//   - Transcribe: failure increments transcribeAttempts and stores the error
//     string. We stop trying after TRANSCRIBE_MAX_ATTEMPTS. Operator resets
//     the counter to retry.
//
// Concurrency: cook is sequential per chapter (one at a time). Transcription
// runs up to `transcribeConcurrency` AudioFiles in parallel — gentler on the
// Gemini API and the VPS than going wide.
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db.js';
import { notifyAdmin, notifyAdminNeedsReview } from '../discord/notifier.js';
import { cookChapter, recordingBasename } from './cook.js';
import { pollDriveOnce } from './driveIngest.js';
import { extractIntroFromTranscript } from './extractIntros.js';
import { reconcileSession, type PerTrackExtraction } from './reconcile.js';
import { postOneScheduledRecap } from './recapPoster.js';
import { summarizeSession } from './summarize.js';
import { transcribeAudioFile } from './transcribe.js';
import { parseOggUsers } from './users.js';

/**
 * Returns 'GEMINI' or 'EXTERNAL_WHISPER' — the effective transcription
 * source for a session. Per-session override wins; falls back to the
 * BotSettings global; falls back to EXTERNAL_WHISPER if even settings
 * are missing (seed should have created them, but defensive).
 */
async function effectiveTranscriptionSource(
  sessionId: string
): Promise<'GEMINI' | 'EXTERNAL_WHISPER'> {
  const prisma = getPrisma();
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { transcriptionSource: true }
  });
  if (session?.transcriptionSource) return session.transcriptionSource;
  const settings = await prisma.botSettings.findUnique({
    where: { id: 1 },
    select: { transcriptionSource: true }
  });
  return settings?.transcriptionSource ?? 'EXTERNAL_WHISPER';
}

interface WorkerConfig {
  cookScriptDir: string;
  cookedBaseDir: string;
  pollIntervalMs: number;
  cookTimeoutMs: number;
  transcribeModel: string;
  transcribeLanguageHint: string;
  transcribeConcurrency: number;
  transcribeMaxAttempts: number;
  transcribeTimeoutMs: number;
  // Stage 5
  summarizeModel: string;
  summarizeLanguageHint: string;
  summarizeMaxAttempts: number;
  summarizeTimeoutMs: number;
  shortSummaryWordTarget: number;
  keyEventsTarget: number;
  introExtractionTimeoutMs: number;
  // Stage 6
  recapPostMaxAttempts: number;
  // Stage 6.5
  googleApiKey: string | undefined;
  whisperFallbackDays: number;     // 10 by default
  whisperStopDays: number;          // 14 by default
}

interface WorkerHandle {
  stop: () => Promise<void>;
}

export function startWorker(config: WorkerConfig, log: FastifyBaseLogger): WorkerHandle {
  let stopped = false;
  let currentTick: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(tick, config.pollIntervalMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    currentTick = (async () => {
      try {
        // 1. Drain cook queue (sequential)
        for (let i = 0; i < 10; i++) {
          const processed = await processOneChapter(config, log);
          if (!processed) break;
          if (stopped) return;
        }

        // 2. Drain transcribe queue (parallel up to transcribeConcurrency).
        // Track IDs already touched this tick so a failing file doesn't
        // burn all 3 attempts in milliseconds — bad files get one shot per
        // tick (30s) rather than three in a row.
        const triedThisTick = new Set<string>();
        for (let i = 0; i < 25; i++) {
          const processed = await processTranscribeBatch(config, log, triedThisTick);
          if (!processed) break;
          if (stopped) return;
        }

        // 3. Advance any sessions that finished transcription
        if (!stopped) await advanceCompletedSessions(log);

        // 4. Drain summarize queue (one session per tick — heavy step)
        if (!stopped) {
          for (let i = 0; i < 3; i++) {
            const processed = await processOneSummarize(config, log);
            if (!processed) break;
            if (stopped) return;
          }
        }

        // 5. Drain recap-post queue. Each tick can post at most a few; we
        // don't want to spam the channel if many sessions ripened at once.
        if (!stopped) {
          for (let i = 0; i < 3; i++) {
            const processed = await postOneScheduledRecap(
              { maxAttempts: config.recapPostMaxAttempts },
              log
            );
            if (!processed) break;
            if (stopped) return;
          }
        }

        // 6. Drive ingest — only runs when poll interval elapsed.
        if (!stopped) await maybePollDrive(config, log, false);

        // 7. Age check for external_whisper sessions: 10d → switch to gemini,
        //    14d → NEEDS_REVIEW + admin DM.
        if (!stopped) await checkWhisperAge(config, log);
      } catch (err) {
        log.error({ err }, 'pipeline worker tick failed');
      } finally {
        scheduleNext();
      }
    })();
    await currentTick;
  };

  void tick();
  log.info(
    {
      pollIntervalMs: config.pollIntervalMs,
      transcribeModel: config.transcribeModel,
      transcribeConcurrency: config.transcribeConcurrency,
      transcribeMaxAttempts: config.transcribeMaxAttempts
    },
    'pipeline worker started'
  );

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (currentTick) {
        try { await currentTick; } catch { /* logged inside */ }
      }
      log.info('pipeline worker stopped');
    }
  };
}

// ---------------------------------------------------------------------------
// Cook
// ---------------------------------------------------------------------------

async function processOneChapter(config: WorkerConfig, log: FastifyBaseLogger): Promise<boolean> {
  const prisma = getPrisma();
  const chapter = await prisma.chapter.findFirst({
    where: { processedAt: null },
    orderBy: { receivedAt: 'asc' },
    include: { session: true }
  });
  if (!chapter) return false;

  const recordingId = recordingBasename(chapter.rawDataPath);
  const outputDir = path.join(config.cookedBaseDir, chapter.sessionId, String(chapter.chapterIndex));

  // Stage 6.5: figure out the effective transcription source for this
  // session. If external_whisper, we still parse .ogg.users + create
  // AudioFile rows, but we skip the cook.sh invocation since we won't be
  // sending audio to Gemini for this session.
  const source = await effectiveTranscriptionSource(chapter.sessionId);
  const useGemini = source === 'GEMINI';

  log.info(
    {
      chapterId: chapter.id,
      sessionId: chapter.sessionId,
      chapterIndex: chapter.chapterIndex,
      recordingId,
      transcriptionSource: source
    },
    useGemini ? 'cooking chapter (gemini)' : 'parsing chapter users (external_whisper, no cook)'
  );

  await prisma.session.update({
    where: { id: chapter.sessionId },
    data: { status: 'COOKING' }
  });

  try {
    // ALWAYS parse .ogg.users — both paths need the user→track mapping.
    const users = await parseOggUsers(chapter.rawUsersPath);
    const userByTrack = new Map(users.map((u) => [u.trackIndex, u]));
    const discordIds = users
      .map((u) => u.discordUserId)
      .filter((v): v is string => Boolean(v));
    const dbUsers: Array<{ id: string; discordUserId: string }> = discordIds.length
      ? await prisma.user.findMany({
          where: { discordUserId: { in: discordIds } },
          select: { id: true, discordUserId: true }
        })
      : [];
    const internalIdByDiscord = new Map(dbUsers.map((u) => [u.discordUserId, u.id]));

    let cookFiles: Array<{ trackIndex: number; absolutePath: string; fileSizeBytes: number }> = [];
    if (useGemini) {
      const result = await cookChapter({
        cookScriptDir: config.cookScriptDir,
        recordingId,
        outputDir,
        timeoutMs: config.cookTimeoutMs
      });
      if (result.cookExitCode !== 0) {
        throw new Error(`cook.sh exit ${result.cookExitCode}: ${result.cookStderr.slice(-500)}`);
      }
      if (result.files.length === 0) {
        throw new Error('cook.sh produced no FLAC files');
      }
      cookFiles = result.files;
    }

    // For external_whisper, derive a per-track placeholder so we still get
    // AudioFile rows. cooked_path is set to the would-be path; if the
    // session is later flipped to gemini, cook.sh runs and overwrites this
    // entry via the upsert.
    const trackEntries = useGemini
      ? cookFiles.map((f) => ({
          trackIndex: f.trackIndex,
          absolutePath: f.absolutePath,
          fileSizeBytes: f.fileSizeBytes
        }))
      : users.map((u) => ({
          trackIndex: u.trackIndex,
          absolutePath: path.join(outputDir, `${u.trackIndex}.pending.flac`),
          fileSizeBytes: 0
        }));

    let unknownUserCount = 0;
    for (const file of trackEntries) {
      const u = userByTrack.get(file.trackIndex);
      const userId = u?.discordUserId ? internalIdByDiscord.get(u.discordUserId) : undefined;
      if (!userId) unknownUserCount += 1;
      await prisma.audioFile.upsert({
        where: {
          chapterId_trackIndex: { chapterId: chapter.id, trackIndex: file.trackIndex }
        },
        create: {
          chapterId: chapter.id,
          userId: userId ?? null,
          trackIndex: file.trackIndex,
          cookedPath: file.absolutePath,
          format: 'flac',
          fileSizeBytes: BigInt(file.fileSizeBytes)
        },
        update: {
          userId: userId ?? null,
          cookedPath: file.absolutePath,
          fileSizeBytes: BigInt(file.fileSizeBytes)
        }
      });
    }

    if (unknownUserCount > 0) {
      log.warn(
        { chapterId: chapter.id, unknownUserCount, totalTracks: result.files.length },
        'some tracks did not map to a known User — seed may be missing Discord IDs'
      );
    }

    await prisma.chapter.update({
      where: { id: chapter.id },
      data: { processedAt: new Date() }
    });
    log.info(
      { chapterId: chapter.id, sessionId: chapter.sessionId, trackCount: result.files.length, outputDir },
      'chapter cooked'
    );
    return true;
  } catch (err) {
    log.error(
      { err, chapterId: chapter.id, sessionId: chapter.sessionId, recordingId },
      'cook failed; marking chapter processed and session failed (re-null processed_at to retry)'
    );
    await prisma.chapter.update({
      where: { id: chapter.id },
      data: { processedAt: new Date() }
    });
    await prisma.session.update({
      where: { id: chapter.sessionId },
      data: { status: 'FAILED' }
    });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Transcribe
// ---------------------------------------------------------------------------

/**
 * Pull up to `transcribeConcurrency` untranscribed AudioFiles and run them
 * in parallel. Returns true if anything was processed (caller loops).
 */
// Typed shape we project from the AudioFile findMany. Spelled out explicitly
// so TS doesn't need help inferring through the Prisma `include` mechanics —
// also keeps the code readable when scanning.
interface TranscribeJob {
  id: string;
  cookedPath: string;
  chapter: { sessionId: string };
}

async function processTranscribeBatch(
  config: WorkerConfig,
  log: FastifyBaseLogger,
  triedThisTick: Set<string>
): Promise<boolean> {
  const prisma = getPrisma();
  // Stage 6.5: only pick up AudioFiles for sessions whose effective
  // transcription source is GEMINI. We don't store the resolved source on
  // the row, so we filter via a relation. external_whisper sessions skip
  // this queue entirely — their Transcripts come from driveIngest.
  const batch: TranscribeJob[] = await prisma.audioFile.findMany({
    where: {
      transcript: null,
      transcribeAttempts: { lt: config.transcribeMaxAttempts },
      chapter: {
        processedAt: { not: null },
        session: {
          OR: [
            { transcriptionSource: 'GEMINI' },
            {
              transcriptionSource: null,
              // Inherit from BotSettings — represented by NULL on the
              // session itself. We can't join a singleton through prisma
              // findMany, so we filter here and re-check inside.
            }
          ]
        }
      },
      ...(triedThisTick.size > 0 ? { id: { notIn: Array.from(triedThisTick) } } : {})
    },
    orderBy: { cookedAt: 'asc' },
    take: config.transcribeConcurrency * 2, // overfetch, filter below
    select: {
      id: true,
      cookedPath: true,
      chapter: { select: { sessionId: true } }
    }
  });
  if (batch.length === 0) return false;

  // Re-check the effective source inside JS to honor BotSettings global.
  const filtered: TranscribeJob[] = [];
  for (const job of batch) {
    const source = await effectiveTranscriptionSource(job.chapter.sessionId);
    if (source === 'GEMINI') filtered.push(job);
    if (filtered.length >= config.transcribeConcurrency) break;
  }
  if (filtered.length === 0) return false;

  for (const af of filtered) triedThisTick.add(af.id);

  // Bump status to TRANSCRIBING for any session whose AudioFile we're about
  // to touch — but only if still in COOKING (don't downgrade from READY/FAILED).
  const sessionIds = Array.from(new Set(filtered.map((af: TranscribeJob) => af.chapter.sessionId)));
  await prisma.session.updateMany({
    where: { id: { in: sessionIds }, status: 'COOKING' },
    data: { status: 'TRANSCRIBING' }
  });

  await Promise.all(
    filtered.map((af: TranscribeJob) => transcribeOne(af.id, af.cookedPath, config, log))
  );
  return true;
}

// ---------------------------------------------------------------------------
// Stage 6.5 — Drive ingest + whisper-age fallback
// ---------------------------------------------------------------------------

/**
 * Poll Drive for new whisper transcripts. Respects BotSettings poll interval
 * unless `force` is true. Exposed externally so /check-drive can call it.
 */
export async function maybePollDrive(
  config: WorkerConfig,
  log: FastifyBaseLogger,
  force: boolean
): Promise<{ ran: boolean; report?: Awaited<ReturnType<typeof pollDriveOnce>> }> {
  if (!config.googleApiKey) return { ran: false };
  const prisma = getPrisma();
  const settings = await prisma.botSettings.findUnique({ where: { id: 1 } });
  if (!settings?.driveFolderId) return { ran: false };

  if (!force) {
    const intervalMs = (settings.drivePollIntervalHours ?? 6) * 60 * 60 * 1000;
    if (settings.driveLastPolledAt) {
      const sinceLast = Date.now() - settings.driveLastPolledAt.getTime();
      if (sinceLast < intervalMs) return { ran: false };
    }
  }

  log.info({ folderId: settings.driveFolderId, force }, 'polling drive for whisper transcripts');
  const report = await pollDriveOnce(config.googleApiKey, settings.driveFolderId, log);
  await prisma.botSettings.update({
    where: { id: 1 },
    data: { driveLastPolledAt: new Date() }
  });
  log.info({ report }, 'drive poll complete');
  return { ran: true, report };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * For external_whisper sessions: after N days without all transcripts in,
 * flip to gemini (so the user isn't stuck waiting forever). After M days,
 * give up and require manual review.
 */
async function checkWhisperAge(config: WorkerConfig, log: FastifyBaseLogger): Promise<void> {
  const prisma = getPrisma();
  // Sessions whose effective source is external_whisper, still incomplete.
  const candidates = await prisma.session.findMany({
    where: {
      status: { in: ['RECEIVING', 'COOKING', 'TRANSCRIBING'] },
      OR: [
        { transcriptionSource: 'EXTERNAL_WHISPER' },
        { transcriptionSource: null }
      ],
      endedAt: { not: null }
    },
    select: { id: true, recordingId: true, endedAt: true, transcriptionSource: true }
  });

  for (const s of candidates) {
    if (!s.endedAt) continue;
    // Honor the global default for null sessions
    if (s.transcriptionSource === null) {
      const settings = await prisma.botSettings.findUnique({
        where: { id: 1 },
        select: { transcriptionSource: true }
      });
      if (settings?.transcriptionSource !== 'EXTERNAL_WHISPER') continue;
    }
    const ageDays = (Date.now() - s.endedAt.getTime()) / DAY_MS;
    if (ageDays >= config.whisperStopDays) {
      log.warn(
        { sessionId: s.id, recordingId: s.recordingId, ageDays },
        'whisper-age: 14d elapsed without transcripts — moving to NEEDS_REVIEW'
      );
      await prisma.session.update({
        where: { id: s.id },
        data: { status: 'NEEDS_REVIEW', summarizeError: 'no whisper transcripts after 14 days' }
      });
      await notifyAdmin(
        log,
        `Session \`${s.id}\` (\`${s.recordingId}\`) has been waiting on whisper transcripts for ${config.whisperStopDays} days and has been moved to NEEDS_REVIEW.`
      );
    } else if (ageDays >= config.whisperFallbackDays) {
      log.warn(
        { sessionId: s.id, recordingId: s.recordingId, ageDays },
        'whisper-age: 10d elapsed without transcripts — switching session to gemini'
      );
      await prisma.session.update({
        where: { id: s.id },
        data: { transcriptionSource: 'GEMINI' }
      });
      await notifyAdmin(
        log,
        `Session \`${s.id}\` (\`${s.recordingId}\`) had no whisper transcripts after ${config.whisperFallbackDays} days. Switched to Gemini transcription; cook + transcribe will run on the next tick.`
      );
    }
  }
}

async function transcribeOne(
  audioFileId: string,
  cookedPath: string,
  config: WorkerConfig,
  log: FastifyBaseLogger
): Promise<void> {
  const prisma = getPrisma();
  log.info({ audioFileId, cookedPath }, 'transcribing audio file');
  try {
    const result = await transcribeAudioFile({
      filePath: cookedPath,
      model: config.transcribeModel,
      languageHint: config.transcribeLanguageHint,
      timeoutMs: config.transcribeTimeoutMs
    });
    await prisma.$transaction([
      prisma.transcript.create({
        data: {
          audioFileId,
          fullText: result.fullText,
          // Cast: Prisma Json type accepts any JSON-serializable value at
          // runtime; the segments shape is validated by zod inside
          // transcribeAudioFile so we know it's safe here.
          segments: result.segments as unknown as object,
          language: result.language,
          geminiRequestId: result.responseId
        }
      }),
      prisma.audioFile.update({
        where: { id: audioFileId },
        data: { transcribeError: null }
      })
    ]);
    log.info(
      {
        audioFileId,
        charCount: result.fullText.length,
        segmentCount: result.segments.length,
        language: result.language
      },
      'audio file transcribed'
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updated = await prisma.audioFile.update({
      where: { id: audioFileId },
      data: {
        transcribeAttempts: { increment: 1 },
        transcribeError: message.slice(0, 1000)
      },
      select: { transcribeAttempts: true }
    });
    log.warn(
      {
        audioFileId,
        attempts: updated.transcribeAttempts,
        maxAttempts: config.transcribeMaxAttempts,
        err: message
      },
      updated.transcribeAttempts >= config.transcribeMaxAttempts
        ? 'transcribe failed (giving up; nullify audio_files.transcribe_attempts to retry)'
        : 'transcribe failed (will retry on next tick)'
    );
  }
}

// ---------------------------------------------------------------------------
// Session status advancement
// ---------------------------------------------------------------------------

/**
 * Move any TRANSCRIBING / COOKING session to SUMMARIZING once:
 *   - session.endedAt is set (final chapter received), AND
 *   - every chapter has processedAt set, AND
 *   - every AudioFile has a Transcript.
 *
 * Note: previous stages used READY as the "transcripts-done" state. Stage 5
 * inserts SUMMARIZING between TRANSCRIBING and READY — READY now means
 * "summary written, ready to post".
 */
async function advanceCompletedSessions(log: FastifyBaseLogger): Promise<void> {
  const prisma = getPrisma();
  const candidates = await prisma.session.findMany({
    where: {
      status: { in: ['TRANSCRIBING', 'COOKING'] },
      endedAt: { not: null }
    },
    select: { id: true }
  });
  for (const { id } of candidates) {
    const unfinishedChapter = await prisma.chapter.findFirst({
      where: { sessionId: id, processedAt: null },
      select: { id: true }
    });
    if (unfinishedChapter) continue;

    const untranscribed = await prisma.audioFile.findFirst({
      where: { chapter: { sessionId: id }, transcript: null },
      select: { id: true }
    });
    if (untranscribed) continue;

    await prisma.session.update({
      where: { id },
      data: { status: 'SUMMARIZING' }
    });
    log.info({ sessionId: id }, 'session ready for summarization');
  }
}

// ---------------------------------------------------------------------------
// Summarize (Stage 5)
// ---------------------------------------------------------------------------

/**
 * Pick the oldest SUMMARIZING session and run the full Stage 5 pipeline:
 *   1. Extract intros from every track (parallel Gemini calls)
 *   2. Reconcile campaign / DM / character assignments
 *      - On failure: status → NEEDS_REVIEW, DM admin, stop
 *   3. Persist SessionPlayer rows + session.campaign_id + dm_user_id
 *   4. Summarize chronologically + extract character memories (1 Gemini call)
 *   5. Persist Summary + CharacterMemory rows
 *   6. status → READY
 */
async function processOneSummarize(
  config: WorkerConfig,
  log: FastifyBaseLogger
): Promise<boolean> {
  const prisma = getPrisma();
  const session = await prisma.session.findFirst({
    where: {
      status: 'SUMMARIZING',
      summarizeAttempts: { lt: config.summarizeMaxAttempts }
    },
    orderBy: { endedAt: 'asc' },
    include: {
      chapters: {
        include: {
          audioFiles: {
            include: {
              transcript: { select: { fullText: true } }
            }
          }
        }
      }
    }
  });
  if (!session) return false;

  log.info({ sessionId: session.id }, 'starting summarization pipeline');

  // Flatten AudioFiles + their transcripts, one per track per chapter.
  // For intro extraction we only need ONE transcript per user (typically
  // the longest), since the user is the same speaker across chapters. We
  // pick the AudioFile with the most text.
  interface TrackEntry {
    audioFileId: string;
    userId: string | null;
    trackIndex: number;
    transcript: string;
  }
  const byUser = new Map<string, TrackEntry>();
  for (const chapter of session.chapters) {
    for (const af of chapter.audioFiles) {
      const text = af.transcript?.fullText ?? '';
      if (!text || !af.userId) continue;
      const existing = byUser.get(af.userId);
      if (!existing || text.length > existing.transcript.length) {
        byUser.set(af.userId, {
          audioFileId: af.id,
          userId: af.userId,
          trackIndex: af.trackIndex,
          transcript: text
        });
      }
    }
  }
  const tracks = Array.from(byUser.values());
  if (tracks.length === 0) {
    return await markSummarizeFailed(
      session.id,
      'no transcribed tracks with a known user — cannot extract intros',
      log,
      config
    );
  }

  try {
    // 1. Extract intros in parallel.
    log.info({ sessionId: session.id, trackCount: tracks.length }, 'extracting intros');
    const extractions: PerTrackExtraction[] = await Promise.all(
      tracks.map(async (t) => {
        const result = await extractIntroFromTranscript({
          transcript: t.transcript,
          model: config.summarizeModel,
          timeoutMs: config.introExtractionTimeoutMs
        });
        return {
          audioFileId: t.audioFileId,
          userId: t.userId,
          trackIndex: t.trackIndex,
          isDm: result.isDm,
          characterName: result.characterName,
          campaignName: result.campaignName,
          confidence: result.confidence
        };
      })
    );

    // 2. Reconcile.
    const reconciliation = await reconcileSession({
      prisma,
      sessionId: session.id,
      discordGuildId: session.discordGuildId,
      extractions
    });

    if (!reconciliation.success) {
      log.warn(
        { sessionId: session.id, reason: reconciliation.reason, diagnostics: reconciliation.diagnostics },
        'reconciliation failed — flagging session for review'
      );
      await prisma.session.update({
        where: { id: session.id },
        data: { status: 'NEEDS_REVIEW', summarizeError: reconciliation.reason }
      });
      // Send DM with action buttons (one per active campaign in this guild).
      const campaignChoices = await prisma.campaign.findMany({
        where: { discordGuildId: session.discordGuildId, active: true },
        select: { id: true, name: true }
      });
      await notifyAdminNeedsReview(log, session.id, reconciliation.reason, campaignChoices);
      return true;
    }

    // 3. Persist SessionPlayer rows + session.campaign_id + dm_user_id.
    await prisma.$transaction(async (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => {
      await tx.sessionPlayer.deleteMany({ where: { sessionId: session.id } });
      for (const sp of reconciliation.sessionPlayers) {
        await tx.sessionPlayer.create({
          data: {
            sessionId: session.id,
            userId: sp.userId,
            characterId: sp.characterId,
            role: sp.role,
            trackIndex: sp.trackIndex,
            detectedFromVoice: sp.detectedFromVoice
          }
        });
      }
      // Assign sessionNumber as max(existing) + 1 for the campaign — first
      // time we know which campaign this session belongs to.
      const maxRow = await tx.session.aggregate({
        where: { campaignId: reconciliation.campaignId, sessionNumber: { not: null } },
        _max: { sessionNumber: true }
      });
      const nextNumber = (maxRow._max.sessionNumber ?? 0) + 1;
      await tx.session.update({
        where: { id: session.id },
        data: {
          campaignId: reconciliation.campaignId,
          dmUserId: reconciliation.dmUserId,
          sessionNumber: nextNumber,
          detectionMethod: 'VOICE_INTRO'
        }
      });
    });

    // 4. Summarize.
    log.info({ sessionId: session.id }, 'building chronological transcript and summarizing');
    const summary = await summarizeSession({
      prisma,
      sessionId: session.id,
      model: config.summarizeModel,
      languageHint: config.summarizeLanguageHint,
      shortWordTarget: config.shortSummaryWordTarget,
      keyEventsTarget: config.keyEventsTarget,
      timeoutMs: config.summarizeTimeoutMs
    });

    // 5. Persist Summary + CharacterMemory.
    const sessionPlayersWithChars = await prisma.sessionPlayer.findMany({
      where: { sessionId: session.id, characterId: { not: null } },
      include: { character: { select: { id: true, name: true } } }
    });
    const characterIdByName = new Map<string, string>();
    for (const sp of sessionPlayersWithChars) {
      if (sp.character) characterIdByName.set(sp.character.name, sp.character.id);
    }
    const kindMap: Record<string, 'DEED' | 'QUOTE' | 'RELATIONSHIP' | 'WOUND' | 'QUIRK'> = {
      deed: 'DEED',
      quote: 'QUOTE',
      relationship: 'RELATIONSHIP',
      wound: 'WOUND',
      quirk: 'QUIRK'
    };

    let memorySkipCount = 0;
    await prisma.$transaction(async (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => {
      await tx.summary.deleteMany({ where: { sessionId: session.id } });
      await tx.summary.create({
        data: {
          sessionId: session.id,
          short: summary.short,
          full: summary.full,
          keyEvents: summary.keyEvents as unknown as object
        }
      });
      // Clear prior memories for this session before reinserting (idempotent
      // on retry).
      await tx.characterMemory.deleteMany({ where: { sessionId: session.id } });
      for (const mem of summary.characterMemories) {
        const charId = characterIdByName.get(mem.characterName);
        if (!charId) {
          memorySkipCount += 1;
          continue;
        }
        const kind = kindMap[mem.kind];
        if (!kind) {
          memorySkipCount += 1;
          continue;
        }
        await tx.characterMemory.create({
          data: {
            characterId: charId,
            sessionId: session.id,
            kind,
            content: mem.content,
            importance: mem.importance
          }
        });
      }
      await tx.session.update({
        where: { id: session.id },
        data: { status: 'READY', summarizeError: null }
      });
    });

    log.info(
      {
        sessionId: session.id,
        shortChars: summary.short.length,
        fullChars: summary.full.length,
        keyEvents: summary.keyEvents.length,
        memoriesWritten: summary.characterMemories.length - memorySkipCount,
        memorySkipped: memorySkipCount
      },
      'session summarized and ready'
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err: message, sessionId: session.id },
      'summarize pipeline failed — will retry on next tick'
    );
    await prisma.session.update({
      where: { id: session.id },
      data: {
        summarizeAttempts: { increment: 1 },
        summarizeError: message.slice(0, 1000)
      }
    });
    // If we've now exhausted retries, also DM the admin.
    const updated = await prisma.session.findUnique({
      where: { id: session.id },
      select: { summarizeAttempts: true }
    });
    if (updated && updated.summarizeAttempts >= config.summarizeMaxAttempts) {
      await notifyAdmin(
        log,
        `Session summarization failed ${updated.summarizeAttempts} times.\nSession ID: \`${session.id}\`\nError: ${message.slice(0, 500)}`
      );
    }
    return true;
  }
}

async function markSummarizeFailed(
  sessionId: string,
  reason: string,
  log: FastifyBaseLogger,
  config: WorkerConfig
): Promise<boolean> {
  const prisma = getPrisma();
  log.warn({ sessionId, reason }, 'summarize pre-check failed');
  await prisma.session.update({
    where: { id: sessionId },
    data: { status: 'NEEDS_REVIEW', summarizeError: reason }
  });
  await notifyAdmin(log, `Session ${sessionId} cannot be summarized: ${reason}`);
  void config; // reserved for future config-dependent behavior
  return true;
}
