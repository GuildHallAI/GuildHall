FROM oven/bun:1-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

FROM base AS runner
ARG BUILD_COMMIT=unknown
ENV NODE_ENV=production
ENV BUILD_COMMIT=$BUILD_COMMIT
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock bunfig.toml ./
COPY src ./src
COPY db ./db
EXPOSE 3001
USER bun
CMD ["bun", "run", "start"]
