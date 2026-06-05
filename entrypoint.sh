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

echo "[entrypoint] running seed..."
npx prisma db seed

echo "[entrypoint] starting app..."
exec node dist/index.js
