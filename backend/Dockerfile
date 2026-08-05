FROM node:22-slim AS builder

WORKDIR /app
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build

RUN apt-get update -y \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src

RUN npm run db:generate
RUN npm run build

FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update -y \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/dist ./dist
COPY scripts/trigger-scheduled-sync.mjs ./scripts/trigger-scheduled-sync.mjs

EXPOSE 8080

# Apply committed Prisma migrations before accepting requests. Container hosts
# may start more than one instance at a time; Prisma serializes migrations with
# a PostgreSQL advisory lock, so concurrent starts remain safe.
CMD ["sh", "-c", "npm run db:migrate:deploy && npm start"]
