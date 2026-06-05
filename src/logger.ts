// Logger config. We don't construct a pino instance ourselves — Fastify does
// that internally when given these options, which keeps the FastifyInstance
// type clean (no custom logger parameterization leaking through).
import type { LoggerOptions } from 'pino';

export function loggerOptions(level: string, isDev: boolean): LoggerOptions {
  return {
    level,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' }
          }
        }
      : {})
  };
}
