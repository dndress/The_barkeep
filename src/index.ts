// Entrypoint. Boot order:
//   1. Load + validate env (fail fast on misconfig).
//   2. Build Fastify app (Fastify owns the logger internally).
//   3. Listen.
//   4. Start the pipeline worker.
//   5. Wire signal handlers so Docker stop is graceful (release DB pool too).
import { loadConfig } from './config.js';
import { disconnectPrisma } from './db.js';
import { startWorker } from './pipeline/worker.js';
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

  const worker = startWorker(
    {
      cookScriptDir: config.COOK_SCRIPT_DIR,
      cookedBaseDir: config.COOKED_PATH,
      pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
      cookTimeoutMs: config.COOK_TIMEOUT_MS
    },
    app.log
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      // Stop accepting new work first so in-flight cooks can finish.
      await worker.stop();
      await app.close();
      await disconnectPrisma();
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
