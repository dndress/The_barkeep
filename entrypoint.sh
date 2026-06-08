#!/bin/sh
# Container entrypoint.
#
# Order matters:
#   1. Sync the schema (additive only — db push refuses destructive changes
#      without --accept-data-loss, which we deliberately don't pass).
#   2. Run the idempotent seed so reference data is current.
#   3. Hand off to the app via exec so Node receives SIGTERM directly.
#
# If postgres isn't reachable yet, db push will fail. The container restarts
# (compose: restart: always) and tries again. Crude but works for hobby-scale
# without bringing in wait-for-it or dockerize.
set -eu

echo "[entrypoint] syncing schema (prisma db push)..."
npx prisma db push --skip-generate

# Stage 7: HNSW index on chunks.embedding so /ask is fast even after
# many sessions. Idempotent — pg ignores duplicates with IF NOT EXISTS.
# We use vector_cosine_ops to match the ask-time cosine-distance query.
echo "[entrypoint] ensuring HNSW index on chunks.embedding..."
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    await p.\$executeRawUnsafe(\`CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);\`);
    console.log('hnsw index ok');
  } catch (e) {
    console.warn('hnsw index step failed (continuing):', e.message);
  } finally {
    await p.\$disconnect();
  }
})();
"

echo "[entrypoint] running seed..."
npx prisma db seed

echo "[entrypoint] starting app..."
exec node dist/index.js
