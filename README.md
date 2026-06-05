# Barkeep

D&D / Pathfinder session summarizer + RAG bot. Pairs with the Chronicler (a Craig fork) on the same VPS.

This repo contains the Barkeep service only. Chronicler lives in its own repo.

## Stage 1 — what works today

- Fastify server exposing `POST /api/recordings/complete`
- Validates `X-Webhook-Secret` against `BARKEEP_WEBHOOK_SECRET`
- Validates payload shape against the Chronicler handoff contract (v2)
- Logs accepted payloads, returns `202 Accepted`
- Postgres 17 + pgvector container running (empty — schema lands in Stage 2)
- Docker Compose set up for Dokploy alongside Chronicler

Not implemented yet: Prisma schema, job queue, cook runner, Gemini transcription/summarization/embedding, Discord bot, recap scheduler.

## Repo layout

```
barkeep/
├── src/
│   ├── index.ts         # entrypoint
│   ├── config.ts        # env loading + validation (zod)
│   ├── logger.ts        # pino logger factory
│   ├── server.ts        # Fastify app factory
│   └── webhook/
│       ├── schema.ts    # zod schema for Chronicler payload (v2)
│       └── route.ts     # POST /api/recordings/complete handler
├── Dockerfile           # multi-stage build (deps → tsc → runtime)
├── docker-compose.yml   # db + barkeep, with shared craig_rec volume
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Run locally

```bash
cp .env.example .env
# edit .env and set BARKEEP_WEBHOOK_SECRET to a real value
docker compose up --build
```

The `craig_rec` volume mount is read-only and will be empty when running locally without Chronicler — that's fine for Stage 1, we don't read any files yet.

Health check: `curl http://localhost:3001/health` → `{"status":"ok"}`.

## Simulate a Chronicler webhook

Use this curl command to confirm the contract is working. Replace the secret with whatever you put in `.env`.

```bash
curl -i -X POST http://localhost:3001/api/recordings/complete \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: change-me-to-a-long-random-string" \
  -d '{
    "recordingId": "test-rec-001",
    "chapterIndex": 0,
    "isFinalChapter": true,
    "discordGuildId": "111111111111111111",
    "discordChannelId": "222222222222222222",
    "startedAt": "2026-06-04T19:00:00Z",
    "endedAt":   "2026-06-04T23:14:00Z",
    "rawFiles": {
      "data":    "/app/rec/test-rec-001.ogg.data",
      "header1": "/app/rec/test-rec-001.ogg.header1",
      "header2": "/app/rec/test-rec-001.ogg.header2",
      "users":   "/app/rec/test-rec-001.ogg.users",
      "info":    "/app/rec/test-rec-001.ogg.info"
    }
  }'
```

Expected: `HTTP/1.1 202 Accepted` with `{"status":"accepted"}` and a `chronicler webhook accepted` log line in the container output.

Sanity checks worth running:

- Bad secret → `401 unauthorized`
- Missing field (e.g. drop `endedAt`) → `400 invalid payload` with zod issues
- Body over 64KB → Fastify rejects before our handler runs

## Deploy via Dokploy alongside Chronicler

Two values you'll need to set in Dokploy's env for the Barkeep stack so it lines up with Chronicler:

| Variable | What | Example |
|---|---|---|
| `CRAIG_REC_VOLUME` | Real name of Chronicler's `craig_rec` volume in Docker (Dokploy prefixes stack names) | `chronicler-abc123_craig_rec` |
| `CHRONICLER_NETWORK` | Network name Chronicler's services attach to, so the `barkeep` container DNS-resolves on the same network | `chronicler-abc123_default` |
| `CHRONICLER_NETWORK_EXTERNAL` | Set to `true` when joining an existing Chronicler network | `true` |

Find both names with `docker volume ls` and `docker network ls` on the VPS after Chronicler is deployed.

Also set in Dokploy env for Chronicler (already documented in `CHRONICLER_HANDOFF.md`):

```
BARKEEP_WEBHOOK_URL=http://barkeep:3001/api/recordings/complete
BARKEEP_WEBHOOK_SECRET=<same value as the Barkeep stack's .env>
```

## Next stage

Stage 2: Prisma schema + initial migration covering campaigns, users, characters, sessions, chapters, and a seed script that loads the campaigns + players from `Discord_Players_Data.txt`. Webhook handler will start persisting chapter rows.
