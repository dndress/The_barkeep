# Multi-stage. Build stage runs prisma generate + tsc + compiles vendored
# cook binaries; runtime stage carries the smaller prod-only node_modules
# plus the cook binaries and audio tooling.
#
# Notes:
#   - openssl is required at runtime by Prisma's query engine.
#   - We keep `prisma` and `tsx` as prod deps (not devDeps) so the runtime
#     image can run `prisma db push`, `prisma db seed`, and execute the
#     TS seed file directly without a separate compile step for it.
#   - Cook tooling: ffmpeg, flac, opus-tools, vorbis-tools, zip/unzip, plus
#     util-linux for flock + procps for process tools. node is already
#     present (we're on node:20 base) for chapinfo.js/userinfo.js helpers.
FROM node:20-bookworm-slim AS build
WORKDIR /app
# openssl + ca-certificates so prisma generate can fetch the right engine;
# gcc/make to compile the vendored cook binaries
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
COPY vendor ./vendor
RUN npx prisma generate
RUN npx tsc -p .
# Compile cook helpers. Inline equivalent of Craig's buildCook.sh, minus the
# SVG-to-PNG inkscape step we don't need. buildCook.sh assumes Craig's
# directory layout (scripts/ + cook/ siblings); since we put cook.sh and
# cook/ both inside vendor/, doing the gcc loop directly is simpler and
# avoids the bad cd path.
RUN chmod +x vendor/cook.sh && \
    cd vendor/cook && \
    for i in *.c; do gcc -O3 -o "${i%.c}" "$i" || exit 1; done && \
    ls -la /app/vendor/cook/ | head -30

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# openssl for Prisma; audio tooling for cook.sh; util-linux gives us flock,
# procps gives us things like ps the cook scripts occasionally need.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
      ffmpeg flac opus-tools vorbis-tools zip unzip \
      util-linux procps \
    && rm -rf /var/lib/apt/lists/*

# Production deps only (still includes prisma + tsx — see header note)
COPY package.json ./
RUN npm install --omit=dev --omit=optional && npm cache clean --force

# Generated Prisma client
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Schema + seed
COPY prisma ./prisma

# Compiled app code
COPY --from=build /app/dist ./dist

# Vendored cook (compiled binaries + shell driver + JS helpers)
COPY --from=build /app/vendor ./vendor

# cook.sh does `cd "$SCRIPTBASE/rec"` to find raw files. Our raw files live
# in /app/rec (mounted from Chronicler's craig_rec volume at runtime). A
# symlink lets cook.sh find them at its expected path without us having to
# patch every $ID.ogg.* reference inside the script.
RUN ln -sfn /app/rec /app/vendor/rec

# Entrypoint
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Pre-create mount points for named volumes so Docker preserves node:node
# ownership when first creating the volume. If the directory doesn't exist
# in the image, Docker creates it root-owned and the unprivileged `node`
# process can't write to it (EACCES on first write).
RUN mkdir -p /app/data/cooked /app/data/session_art && chown -R node:node /app/data

USER node
EXPOSE 3001
ENTRYPOINT ["./entrypoint.sh"]
