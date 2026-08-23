# Testing

Runner: **vitest 3** in every package (deepsignal pattern). `pnpm test` = `turbo run test` with `env: ["DATABASE_URL"]`, `cache: false`.

## Layers

1. **Unit (no DB)** — attribute types (validate/normalise/search text), filter compiler (output SQL snapshots), merge planner (pure), policy evaluator, inbound auth (JWT fixtures signed by a test key), idempotency hashing. Location: `packages/*/src/**/*.test.ts`, `api/src/**/*.test.ts`.
2. **Postgres-backed** — gated `process.env.DATABASE_URL ? describe : describe.skip`. Each file creates its **own** organisation + team (`seedTenant()` from `packages/db/src/testing.ts`) and cleans up only its own rows in `afterAll`. Never assert global counts; never delete by pattern. Location: `api/test/db/*.test.ts`, `worker/test/db/*.test.ts`, `packages/schema-engine/test/db/*.test.ts`.
3. **MCP harness** — `api/test/mcp/*.test.ts` builds the Fastify app with `REQUIRE_AUTH=false` (dev principal) or with signed test headers, and drives it with `@modelcontextprotocol/sdk` `Client` over `StreamableHTTPClientTransport`. Every tool in `docs/mcp-surface.md` has at least one harness test; `api/test/mcp/surface.test.ts` asserts the `tools/list` names equal the documented set (fails when a tool is added without docs).
4. **Property tests** — `packages/schema-engine/test/properties.test.ts` (fast-check): random schema → random writes → invariants: (a) `records.data` equals replay of `record_changes`; (b) `record_reference` projections equal active `record_links`; (c) `record_unique_keys` equals normalised unique values of live records; (d) merge then unmerge restores losers' data and links.
5. **Cross-tenant vector adversarial test** — two tenants seeded with near-identical embeddings; semantic search (the raw-SQL `searchQuery()` chokepoint) must never return the other tenant's row (auth-and-tenancy §3, R6).
6. **Audit chain** — `scripts/verify-audit-chain.mjs` run in CI against the test DB after the suite.

## Local database

```bash
docker run -d --name deepcrm-pg -p 5657:5432 -e POSTGRES_PASSWORD=deepcrm -e POSTGRES_USER=deepcrm -e POSTGRES_DB=deepcrm pgvector/pgvector:pg16
export DATABASE_URL=postgresql://deepcrm:deepcrm@localhost:5657/deepcrm
pnpm --filter @deepcrm/db prisma migrate deploy
pnpm test
```

## CI (`.github/workflows/ci.yml`)

Jobs: `lint` (root `pnpm lint` incl. migrations + tenant-where lints), `typecheck`, `test` (service `pgvector/pgvector:pg16`, `DATABASE_URL` set), `build` (Docker image build, no push), `upgrade-path` (restore `packages/db/upgrade-fixtures/baseline.sql.gz` then `prisma migrate deploy` — added once the first migration is frozen).

## Rules

- A test that needs a schema uses `applyTemplate(tx, tenant, 'standard_crm')`, never hand-inserted metadata.
- Timestamps: set explicit `occurred_at` when order matters; Postgres rounds `timestamp(3)`.
- Tests call services through the same `deps` object the app uses; no direct Prisma writes to CRM tables except in seed helpers.
- No network: embeddings use `FakeEmbedder` (deterministic hash → vector), webhooks use an in-process Fastify receiver.
