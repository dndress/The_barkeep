// Fastify app factory. Separating this from index.ts keeps the entrypoint
// trivial and lets us reuse the app in tests later.
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { loggerOptions } from './logger.js';
import { webhookRoutes } from './webhook/route.js';

export async function buildServer(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(config.LOG_LEVEL, config.NODE_ENV === 'development'),
    // Trust the first proxy hop — Dokploy + Traefik fronts our container.
    // This makes req.ip reflect the real client rather than the loopback.
    trustProxy: true,
    // Reject bodies larger than 64KB. The Chronicler payload is ~600 bytes;
    // anything close to this limit is almost certainly malicious or wrong.
    bodyLimit: 64 * 1024
  });

  // Tiny liveness probe for Dokploy / docker healthcheck.
  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(webhookRoutes, {
    webhookSecret: config.BARKEEP_WEBHOOK_SECRET,
    recapDelayHours: config.RECAP_DELAY_HOURS
  });

  return app;
}
