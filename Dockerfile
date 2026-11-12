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
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Placeholder values satisfy the startup env validation during the build; the
# real values are supplied at run time and are what the server actually uses.
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    JWT_SECRET="build-time-placeholder-secret-value-32-chars"
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4000

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/tsconfig.json ./tsconfig.json

USER nextjs
EXPOSE 4000

CMD ["npm", "run", "start"]
