// Centralized env loading + validation. Fail fast at boot if anything
// required is missing so we never have a half-configured server happily
// returning 202 on requests it can't actually process later.
import { z } from 'zod';

const Env = z.object({
  // Webhook
  BARKEEP_WEBHOOK_SECRET: z.string().min(8, 'BARKEEP_WEBHOOK_SECRET must be at least 8 chars'),

  // Server
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Required as of stage 2 — Prisma client needs it. Format:
  // postgresql://user:pass@host:5432/dbname?schema=public
  DATABASE_URL: z.string().url(),

  // Filesystem paths
  CHRONICLER_REC_PATH: z.string().default('/app/rec'),
  COOKED_PATH: z.string().default('/app/data/cooked'),
  // Where vendored cook.sh lives; runtime Dockerfile puts it here.
  COOK_SCRIPT_DIR: z.string().default('/app/vendor'),

  // Pipeline worker tuning
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  COOK_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),

  // Stage 4 — Gemini transcription
  GEMINI_API_KEY: z.string().min(1).optional(),
  TRANSCRIBE_MODEL: z.string().default('gemini-2.5-flash'),
  TRANSCRIBE_LANGUAGE_HINT: z.string().default('es'),
  TRANSCRIBE_CONCURRENCY: z.coerce.number().int().positive().default(2),
  TRANSCRIBE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  TRANSCRIBE_TIMEOUT_MS: z.coerce.number().int().positive().default(20 * 60 * 1000),

  // Stage 5 — intro extraction, summarization, character memories
  SUMMARIZE_MODEL: z.string().default('gemini-2.5-flash'),
  SUMMARIZE_LANGUAGE_HINT: z.string().default('es'),
  SUMMARIZE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  SUMMARIZE_TIMEOUT_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  INTRO_EXTRACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(2 * 60 * 1000),
  SHORT_SUMMARY_WORD_TARGET: z.coerce.number().int().positive().default(350),
  KEY_EVENTS_TARGET: z.coerce.number().int().positive().default(8),

  // Stage 5 — Discord DM notifications to admin
  BARKEEP_DISCORD_BOT_TOKEN: z.string().min(1).optional(),
  ADMIN_DISCORD_USER_ID: z.string().min(1).optional(),

  // Stage 6 — full Discord bot
  DISCORD_GUILD_ID: z.string().min(1).optional(),
  RECAP_DELAY_HOURS: z.coerce.number().int().nonnegative().default(10),
  RECAP_POST_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),

  // Stage 6.5 — external Whisper via Google Drive
  GOOGLE_API_KEY: z.string().min(1).optional(),
  WHISPER_FALLBACK_DAYS: z.coerce.number().int().positive().default(10),
  WHISPER_STOP_DAYS: z.coerce.number().int().positive().default(14),

  // Stage 7.5 — Drive write access (service account JSON content)
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),

  // Stage 7 — embeddings + /ask
  EMBED_MODEL: z.string().default('gemini-embedding-001'),
  EMBED_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  EMBED_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  ASK_MODEL: z.string().default('gemini-2.5-flash'),
  ASK_TOP_K: z.coerce.number().int().positive().default(10),
  ASK_TIMEOUT_MS: z.coerce.number().int().positive().default(60 * 1000),

  // Stage 9 — session art. One image per session, generated after the
  // summary lands. Posted alongside the recap. Idempotent: if an ArtPiece
  // exists for the session, gen is skipped so retries don't double-charge.
  // Migrated 2026-06-13 from imagen-3.0-generate-002 (deprecated; shut down
  // 2026-06-24) to gemini-3.1-flash-image (Nano Banana 2, ~$0.067/image,
  // 32K-token prompt window vs Imagen's ~480 — eliminates silent truncation).
  SESSION_ART_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
  SESSION_ART_MODEL: z.string().default('gemini-3.1-flash-image'),
  SESSION_ART_DIR: z.string().default('/app/data/session_art'),
  SESSION_ART_TIMEOUT_MS: z.coerce.number().int().positive().default(60 * 1000),

  // Stage 9 — /brief admin command. Per-character pre-session DMs from
  // Rikk. Uses gemini-2.5-flash by default; ~$0.001 per character per call,
  // so a 5-player /brief costs roughly half a cent.
  BRIEF_MODEL: z.string().default('gemini-2.5-flash'),
  BRIEF_LANGUAGE_HINT: z.string().default('es'),
  BRIEF_TIMEOUT_MS: z.coerce.number().int().positive().default(60 * 1000),
  // How many of the most recent sessions to include as dossier context.
  BRIEF_RECENT_SESSIONS: z.coerce.number().int().positive().default(3),
  // How many of the character's standing memories to surface per brief.
  BRIEF_MEMORIES_PER_CHARACTER: z.coerce.number().int().positive().default(10),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('production')
});

export type AppConfig = z.infer<typeof Env>;

export function loadConfig(): AppConfig {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    // Format errors compactly so they fit in the boot log.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
