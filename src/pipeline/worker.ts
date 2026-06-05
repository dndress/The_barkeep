// Background pipeline worker for Stage 3.
//
// Job: pop chapters where `processedAt IS NULL`, cook them into per-track
// FLAC files, write AudioFile rows, mark the chapter processed. Polls on
// a fixed interval (default 30s). One worker per process — fine for the
// weekly-session cadence; if we ever need parallelism we'll add a queue.
//
// Failure handling: if cook fails we still mark `processedAt` so the worker
// stops thrashing on the same chapter. The session moves to status FAILED
// and the chapter is logged with `cookExitCode + cookStderr` for diagnosis.
// To retry: `UPDATE chapters SET processed_at = NULL WHERE id = ...` then
// poke the worker (next tick is automatic).
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db.js';
import { cookChapter, recordingBasename } from './cook.js';
import { parseOggUsers } from './users.js';

interface WorkerConfig {
  cookScriptDir: string;
  cookedBaseDir: string;
  pollIntervalMs: number;
  cookTimeoutMs: number;
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
        // Drain everything available before going back to sleep — keeps
        // throughput reasonable when several chapters arrive in a burst.
        // Cap at 10 per tick to avoid starving the event loop.
        for (let i = 0; i < 10; i++) {
          const processed = await processOneChapter(config, log);
          if (!processed) break;
          if (stopped) return;
        }
      } catch (err) {
        log.error({ err }, 'pipeline worker tick failed');
      } finally {
        scheduleNext();
      }
    })();
    await currentTick;
  };

  // Kick off first tick immediately — picks up anything queued before boot.
  void tick();
  log.info({ pollIntervalMs: config.pollIntervalMs }, 'pipeline worker started');

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Wait for an in-flight tick to settle so we don't half-finish a cook.
      if (currentTick) {
        try { await currentTick; } catch { /* logged inside */ }
      }
      log.info('pipeline worker stopped');
    }
  };
}

/**
 * Process one chapter. Returns true if a chapter was processed (caller can
 * loop to drain more), false if the queue is empty.
 */
async function processOneChapter(config: WorkerConfig, log: FastifyBaseLogger): Promise<boolean> {
  const prisma = getPrisma();

  // Pick the oldest unprocessed chapter. We're single-worker so no need
  // for SKIP LOCKED. If we ever scale out, switch to a $queryRaw with
  // SELECT ... FOR UPDATE SKIP LOCKED.
  const chapter = await prisma.chapter.findFirst({
    where: { processedAt: null },
    orderBy: { receivedAt: 'asc' },
    include: { session: true }
  });
  if (!chapter) return false;

  const recordingId = recordingBasename(chapter.rawDataPath);
  const outputDir = path.join(config.cookedBaseDir, chapter.sessionId, String(chapter.chapterIndex));

  log.info(
    {
      chapterId: chapter.id,
      sessionId: chapter.sessionId,
      chapterIndex: chapter.chapterIndex,
      recordingId
    },
    'cooking chapter'
  );

  // Move the session into COOKING so observers see progress. Don't move it
  // out at the end — Stage 4 (transcription) will advance from COOKING.
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

    // Map track index -> user (Discord id + display info).
    const users = await parseOggUsers(chapter.rawUsersPath);
    const userByTrack = new Map(users.map((u) => [u.trackIndex, u]));

    // Resolve Discord IDs to internal User row IDs in one query.
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

    // Upsert one AudioFile row per cooked track. Unknown user_id → null
    // (worker logs a warning so it surfaces).
    let unknownUserCount = 0;
    for (const file of result.files) {
      const u = userByTrack.get(file.trackIndex);
      const userId = u?.discordUserId ? internalIdByDiscord.get(u.discordUserId) : undefined;
      if (!userId) unknownUserCount += 1;

      await prisma.audioFile.upsert({
        where: {
          chapterId_trackIndex: {
            chapterId: chapter.id,
            trackIndex: file.trackIndex
          }
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
      {
        chapterId: chapter.id,
        sessionId: chapter.sessionId,
        trackCount: result.files.length,
        outputDir
      },
      'chapter cooked'
    );
    return true;
  } catch (err) {
    log.error(
      { err, chapterId: chapter.id, sessionId: chapter.sessionId, recordingId },
      'cook failed; marking chapter processed and session failed (re-null processed_at to retry)'
    );
    // Mark processed_at to stop thrash. Operator nulls it to retry.
    await prisma.chapter.update({
      where: { id: chapter.id },
      data: { processedAt: new Date() }
    });
    await prisma.session.update({
      where: { id: chapter.sessionId },
      data: { status: 'FAILED' }
    });
    return true; // still "processed" something — keep draining
  }
}
