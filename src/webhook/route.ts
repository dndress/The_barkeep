// POST /api/recordings/complete — Stage 2.
//
// Responsibilities:
//   1. Verify the shared secret header in constant time.
//   2. Validate payload shape against the Chronicler contract.
//   3. Upsert a Session row (keyed on Chronicler's recordingId).
//   4. Insert/upsert a Chapter row for this chapter index.
//   5. On the final chapter, set sessions.ended_at + recap_scheduled_for.
//   6. Return 202 Accepted.
//
// Idempotency: Chronicler might retry a webhook. Session is upserted by
// recording_id (unique); Chapter is upserted by (session_id, chapter_index)
// (unique). Replay of the same payload is a no-op apart from updated_at.
//
// Campaign resolution is NOT done here — the voice channel is shared across
// campaigns, so campaign_id stays NULL until the voice-intro extractor
// (later stage) fills it in.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';

import { getPrisma } from '../db.js';
import { ChroniclerWebhookSchema, type ChroniclerWebhookPayload } from './schema.js';

interface WebhookRouteOptions {
  webhookSecret: string;
}

/** 10-hour recap delay, per design decision. Configurable later. */
const RECAP_DELAY_MS = 10 * 60 * 60 * 1000;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function persistChapter(p: ChroniclerWebhookPayload): Promise<{
  sessionId: string;
  chapterId: string;
  isFirstChapter: boolean;
}> {
  const prisma = getPrisma();
  const startedAt = new Date(p.startedAt);
  const endedAt = new Date(p.endedAt);

  // Upsert session by recordingId. On create, we use this chapter's
  // startedAt as the session start (will be correct since chapter 0 fires
  // first). On any chapter, we leave campaignId/dmUserId NULL for the
  // detection step to fill in later.
  const session = await prisma.session.upsert({
    where: { recordingId: p.recordingId },
    create: {
      recordingId: p.recordingId,
      discordGuildId: p.discordGuildId,
      discordVoiceChannelId: p.discordChannelId,
      startedAt,
      status: 'RECEIVING'
    },
    update: {
      discordGuildId: p.discordGuildId,
      discordVoiceChannelId: p.discordChannelId
    }
  });

  const isFirstChapter = session.startedAt.getTime() === startedAt.getTime();

  const chapter = await prisma.chapter.upsert({
    where: {
      sessionId_chapterIndex: { sessionId: session.id, chapterIndex: p.chapterIndex }
    },
    create: {
      sessionId: session.id,
      chapterIndex: p.chapterIndex,
      isFinal: p.isFinalChapter,
      startedAt,
      endedAt,
      rawDataPath: p.rawFiles.data,
      rawHeader1Path: p.rawFiles.header1,
      rawHeader2Path: p.rawFiles.header2,
      rawUsersPath: p.rawFiles.users,
      rawInfoPath: p.rawFiles.info
    },
    update: {
      isFinal: p.isFinalChapter,
      endedAt,
      rawDataPath: p.rawFiles.data,
      rawHeader1Path: p.rawFiles.header1,
      rawHeader2Path: p.rawFiles.header2,
      rawUsersPath: p.rawFiles.users,
      rawInfoPath: p.rawFiles.info
    }
  });

  if (p.isFinalChapter) {
    await prisma.session.update({
      where: { id: session.id },
      data: {
        endedAt,
        recapScheduledFor: new Date(endedAt.getTime() + RECAP_DELAY_MS)
      }
    });
  }

  return { sessionId: session.id, chapterId: chapter.id, isFirstChapter };
}

export const webhookRoutes: FastifyPluginAsync<WebhookRouteOptions> = async (app, opts) => {
  app.post('/api/recordings/complete', async (req, reply) => {
    const sentSecret = req.headers['x-webhook-secret'];
    if (typeof sentSecret !== 'string' || !safeEqual(sentSecret, opts.webhookSecret)) {
      req.log.warn({ ip: req.ip }, 'webhook rejected: bad or missing X-Webhook-Secret');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = ChroniclerWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues }, 'webhook rejected: payload validation failed');
      return reply.code(400).send({ error: 'invalid payload', issues: parsed.error.issues });
    }
    const p = parsed.data;

    try {
      const result = await persistChapter(p);
      req.log.info(
        {
          recordingId: p.recordingId,
          sessionId: result.sessionId,
          chapterId: result.chapterId,
          chapterIndex: p.chapterIndex,
          isFinalChapter: p.isFinalChapter,
          isFirstChapter: result.isFirstChapter
        },
        `chronicler webhook persisted (recording=${p.recordingId} chapter=${p.chapterIndex}${p.isFinalChapter ? ' final' : ''})`
      );
      return reply.code(202).send({
        status: 'accepted',
        sessionId: result.sessionId,
        chapterId: result.chapterId
      });
    } catch (err) {
      req.log.error({ err, recordingId: p.recordingId, chapterIndex: p.chapterIndex }, 'failed to persist chapter');
      return reply.code(500).send({ error: 'persistence failed' });
    }
  });
};
