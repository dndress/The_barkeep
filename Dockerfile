# Multi-stage so the runtime image doesn't carry tsc, devDeps, or source maps
# for code that's already been transpiled. Future stages will add ffmpeg + the
# bundled cook binary here for transcription work.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json ./
# No lockfile yet (stage 1). Once `npm install` is run for real, commit
# package-lock.json and switch to `npm ci` for reproducible builds.
RUN npm install --omit=optional

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN npx tsc -p .

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Production deps only — smaller image, smaller attack surface.
COPY package.json ./
RUN npm install --omit=dev --omit=optional && npm cache clean --force
COPY --from=build /app/dist ./dist
# Drop privileges. The shared craig_rec volume mounts read-only so this user
# only ever needs read access.
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
