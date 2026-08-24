FROM node:24-alpine AS base

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.22.0 --activate

FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json eslint.config.js ./
COPY api/package.json api/package.json
COPY worker/package.json worker/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/mcp-inbound/package.json packages/mcp-inbound/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/schema-engine/package.json packages/schema-engine/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/db/prisma packages/db/prisma

RUN pnpm install --frozen-lockfile

COPY api api
COPY worker worker
COPY packages packages
COPY scripts scripts
COPY docs/mcp-surface.md docs/mcp-surface.md

RUN pnpm build

FROM base AS production-dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json api/package.json
COPY worker/package.json worker/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/mcp-inbound/package.json packages/mcp-inbound/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/schema-engine/package.json packages/schema-engine/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/db/prisma packages/db/prisma

RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  && pnpm --filter @deepcrm/db exec prisma generate \
  && runtime_prisma="$(find node_modules/.pnpm -maxdepth 1 -type d -name 'prisma@*' -print -quit)" \
  && test -n "${runtime_prisma}" \
  && ln -s ".pnpm/${runtime_prisma##*/}/node_modules/prisma" node_modules/prisma

FROM node:24-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache curl

COPY --chown=node:node --from=production-dependencies /app ./
COPY --chown=node:node --from=build /app/api/dist api/dist
COPY --chown=node:node --from=build /app/worker/dist worker/dist
COPY --chown=node:node --from=build /app/packages/db/dist packages/db/dist
COPY --chown=node:node --from=build /app/packages/mcp-inbound/dist packages/mcp-inbound/dist
COPY --chown=node:node --from=build /app/packages/queue/dist packages/queue/dist
COPY --chown=node:node --from=build /app/packages/schema-engine/dist packages/schema-engine/dist
COPY --chown=node:node --from=build /app/packages/schemas/dist packages/schemas/dist

ENV NODE_ENV=production
USER node

CMD ["node", "api/dist/index.js"]
