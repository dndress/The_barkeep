// Singleton Prisma client. One per process — Node will multiplex queries
// over the underlying connection pool. Don't construct PrismaClient() in
// hot paths.
import { PrismaClient } from '@prisma/client';

let _client: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (!_client) {
    _client = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error']
    });
  }
  return _client;
}

/** Used by graceful shutdown to release the pool cleanly. */
export async function disconnectPrisma(): Promise<void> {
  if (_client) {
    await _client.$disconnect();
    _client = undefined;
  }
}
