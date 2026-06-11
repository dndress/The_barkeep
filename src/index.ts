// Entrypoint. Boot order:
//   1. Load + validate env (fail fast on misconfig).
//   2. Build Fastify app (Fastify owns the logger internally).
//   3. Listen on HTTP.
//   4. Start Discord client + register slash commands (Stage 6).
//   5. Start pipeline worker (after Discord so notifyAdmin works).
//   6. Wire signal handlers so Docker stop is graceful.
import { loadConfig } from './config.js';
import { disconnectPrisma } from './db.js';
import { startDiscordClient, destroyDiscordClient } from './discord/client.js';
import { registerSlashCommands } from './discord/commands/register.js';
import { wireInteractionHandler } from './discord/handlers/interactions.js';
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

  // Bring up Discord BEFORE the worker so notifyAdmin works on first tick
  // and slash commands are registered.
  const discordStarted = config.BARKEEP_DISCORD_BOT_TOKEN
    ? startDiscordClient({ token: config.BARKEEP_DISCORD_BOT_TOKEN, log: app.log })
        .then(async (client) => {
          wireInteractionHandler(client, app.log, {
            googleApiKey: config.GOOGLE_API_KEY,
            embedModel: config.EMBED_MODEL,
            askModel: config.ASK_MODEL,
            askTopK: config.ASK_TOP_K,
            embedTimeoutMs: config.EMBED_TIMEOUT_MS,
            askTimeoutMs: config.ASK_TIMEOUT_MS,
            briefModel: config.BRIEF_MODEL,
            briefLanguageHint: config.BRIEF_LANGUAGE_HINT,
            briefTimeoutMs: config.BRIEF_TIMEOUT_MS,
            briefRecentSessions: config.BRIEF_RECENT_SESSIONS,
            briefMemoriesPerCharacter: config.BRIEF_MEMORIES_PER_CHARACTER
          });
          if (config.DISCORD_GUILD_ID) {
            try {
              await registerSlashCommands(client, config.DISCORD_GUILD_ID, app.log);
            } catch (err) {
              app.log.error({ err }, 'slash command registration failed');
            }
          } else {
            app.log.warn(
              'DISCORD_GUILD_ID unset — skipping slash command registration; commands will not appear'
            );
          }
          return client;
        })
        .catch((err) => {
          app.log.error({ err }, 'discord client failed to start — bot features will be degraded');
        })
    : Promise.resolve(undefined);

  if (config.BARKEEP_DISCORD_BOT_TOKEN) {
    // We don't block the HTTP listener on Discord; the worker will gracefully
    // skip notifyAdmin until ready (isDiscordReady gates it).
    void discordStarted;
  } else {
    app.log.warn('BARKEEP_DISCORD_BOT_TOKEN unset — Discord features disabled');
  }

  const worker = startWorker(
    {
      cookScriptDir: config.COOK_SCRIPT_DIR,
      cookedBaseDir: config.COOKED_PATH,
      pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
      cookTimeoutMs: config.COOK_TIMEOUT_MS,
      transcribeModel: config.TRANSCRIBE_MODEL,
      transcribeLanguageHint: config.TRANSCRIBE_LANGUAGE_HINT,
      transcribeConcurrency: config.TRANSCRIBE_CONCURRENCY,
      transcribeMaxAttempts: config.TRANSCRIBE_MAX_ATTEMPTS,
      transcribeTimeoutMs: config.TRANSCRIBE_TIMEOUT_MS,
      summarizeModel: config.SUMMARIZE_MODEL,
      summarizeLanguageHint: config.SUMMARIZE_LANGUAGE_HINT,
      summarizeMaxAttempts: config.SUMMARIZE_MAX_ATTEMPTS,
      summarizeTimeoutMs: config.SUMMARIZE_TIMEOUT_MS,
      shortSummaryWordTarget: config.SHORT_SUMMARY_WORD_TARGET,
      keyEventsTarget: config.KEY_EVENTS_TARGET,
      introExtractionTimeoutMs: config.INTRO_EXTRACTION_TIMEOUT_MS,
      recapPostMaxAttempts: config.RECAP_POST_MAX_ATTEMPTS,
      googleApiKey: config.GOOGLE_API_KEY,
      whisperFallbackDays: config.WHISPER_FALLBACK_DAYS,
      whisperStopDays: config.WHISPER_STOP_DAYS,
      embedModel: config.EMBED_MODEL,
      embedMaxAttempts: config.EMBED_MAX_ATTEMPTS,
      embedTimeoutMs: config.EMBED_TIMEOUT_MS,
      sessionArtEnabled: config.SESSION_ART_ENABLED,
      sessionArtModel: config.SESSION_ART_MODEL,
      sessionArtDir: config.SESSION_ART_DIR,
      sessionArtTimeoutMs: config.SESSION_ART_TIMEOUT_MS
    },
    app.log
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      await worker.stop();
      await app.close();
      await destroyDiscordClient();
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
