// Entrypoint. Boot order:
//   1. Load + validate env (fail fast on misconfig).
//   2. Build Fastify app (Fastify owns the logger internally).
//   3. Listen.
//   4. Wire signal handlers so Docker stop is graceful.
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer(config);

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`barkeep listening on ${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // Boot failures should be loud and obvious — write to stderr directly,
  // not via the logger (which may not exist yet on config errors).
  // eslint-disable-next-line no-console
  console.error('fatal boot error:', err);
  process.exit(1);
});
