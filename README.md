# Barkeep

D&D / Pathfinder session summarizer + RAG bot. Pairs with the Chronicler (a Craig fork) on the same VPS.

This repo contains the Barkeep service only. Chronicler lives in its own repo.

## Stages

**Stage 1 (done):** Fastify server exposing `POST /api/recordings/complete`, secret + payload validation, Postgres 17 + pgvector container, Docker Compose set up for Dokploy alongside Chronicler.

**Stage 2 (done):** Prisma schema covering all eventual tables, idempotent seed of 2 campaigns + 9 users + 16 characters + channel mappings, `prisma db push` on container boot, webhook handler now persists `Session` + `Chapter` rows.

**Stage 3 (done):** Vendored Craig's `cook` (audio splitter) into the image, runtime audio toolchain (ffmpeg, flac, opus-tools, vorbis-tools, zip), a `barkeep_cooked` volume for per-track FLAC output, and a polling pipeline worker that processes new chapters into per-track audio files and writes `AudioFile` rows mapped to known users by Discord ID.

**Not yet:** Gemini transcription/summarization/embedding, voice-intro extractor, Discord bot, recap scheduler.

## Repo layout

```
The_barkeep/
├── prisma/
│   ├── schema.prisma     # full data model (12 tables)
│   └── seed.ts           # idempotent reference-data seed
├── src/
│   ├── index.ts          # entrypoint, starts server + worker, signal handling
│   ├── config.ts         # env loading + validation (zod)
│   ├── logger.ts         # pino logger options factory
│   ├── server.ts         # Fastify app factory
│   ├── db.ts             # PrismaClient singleton
│   ├── pipeline/
│   │   ├── cook.ts       # subprocess wrapper around vendored cook.sh
│   │   ├── users.ts      # parser for .ogg.users sidecar
│   │   └── worker.ts     # polling loop: claim chapter → cook → AudioFile rows
│   └── webhook/
│       ├── schema.ts     # zod schema for Chronicler payload (v2)
│       └── route.ts      # POST /api/recordings/complete handler
├── vendor/               # bundled cook from Craig; see vendor/README.md
│   ├── cook.sh
│   ├── buildCook.sh
│   └── cook/             # .c sources compiled at docker build, plus .js helpers
├── Dockerfile            # multi-stage; prisma generate + tsc + cook compile → runtime
├── docker-compose.yml    # barkeep-db + barkeep, shared craig_rec, barkeep_cooked
├── entrypoint.sh         # prisma db push → seed → exec node
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Schema sync philosophy

We use `prisma db push` (not tracked migrations) on every container boot. It's idempotent and additive-only by default — refuses destructive changes without `--accept-data-loss`, which we deliberately don't pass. For a single-developer hobby project this is the right trade: zero migration bookkeeping, schema always matches `schema.prisma`. If we ever need rollback or multi-env divergence we can add `prisma migrate` later.

The seed runs after every push (also idempotent — upserts on Discord IDs and (campaign, character-name) composites). New campaigns and characters are added by editing `prisma/seed.ts` and redeploying.

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

Expected: `HTTP/1.1 202 Accepted` with `{"status":"accepted","sessionId":"…","chapterId":"…"}` and a `chronicler webhook persisted` log line.

Sanity checks worth running:

- Bad secret → `401 unauthorized`
- Missing field (e.g. drop `endedAt`) → `400 invalid payload` with zod issues
- Body over 64KB → Fastify rejects before our handler runs

## Stage 2 verification checklist

After deploying Stage 2, run these against the VPS host (Hostinger SSH shell):

```bash
# 1. Confirm seed ran — should print 2 campaigns / 9 users / 16 characters
docker exec -it $(docker ps -qf name=barkeep-db) \
  psql -U barkeep -d barkeep -c \
  "SELECT (SELECT count(*) FROM campaigns) AS campaigns,
          (SELECT count(*) FROM users) AS users,
          (SELECT count(*) FROM characters) AS characters;"

# 2. Fire two webhooks for the same recording — chapter 0 (non-final) then chapter 1 (final)
SECRET="<your secret>"

curl -s -X POST http://localhost:3001/api/recordings/complete \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{"recordingId":"verify-002","chapterIndex":0,"isFinalChapter":false,"discordGuildId":"698633790972493855","discordChannelId":"1234567890","startedAt":"2026-06-04T19:00:00Z","endedAt":"2026-06-04T20:00:00Z","rawFiles":{"data":"a","header1":"b","header2":"c","users":"d","info":"e"}}'
echo

curl -s -X POST http://localhost:3001/api/recordings/complete \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{"recordingId":"verify-002","chapterIndex":1,"isFinalChapter":true,"discordGuildId":"698633790972493855","discordChannelId":"1234567890","startedAt":"2026-06-04T20:00:00Z","endedAt":"2026-06-04T23:00:00Z","rawFiles":{"data":"a","header1":"b","header2":"c","users":"d","info":"e"}}'
echo

# 3. Confirm one session + two chapters landed, and final ended_at is set
docker exec -it $(docker ps -qf name=barkeep-db) \
  psql -U barkeep -d barkeep -c \
  "SELECT s.recording_id, s.status, s.ended_at, s.recap_scheduled_for,
          (SELECT count(*) FROM chapters c WHERE c.session_id = s.id) AS chapter_count
   FROM sessions s WHERE s.recording_id = 'verify-002';"
# Expect: chapter_count=2, ended_at set, recap_scheduled_for = ended_at + 10h

# 4. Idempotency check — replay chapter 1, expect still 2 chapters total
curl -s -X POST http://localhost:3001/api/recordings/complete \
  -H "Content-Type: application/json" -H "X-Webhook-Secret: $SECRET" \
  -d '{"recordingId":"verify-002","chapterIndex":1,"isFinalChapter":true,"discordGuildId":"698633790972493855","discordChannelId":"1234567890","startedAt":"2026-06-04T20:00:00Z","endedAt":"2026-06-04T23:00:00Z","rawFiles":{"data":"a","header1":"b","header2":"c","users":"d","info":"e"}}'
docker exec -it $(docker ps -qf name=barkeep-db) \
  psql -U barkeep -d barkeep -c \
  "SELECT count(*) FROM chapters WHERE session_id IN (SELECT id FROM sessions WHERE recording_id = 'verify-002');"
# Expect: 2
```

All four should pass on a clean deploy. If `campaigns` returns 0, the seed didn't run — check Barkeep container boot logs for `[entrypoint] running seed...`.

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

## Stage 3 verification checklist

After deploying Stage 3, run these against the VPS:

```bash
# 1. Confirm cook tools are present in the Barkeep image
sudo docker exec $(sudo docker ps -qf name=barkeep | head -1) sh -c \
  'which ffmpeg flac opusenc oggenc zip unzip && ls /app/vendor/cook/oggtracks /app/vendor/cook.sh'
# Expect: paths printed, no errors

# 2. Confirm the cook binaries got compiled at build time
sudo docker exec $(sudo docker ps -qf name=barkeep | head -1) sh -c \
  'ls -la /app/vendor/cook/ | grep -E "oggtracks|oggcorrect|oggduration|wavduration" | grep -v "\.c$"'
# Expect: 4 executable binaries (no .c suffix)

# 3. Confirm the worker is running and polling
sudo docker logs $(sudo docker ps -qf name=barkeep | head -1) 2>&1 | grep "pipeline worker"
# Expect: "pipeline worker started"

# 4. Real chapter test (needs an actual Chronicler recording)
#    Start a Discord recording, stop it. Wait up to (poll interval + cook time)
#    — typically 30s to a few minutes depending on chapter length.
sudo docker exec -it $(sudo docker ps -qf name=barkeep-db) \
  psql -U barkeep -d barkeep -c \
  "SELECT s.recording_id, s.status,
          (SELECT count(*) FROM chapters c WHERE c.session_id = s.id) AS chapters,
          (SELECT count(*) FROM audio_files af
             JOIN chapters c ON c.id = af.chapter_id
             WHERE c.session_id = s.id) AS audio_files
   FROM sessions s
   ORDER BY s.created_at DESC LIMIT 5;"
# Expect: latest session has audio_files = (chapters * track_count_per_chapter)

# 5. Spot-check a cooked file on disk
sudo docker exec $(sudo docker ps -qf name=barkeep | head -1) sh -c \
  'find /app/data/cooked -name "*.flac" -printf "%p (%s bytes)\n" | head -10'
# Expect: per-track FLAC files; non-zero sizes
```

If a chapter fails to cook, the worker logs an error, marks the session FAILED, and sets `processedAt` so it stops retrying. To retry after fixing the issue:

```sql
UPDATE chapters SET processed_at = NULL WHERE id = '<chapter-uuid>';
UPDATE sessions SET status = 'RECEIVING' WHERE id = '<session-uuid>';
```

The worker picks it back up on the next 30-second tick.

## Worker behavior

- **Polls** every `WORKER_POLL_INTERVAL_MS` (default 30s).
- **Drains** up to 10 chapters per tick if multiple are queued; goes back to sleep when caught up.
- **Single-worker semantics** — there's only one process. If we ever scale out, switch to `SELECT ... FOR UPDATE SKIP LOCKED` in the claim query.
- **Failure handling** — cook failures mark the chapter `processedAt = now()` (stops retry thrash) and the session `status = FAILED`. The cook stderr tail is logged. Operators re-null `processedAt` to retry.
- **No transcription yet** — Stage 3 leaves the session in `status: COOKING` (or `FAILED`). Stage 4 will transition it through `TRANSCRIBING → SUMMARIZING → READY → POSTED`.

## Next stage

Stage 4: Gemini transcription. The worker grows a second step: after cooking, upload each `AudioFile` to the Gemini File API, transcribe with `gemini-2.5-flash`, write `Transcript` rows, and advance the session to `TRANSCRIBING → READY`.
