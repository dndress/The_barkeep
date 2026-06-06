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
import { cookChapter, recordingBasename } from './cook.js';
import { transcribeAudioFile } from './transcribe.js';
import { parseOggUsers } from './users.js';

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

        // 3. Advance any sessions that finished while we were working
        if (!stopped) await advanceCompletedSessions(log);
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

  log.info(
    { chapterId: chapter.id, sessionId: chapter.sessionId, chapterIndex: chapter.chapterIndex, recordingId },
    'cooking chapter'
  );

  await prisma.session.update({
    where: { id: chapter.sessionId },
    data: { status: 'COOKING' }
  });

  try {
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

    let unknownUserCount = 0;
    for (const file of result.files) {
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
  // Only consider AudioFiles whose chapter is already cooked (processedAt
  // set). transcribeAttempts caps retries; we filter at the DB level.
  // Also exclude files we already touched this tick so failures back off
  // to one attempt per 30s tick instead of burning the retry budget.
  const batch: TranscribeJob[] = await prisma.audioFile.findMany({
    where: {
      transcript: null,
      transcribeAttempts: { lt: config.transcribeMaxAttempts },
      chapter: { processedAt: { not: null } },
      ...(triedThisTick.size > 0 ? { id: { notIn: Array.from(triedThisTick) } } : {})
    },
    orderBy: { cookedAt: 'asc' },
    take: config.transcribeConcurrency,
    select: {
      id: true,
      cookedPath: true,
      chapter: { select: { sessionId: true } }
    }
  });
  if (batch.length === 0) return false;
  for (const af of batch) triedThisTick.add(af.id);

  // Bump status to TRANSCRIBING for any session whose AudioFile we're about
  // to touch — but only if still in COOKING (don't downgrade from READY/FAILED).
  const sessionIds = Array.from(new Set(batch.map((af: TranscribeJob) => af.chapter.sessionId)));
  await prisma.session.updateMany({
    where: { id: { in: sessionIds }, status: 'COOKING' },
    data: { status: 'TRANSCRIBING' }
  });

  await Promise.all(
    batch.map((af: TranscribeJob) => transcribeOne(af.id, af.cookedPath, config, log))
  );
  return true;
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
 * Move any TRANSCRIBING session to READY once:
 *   - session.endedAt is set (final chapter received), AND
 *   - every chapter has processedAt set, AND
 *   - every AudioFile has a Transcript.
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
    // A single negation query is cheap: "is there any chapter or AudioFile
    // not yet done?". If there's none, the session is ready.
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
      data: { status: 'READY' }
    });
    log.info({ sessionId: id }, 'session ready');
  }
}
