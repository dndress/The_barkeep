// embedSession — for a single session, pull all source content
// (transcripts + summary + character memories + key events), chunk
// everything, embed in batches, write Chunk rows.
//
// pgvector columns aren't natively supported by Prisma — we write the
// embedding via $executeRawUnsafe casting an array literal to ::vector.
//
// Idempotent: clears all existing Chunk rows for the session before
// re-embedding. Used both by the worker's normal ingest pipeline and by
// a future "re-embed this session" admin command.
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db.js';
import {
  chunkLongText,
  chunkRow,
  chunkTranscriptSegments,
  type TextChunk,
  type TranscriptSegmentForChunking
} from './chunker.js';
import { embedBatch } from './embedder.js';

export interface EmbedSessionOptions {
  sessionId: string;
  model: string;
  timeoutMs: number;
}

interface PendingChunk {
  text: string;
  tokenCount: number;
  source: 'TRANSCRIPT' | 'SUMMARY_SHORT' | 'SUMMARY_FULL' | 'KEY_EVENT' | 'CHARACTER_MEMORY';
  chapterId: string | null;
  userId: string | null;
  characterId: string | null;
  tsStartSec: number;
  tsEndSec: number;
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

export async function embedSession(opts: EmbedSessionOptions, log: FastifyBaseLogger): Promise<{
  written: number;
}> {
  const prisma = getPrisma();
  const session = await prisma.session.findUniqueOrThrow({
    where: { id: opts.sessionId },
    include: {
      summary: true,
      chapters: {
        orderBy: { chapterIndex: 'asc' },
        include: {
          audioFiles: {
            include: {
              user: { select: { id: true, displayName: true } },
              transcript: { select: { segments: true, fullText: true } }
            }
          }
        }
      },
      sessionPlayers: {
        include: { character: { select: { id: true, name: true } } }
      },
      memories: {
        include: { character: { select: { id: true, name: true } } }
      }
    }
  });

  // Map userId → character label for this session (DM gets "DM").
  const characterLabelByUser = new Map<string, string>();
  const characterIdByUser = new Map<string, string>();
  for (const sp of session.sessionPlayers) {
    if (sp.role === 'DM') {
      characterLabelByUser.set(sp.userId, 'DM');
    } else if (sp.character) {
      characterLabelByUser.set(sp.userId, sp.character.name);
      characterIdByUser.set(sp.userId, sp.character.id);
    }
  }

  // Map characterName → characterId for memory and key_event chunks.
  const characterIdByName = new Map<string, string>();
  for (const sp of session.sessionPlayers) {
    if (sp.character) characterIdByName.set(sp.character.name, sp.character.id);
  }

  const pending: PendingChunk[] = [];

  // 1. Transcript chunks — per audio file, walking segments.
  for (const chapter of session.chapters) {
    for (const af of chapter.audioFiles) {
      if (!af.transcript) continue;
      const speakerLabel =
        (af.userId && characterLabelByUser.get(af.userId)) ||
        af.user?.displayName ||
        `Speaker ${af.trackIndex}`;
      const rawSegments = af.transcript.segments;
      if (!Array.isArray(rawSegments)) continue;
      const segments: TranscriptSegmentForChunking[] = rawSegments
        .map((s) => {
          const obj = s as { start?: unknown; text?: unknown };
          if (typeof obj?.start !== 'number' || typeof obj?.text !== 'string') return null;
          return { start: obj.start, text: obj.text };
        })
        .filter((s): s is TranscriptSegmentForChunking => s !== null);
      if (segments.length === 0) continue;

      const chunks = chunkTranscriptSegments({ speakerLabel, segments });
      const charId = af.userId ? characterIdByUser.get(af.userId) ?? null : null;
      for (const c of chunks) {
        pending.push({
          text: c.text,
          tokenCount: c.tokenCount,
          source: 'TRANSCRIPT',
          chapterId: chapter.id,
          userId: af.userId,
          characterId: charId,
          tsStartSec: c.tsStartSec,
          tsEndSec: c.tsEndSec
        });
      }
    }
  }

  // 2. Summary chunks (short = always 1, full = potentially many).
  if (session.summary) {
    pending.push({
      text: session.summary.short,
      tokenCount: Math.ceil(session.summary.short.length / 4),
      source: 'SUMMARY_SHORT',
      chapterId: null,
      userId: null,
      characterId: null,
      tsStartSec: 0,
      tsEndSec: 0
    });
    const fullChunks = chunkLongText(session.summary.full);
    for (const c of fullChunks) {
      pending.push({
        text: c.text,
        tokenCount: c.tokenCount,
        source: 'SUMMARY_FULL',
        chapterId: null,
        userId: null,
        characterId: null,
        tsStartSec: 0,
        tsEndSec: 0
      });
    }

    // 3. Key events as individual chunks.
    const keyEvents = Array.isArray(session.summary.keyEvents)
      ? (session.summary.keyEvents as unknown as Array<{ description: string; characters_involved?: string[] }>)
      : [];
    for (const ev of keyEvents) {
      if (!ev?.description) continue;
      const involvedLabel = ev.characters_involved?.length
        ? ` (${ev.characters_involved.join(', ')})`
        : '';
      const chunks = chunkRow(`${ev.description}${involvedLabel}`);
      for (const c of chunks) {
        pending.push({
          text: c.text,
          tokenCount: c.tokenCount,
          source: 'KEY_EVENT',
          chapterId: null,
          userId: null,
          characterId: null,
          tsStartSec: 0,
          tsEndSec: 0
        });
      }
    }
  }

  // 4. Character memories as individual chunks.
  for (const mem of session.memories) {
    const label = mem.character?.name ?? 'character';
    const chunks = chunkRow(`${label}: [${mem.kind.toLowerCase()}] ${mem.content}`);
    for (const c of chunks) {
      pending.push({
        text: c.text,
        tokenCount: c.tokenCount,
        source: 'CHARACTER_MEMORY',
        chapterId: null,
        userId: null,
        characterId: mem.character?.id ?? null,
        tsStartSec: 0,
        tsEndSec: 0
      });
    }
  }

  if (pending.length === 0) {
    log.warn({ sessionId: opts.sessionId }, 'embedSession: no content to embed');
    return { written: 0 };
  }

  // 5. Embed in batches.
  log.info({ sessionId: opts.sessionId, chunkCount: pending.length }, 'embedSession: embedding');
  const vectors = await embedBatch(
    pending.map((p) => p.text),
    { model: opts.model, timeoutMs: opts.timeoutMs }
  );
  if (vectors.length !== pending.length) {
    throw new Error(
      `embedSession: vector count mismatch — pending=${pending.length}, vectors=${vectors.length}`
    );
  }

  // 6. Write Chunk rows. We use raw SQL for the embedding cast.
  await prisma.$executeRawUnsafe(`DELETE FROM chunks WHERE session_id = $1`, opts.sessionId);

  for (let i = 0; i < pending.length; i++) {
    const p = pending[i]!;
    const v = vectors[i]!;
    await prisma.$executeRawUnsafe(
      `INSERT INTO chunks (
         id, session_id, chapter_id, user_id, character_id,
         source, text, token_count, ts_start_sec, ts_end_sec, embedding
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4,
         $5::"ChunkSource", $6, $7, $8, $9, $10::vector
       )`,
      opts.sessionId,
      p.chapterId,
      p.userId,
      p.characterId,
      p.source.toLowerCase(),
      p.text,
      p.tokenCount,
      p.tsStartSec,
      p.tsEndSec,
      vectorLiteral(v)
    );
  }

  log.info(
    { sessionId: opts.sessionId, written: pending.length },
    'embedSession: chunks written'
  );
  return { written: pending.length };
}
