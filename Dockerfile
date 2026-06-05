# Multi-stage. Build stage runs prisma generate + tsc; runtime stage carries
# the smaller prod-only node_modules plus the generated Prisma client.
#
# Notes:
#   - openssl is required at runtime by Prisma's query engine.
#   - We keep `prisma` and `tsx` as prod deps (not devDeps) so the runtime
#     image can run `prisma db push`, `prisma db seed`, and execute the
#     TS seed file directly without a separate compile step for it.
FROM node:20-bookworm-slim AS build
WORKDIR /app
# openssl + ca-certificates so prisma generate can fetch the right engine
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate
RUN npx tsc -p .

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# openssl required at runtime by the Prisma engine binary
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Production deps only (still includes prisma + tsx — see header note)
COPY package.json ./
RUN npm install --omit=dev --omit=optional && npm cache clean --force

# Generated Prisma client (lives under node_modules/.prisma + @prisma/client/runtime)
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Schema + seed (db push and seed CLI both read prisma/)
COPY prisma ./prisma

# Compiled app code
COPY --from=build /app/dist ./dist

# Entrypoint
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Drop privileges. node user (uid 1000) exists in the base image.
USER node
EXPOSE 3001
ENTRYPOINT ["./entrypoint.sh"]
