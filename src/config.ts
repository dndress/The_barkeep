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
