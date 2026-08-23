# Phase 1 — Scaffold

Outcome: the monorepo installs, lints, typechecks; Prisma migrations apply to a pgvector Postgres; `pnpm dev` serves `GET /health` on 5656 with a dev principal.

### T01 — Monorepo skeleton

**Depends on:** none. **Spec:** `CLAUDE.md`, `docs/architecture.md` §2.

**Files (create):**
- `package.json`
  ```json
  {
    "name": "deepcrm",
    "private": true,
    "type": "module",
    "packageManager": "pnpm@10.22.0",
    "engines": { "node": ">=24" },
    "scripts": {
      "dev": "pnpm --filter @deepcrm/api dev",
      "lint": "node scripts/lint-migrations.mjs && node scripts/lint-tenant-where.mjs && turbo run lint",
      "typecheck": "pnpm prisma:generate && turbo run typecheck",
      "build": "pnpm lint && pnpm prisma:generate && turbo run build",
      "test": "turbo run test",
      "verify": "pnpm lint && pnpm typecheck && pnpm test",
      "prisma:generate": "pnpm --filter @deepcrm/db prisma:generate",
      "docs:mcp": "node scripts/generate-mcp-docs.mjs"
    },
    "devDependencies": {
      "@types/node": "^24.0.0",
      "@typescript-eslint/eslint-plugin": "^8.58.0",
      "@typescript-eslint/parser": "^8.58.0",
      "eslint": "^10.2.0",
      "tsx": "^4.20.6",
      "turbo": "^2.5.8",
      "typescript": "^5.9.3",
      "vitest": "^3.2.6"
    }
  }
  ```
- `pnpm-workspace.yaml`: `packages:\n  - api\n  - worker\n  - packages/*`
- `turbo.json`: tasks `build` (`dependsOn: ["^build"]`, `outputs: ["dist/**"]`), `lint` (`dependsOn: ["^build"]`), `typecheck` (`dependsOn: ["^build"]`), `test` (`dependsOn: ["^build"]`, `cache: false`, `env: ["DATABASE_URL"]`), `dev` (`cache: false`, `persistent: true`).
- `tsconfig.base.json`: copy nessie's verbatim (target ES2022, module ESNext, moduleResolution Bundler, strict, noUnusedLocals/Parameters, noUncheckedIndexedAccess, verbatimModuleSyntax, resolveJsonModule, skipLibCheck).
- `eslint.config.js`: nessie's first two blocks (ignores `**/dist/**`, `**/node_modules/**`; TS parser; rules `no-unused-vars` off, `@typescript-eslint/no-unused-vars` error with `argsIgnorePattern: '^_'`, `@typescript-eslint/no-explicit-any` error, `max-len` 120 ignoring strings/templates).
- `.gitignore`: `node_modules`, `dist`, `.env`, `.worktrees/`, `*.tsbuildinfo`, `coverage`.
- `.env.example`: every var from `docs/architecture.md` §6 with dev values (`REQUIRE_AUTH=false`, `DATABASE_URL=postgresql://deepcrm:deepcrm@localhost:5657/deepcrm`, `DEEPCRM_API_PORT=5656`).
- `scripts/lint-migrations.mjs`: exits 0 when `packages/db/prisma/migrations` is absent or every migration dir name matches `^\d{14}_[a-z0-9_]+$`; exits 1 if any `.sql` under it contains `CREATE INDEX` without `CONCURRENTLY` on tables `records|record_changes|record_search` **outside** the initial migration. (Initial migration is the first directory alphabetically.)
- `scripts/lint-tenant-where.mjs`: scans `api/src/services/**/*.ts` and `packages/schema-engine/src/**/*.ts`; for every line matching `prisma\.(record|recordLink|recordChange|objectType|attribute|relationType|list|view|matchingRule|webhook)\.(findMany|findFirst|count|updateMany|deleteMany)\(` the following 5 lines must contain `tenantWhere(`; otherwise print `file:line` and exit 1. Exits 0 when no files exist yet.
- `scripts/generate-mcp-docs.mjs`: placeholder that prints `docs:mcp not implemented until T26` and exits 0.
- Package skeletons — each with `package.json` (`name`, `type: module`, `main: dist/index.js`, `types: dist/index.d.ts`, scripts `build: tsc -p tsconfig.build.json`, `typecheck: tsc --noEmit -p tsconfig.json`, `lint: eslint src --max-warnings=0`, `test: vitest run`), `tsconfig.json` (extends base, `include: ["src", "test"]`), `tsconfig.build.json` (extends base, `outDir: dist`, `rootDir: src`, `declaration: true`, `include: ["src"]`), `src/index.ts` exporting nothing yet (`export {}`):
  - `packages/schemas` (`@deepcrm/schemas`, deps: `zod@^3.25.76`)
  - `packages/db` (`@deepcrm/db`, deps: `@prisma/client@^6.17.1`; devDeps: `prisma@^6.17.1`; extra script `prisma:generate: prisma generate`)
  - `packages/schema-engine` (`@deepcrm/schema-engine`, deps: `@deepcrm/schemas`, `@deepcrm/db`, `zod`, `libphonenumber-js@^1.11.0`, `tldts@^6.1.0`, `fast-check` devDep)
  - `packages/mcp-inbound` (`@deepcrm/mcp-inbound`, deps: `jose@^5.9.6`, `zod`, `@deepcrm/schemas`)
  - `packages/queue` (`@deepcrm/queue`, deps: `@deepcrm/db`, `zod`)
  - `api` (`@deepcrm/api`, deps: `fastify@^5.8.4`, `@modelcontextprotocol/sdk@^1.30.0`, `zod`, all `@deepcrm/*` workspace packages; scripts `dev: tsx watch --poll src/index.ts`, `start: node dist/index.js`)
  - `worker` (`@deepcrm/worker`, deps: `@deepcrm/db`, `@deepcrm/queue`, `@deepcrm/schema-engine`, `@deepcrm/schemas`)

**Steps:** create the files; `pnpm install`; `git init` if needed; commit.

**Acceptance:**
```bash
pnpm install --frozen-lockfile=false && pnpm lint && pnpm typecheck
node -e "const p=require('./package.json');if(p.packageManager!=='pnpm@10.22.0')process.exit(1)"
```
Both exit 0.

---

### T02 — Shared contracts: errors, actors, tenant, embedding width

**Depends on:** T01. **Spec:** `docs/schema-engine.md` §10, `docs/auth-and-tenancy.md` §2.

**Files (create) in `packages/schemas/src/`:**
- `errors.ts` — `export const ErrorCode = { POLICY_DENIED: 'POLICY_DENIED', … } as const` with every code in schema-engine §10; `export class ServiceError extends Error { constructor(public code: ErrorCodeValue, message: string, public details: Record<string, unknown> = {}) }`; `export function isServiceError(e: unknown): e is ServiceError`.
- `actor.ts` — `ActorTypeSchema = z.enum(['human','agent','system'])`, `ActorSchema = z.object({ type: ActorTypeSchema, id: z.string().min(1) })`, `Actor` type.
- `context.ts` — `Principal`, `ActorContext` types exactly as auth-and-tenancy §2; `ProvenanceSchema`.
- `embedding.ts` — `export const EMBEDDING_DIMENSIONS = 1024`.
- `ids.ts` — `export const UuidSchema = z.string().uuid()`, `SlugSchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/)`.
- `index.ts` — re-export all.
- `errors.test.ts` — `isServiceError` true/false; codes unique.

**Acceptance:** `pnpm --filter @deepcrm/schemas build && pnpm exec turbo run test --filter=@deepcrm/schemas` passes; `grep -c "1024" packages/schemas/src/embedding.ts` prints `1`.

---

### T03 — Prisma schema and initial migration

**Depends on:** T02. **Spec:** `docs/schema-engine.md` §2 (copy verbatim), `docs/testing.md` "Local database".

**Files:**
- Create `packages/db/prisma/schema.prisma` — the exact contents of schema-engine §2 code block.
- Create `packages/db/src/client.ts`:
  ```ts
  import { PrismaClient } from '@prisma/client'
  export type Db = PrismaClient
  export function createDb(url: string): Db { return new PrismaClient({ datasources: { db: { url } } }) }
  ```
- Create `packages/db/src/tenant-where.ts`:
  ```ts
  export type TenantRef = { organizationId: string; teamId: string }
  export function tenantWhere(t: TenantRef): { organizationId: string; teamId: string } {
    return { organizationId: t.organizationId, teamId: t.teamId }
  }
  ```
- Edit `packages/db/src/index.ts` — export `createDb`, `Db`, `tenantWhere`, `TenantRef`, and `export * from '@prisma/client'` for enums.
- Generate the migration: with the local Postgres running, `pnpm --filter @deepcrm/db exec prisma migrate dev --name init --create-only`, then **append** to the generated `migration.sql` the raw statements listed as comments in schema-engine §2 (`records_data_gin`, `records_display_name_trgm`, `record_links_active_unique`, `record_search.tsv` generated column + gin, `record_search_embedding` hnsw) and `CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;` at the top. Then `prisma migrate dev` to apply.
- Create `packages/db/src/testing.ts` — `seedTenant(db): Promise<{ organizationId, teamId, externalOrgId, externalTeamId }>` inserting an org + team with random `external_*` ids (`crypto.randomUUID()`), and `dropTenant(db, organizationId)` deleting the org (cascades).
- Create `packages/db/test/db/migrate.test.ts` (DB-gated): `seedTenant`, assert `SELECT extname FROM pg_extension` contains `vector` and `pg_trgm`, `dropTenant`.

**Acceptance (with `DATABASE_URL` exported):**
```bash
pnpm --filter @deepcrm/db exec prisma migrate deploy
pnpm prisma:generate && pnpm typecheck && pnpm exec turbo run test --filter=@deepcrm/db
ls packages/db/prisma/migrations | grep -c _init
```
Last command prints `1`.

---

### T04 — Env, app builder, health route, process modes

**Depends on:** T03. **Spec:** `docs/architecture.md` §1, §6.

**Files (create):**
- `api/src/env.ts` — zod schema for every var in architecture §6 (deepsignal pattern: `boolish`, `optionalString`), `REQUIRE_AUTH` default `false` when `NODE_ENV !== 'production'` else `true`; `export const env = EnvSchema.parse(process.env)`; load `.env` from repo root via `dotenv`-free reader (read file, split lines, set `process.env` only for unset keys).
- `api/src/deps.ts` — `export type AppDeps = { db: Db; clock: () => Date; ids: () => string; version: string }`; `createAppDeps(env)`.
- `api/src/app.ts` — `export function buildApp(deps: AppDeps): FastifyInstance` registering only `routes/health.ts`; `trustProxy: env.DEEPCRM_TRUSTED_PROXY_HOPS`; `logger` with redaction of `authorization`, `x-uoa-delegation`, `x-nessie-context`.
- `api/src/routes/health.ts` — `GET /health` → `{ ok: true, version, db: 'ok' | 'error' }` (runs `SELECT 1`); 503 when db errors.
- `api/src/index.ts` — parse env, create deps, `buildApp`, listen on `DEEPCRM_API_PORT` host `0.0.0.0`; if `DEEPCRM_PROCESS_MODE` is `all`, also `import('@deepcrm/worker')` and call `startWorker(deps)` (stub exported in `worker/src/index.ts` that logs "worker: idle (no jobs registered)"). Mode `worker` ⇒ only worker. Graceful shutdown on SIGTERM.
- `api/test/health.test.ts` — `buildApp` with a fake db (`$queryRaw` resolves) → `inject GET /health` → 200 body `ok: true`.

**Acceptance:**
```bash
pnpm typecheck && pnpm exec turbo run test --filter=@deepcrm/api
(pnpm dev > /tmp/deepcrm-dev.log 2>&1 &) ; sleep 6; curl -sf http://localhost:5656/health; pkill -f "tsx watch" || true
```
curl prints `{"ok":true,…}`.

---

### T05 — Dev principal and request context

**Depends on:** T04. **Spec:** `docs/auth-and-tenancy.md` §1–§3.

**Files:**
- Create `packages/mcp-inbound/src/principal.ts` — `Principal` zod schema; `devPrincipal(): Principal` = `{ app:'dev', uoaUserId:'usr_dev', uoaOrgId:'org_dev', uoaTeamId:'team_dev', credentialEpoch:0, agentId:'agent_dev', provenance:{ runId:'run_dev', toolCallId:'call_dev', requestId:'req_dev' } }`.
- Create `api/src/services/tenancy.ts` — `resolveTenant(deps, principal): Promise<{ organizationId, teamId }>`: upsert `organizations` by `externalOrgId` (name `Organisation ${id.slice(0,8)}`), upsert `teams` by `externalTeamId`; in-process LRU cache keyed by `org:team` for 60 s.
- Create `api/src/services/context.ts` — `buildActorContext(deps, principal, requestId): Promise<ActorContext>` (actor = agent when `agentId` else human).
- Create `api/test/db/tenancy.test.ts` — resolving the same principal twice returns the same ids; different team ⇒ different ids; cleanup by org.

**Acceptance:** `pnpm typecheck && pnpm exec turbo run test --filter=@deepcrm/api` (DB exported).

---

### T06 — Audit chain and queue package

**Depends on:** T05. **Spec:** `docs/auth-and-tenancy.md` §6; `docs/schema-engine.md` §2 (`QueueJob`).

**Files:**
- Create `packages/db/src/audit.ts` — `writeAudit(tx, entry: AuditEntryInput): Promise<void>`: lock `pg_advisory_xact_lock(hashtext('audit:'||organizationId))`, read last `entry_hash` for the org, compute `entry_hash = sha256(prev_hash ?? '' + canonicalJson({...entry, createdAt}))`, insert. `canonicalJson` sorts keys recursively.
- Create `packages/db/src/audit.test.ts` (DB): two writes chain; `scripts/verify-audit-chain.mjs` (create) recomputes for an org and exits 0; tamper a row's `reason` ⇒ exits 1.
- Create `packages/queue/src/index.ts` — `enqueue(db, { type, payload, organizationId?, teamId?, idempotencyKey?, visibleAt? })` (ignore duplicate idempotency key, return existing id); `claimNext(db, workerId, types[])` using `UPDATE … WHERE id = (SELECT id FROM queue_jobs WHERE status='queued' AND visible_at<=now() AND type = ANY($1) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`; `complete(db, id, result)`, `fail(db, id, error)` (re-queue with backoff `min(2^attempts, 60) minutes` until `max_attempts`, then `failed`), `progress(db, id, progress)`.
- Create `packages/queue/test/db/queue.test.ts` — enqueue/claim/complete; duplicate idempotency returns same id; fail→requeue→failed after max.

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/db --filter=@deepcrm/queue` green; `node scripts/verify-audit-chain.mjs` exits 0.

---

### T07 — Worker loop

**Depends on:** T06. **Spec:** `docs/architecture.md` §1.

**Files:**
- Edit `worker/src/index.ts` — `startWorker(deps: WorkerDeps, handlers: Record<string, JobHandler>)`: loop every 1 s, `claimNext` over `Object.keys(handlers)`, run handler with `{ db, job, progress }`, `complete`/`fail`; concurrency 4; stop on `AbortSignal`.
- Create `worker/src/jobs/registry.ts` — `export const handlers = {}` (filled by later tasks) and `worker/src/jobs/noop.ts` (`noop` handler for tests).
- Create `worker/test/db/loop.test.ts` — enqueue `noop`, start worker with abort after completion, assert `completed`.

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/worker` green.

---

### T08 — CI workflow

**Depends on:** T07. **Spec:** `docs/testing.md` "CI".

**Files:** create `.github/workflows/ci.yml` with jobs `lint`, `typecheck`, `test` (service `pgvector/pgvector:pg16`, `DATABASE_URL` env, runs `prisma migrate deploy` then `pnpm test` then `node scripts/verify-audit-chain.mjs`), `build` (`docker build -f Dockerfile.app .` — **skip with `if: hashFiles('Dockerfile.app') != ''`** until T43). Node 24, pnpm 10.22 via `pnpm/action-setup`.

**Acceptance:** `node -e "require('js-yaml')"` is not available — instead validate with `pnpm exec tsx -e "import('node:fs').then(fs=>{const y=fs.readFileSync('.github/workflows/ci.yml','utf8');if(!y.includes('pgvector/pgvector:pg16'))process.exit(1)})"` exits 0; `pnpm verify` green locally.
