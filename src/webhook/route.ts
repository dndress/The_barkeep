// POST /api/recordings/complete — the one endpoint that exists in Stage 1.
//
// Responsibilities (stage 1 only):
//   1. Verify the shared secret header in constant time.
//   2. Validate payload shape against the Chronicler contract.
//   3. Log the parsed payload at info level.
//   4. Return 202 Accepted.
//
// Anything beyond logging (enqueue job, write to DB, run cook) lands in
// later stages — this file is intentionally tiny so the contract surface is
// obvious.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';

import { ChroniclerWebhookSchema } from './schema.js';

interface WebhookRouteOptions {
  webhookSecret: string;
}

/** Constant-time string compare. Throws on length mismatch — never falsy. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual requires equal-length buffers; pad shorter so we don't
  // leak length via a fast-path early return.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Plugin form keeps the route loosely coupled from server.ts's parameterized
// FastifyInstance type (which differs depending on whether a custom logger
// is supplied at construction time).
export const webhookRoutes: FastifyPluginAsync<WebhookRouteOptions> = async (app, opts) => {
  app.post('/api/recordings/complete', async (req, reply) => {
    const sentSecret = req.headers['x-webhook-secret'];
    if (typeof sentSecret !== 'string' || !safeEqual(sentSecret, opts.webhookSecret)) {
      // 401, not 403 — the secret is the only "auth" we have, so a bad/missing
      // header is an auth failure.
      req.log.warn({ ip: req.ip }, 'webhook rejected: bad or missing X-Webhook-Secret');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = ChroniclerWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues }, 'webhook rejected: payload validation failed');
      return reply.code(400).send({ error: 'invalid payload', issues: parsed.error.issues });
    }

    const p = parsed.data;
    req.log.info(
      {
        recordingId: p.recordingId,
        chapterIndex: p.chapterIndex,
        isFinalChapter: p.isFinalChapter,
        guildId: p.discordGuildId,
        startedAt: p.startedAt,
        endedAt: p.endedAt,
        rawFiles: p.rawFiles
      },
      `chronicler webhook accepted (recording=${p.recordingId} chapter=${p.chapterIndex}${p.isFinalChapter ? ' final' : ''})`
    );

    // Stage 1: we acknowledge and drop. Stage 2 will enqueue a job here.
    return reply.code(202).send({ status: 'accepted' });
  });
};
