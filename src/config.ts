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

  // Optional in stage 1; we'll require it in stage 2 when Prisma comes in.
  DATABASE_URL: z.string().url().optional(),

  // Optional; read by later stages when we cook raw artifacts.
  CHRONICLER_REC_PATH: z.string().default('/app/rec'),

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
