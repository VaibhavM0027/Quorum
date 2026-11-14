# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Quorum production image.
#
# Three stages: install locked dependencies, build the Next.js app, then run a
# slim runtime that carries only what `next start` needs. pdfkit ships native
# font files, so node_modules is carried across intact rather than traced.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS deps
WORKDIR /app
# Prisma needs OpenSSL at install and run time.
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
# The `postinstall` hook runs `prisma generate`, which fails unless the schema is
# already present. Copy it before installing so `npm ci` can complete.
COPY prisma ./prisma
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
# Optional: the LiveKit origin is compiled into the Content-Security-Policy here,
# so passing these as build args yields the tightest connect-src. They are
# usually only available at run time, in which case next.config.mjs relaxes the
# policy to secure realtime transports instead of blocking every media socket.
ARG LIVEKIT_URL
ARG LIVEKIT_HOST
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Placeholder values satisfy the startup env validation during the build; the
# real values are supplied at run time and are what the server actually uses.
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    JWT_SECRET="build-time-placeholder-secret-value-32-chars" \
    LIVEKIT_URL=${LIVEKIT_URL} \
    LIVEKIT_HOST=${LIVEKIT_HOST}
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
# Session recordings are written at run time, and the runtime user owns nothing
# under /app yet. Create the store and hand it to that user, otherwise the first
# upload fails with EACCES. Mount a persistent disk here in production (see
# render.yaml): a container filesystem is discarded on every deploy.
RUN mkdir -p /app/data/recordings && chown -R nextjs:nodejs /app/data

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/tsconfig.json ./tsconfig.json

USER nextjs
EXPOSE 4000

# PaaS platforms (Render, Railway, Fly) inject PORT and route traffic to it.
# `exec` keeps next as PID 1 so SIGTERM reaches it for graceful shutdown.
CMD ["sh", "-c", "exec node_modules/.bin/next start -p \"${PORT:-4000}\" -H 0.0.0.0"]
