# DeepCRM

Headless, agent-native CRM. The only product surface is a **stateless MCP server** (`/mcp`, spec 2026-07-28). No web UI, no JS client, no REST data API. Agents (Nessie employees, or any MCP client) define object types, attributes and relationships at runtime and work the CRM through `crm_*` tools.

> **Rule zero (headless edition) — a capability is not done until an agent can discover it.** Every capability ships as a tool (or resource) whose name, description and input schema are good enough for an agent to use it *unprompted*, and it appears in `tools/list` / `crm://schema` in the same change. "The service function exists" is not a delivery.

@./AGENTS.md

## Read first

- [docs/brief.md](docs/brief.md) — what and why; protocol decision; open questions with assumed defaults.
- [docs/architecture.md](docs/architecture.md) — topology, packages, guardrails.
- [docs/schema-engine.md](docs/schema-engine.md) — the metadata model, Prisma schema, attribute types, write path, query grammar, merge.
- [docs/mcp-surface.md](docs/mcp-surface.md) — every tool, resource and prompt (the spec for the product surface).
- [docs/auth-and-tenancy.md](docs/auth-and-tenancy.md) — inbound MCP auth, tenant resolution, policy.
- [docs/deployment.md](docs/deployment.md), [docs/testing.md](docs/testing.md).
- [docs/spec/](docs/spec/) — wire-level design: contracts (zod for every tool), templates, policy defaults, events protocol, protocol flows, Nessie integration. Plans copy from these files verbatim.
- [docs/plans/00-execution-guide.md](docs/plans/00-execution-guide.md) — how the work is broken into tasks an agent executes one at a time.

## Architecture

- **API** (`api/`, port **5656** local dev) — Fastify; `/mcp` (MCP streamable HTTP, stateless, built per request), `/.well-known/oauth-protected-resource`, `/health`. Routes/tools parse input, call a service, translate errors.
- **Worker** (`worker/`) — Postgres-queue consumer: search reindex + embeddings, dedup scans, bulk import/export Tasks, change delivery (webhooks), retention.
- **Packages** (`packages/`) — `schemas` (zod contracts, shared types), `db` (Prisma client + migrations helpers), `schema-engine` (metadata, validation, normalisation, write path, query compiler, merge), `mcp-inbound` (auth seam), `queue`.
- **No** `admin/`, `web/`, `desktop/`, `mobile/`. If something needs a screen, it lives in Nessie.

## Tech

- Node 24, pnpm 10.22, TypeScript 5.9 strict (`tsconfig.base.json` copied from nessie), ESLint flat config with `max-len` 120 and `no-explicit-any`.
- Fastify 5, Prisma 6 + PostgreSQL 16 + pgvector, `@modelcontextprotocol/sdk` ≥ 1.30, zod 3.25, jose.
- Tenancy: one UOA organisation = one `Organization` (`externalOrgId` unique); one UOA team = one `Team` (`externalTeamId` unique). **The tenant is the compound (organization_id, team_id)** on every CRM table; resolved from the authenticated principal, never from arguments.
- Identity: UOA (`authentication.unlikeotherai.com` — its `/llm` guide is the contract source) is the sole authority. **No local user table.** Inbound calls carry a UOA token-exchange delegation (`sub` + `org` + `active` + `act`, verified via `/oauth/jwks.json`) so users never re-login; direct clients use UOA's public MCP OAuth profile. See [docs/spec/uoa-integration.md](docs/spec/uoa-integration.md). Actors are `(actorType ∈ human|agent|system, actorId)`.
- Inbound MCP auth: bearer = product app key; `X-UOA-Delegation` = user/workspace resource token; `X-Nessie-Context` = RS256 provenance `{agentId, runId, toolCallId, requestId}`. Local dev with `REQUIRE_AUTH=false` serves a dev principal.
- Embeddings: `EMBEDDING_DIMENSIONS = 1024` in `packages/schemas/src/embedding.ts` is the only place the width appears.
- Query cursors are authenticated opaque AES-256-GCM envelopes. DeepCRM processes require the versioned `DEEPCRM_SECRET_KEYRING_B64` (`{active, keys}`), including a named `export` HMAC key; there is no unsigned or process-local fallback. `crm_export` returns a Task whose result is a redacted, row-capped, signed single-use URL under `/exports/:jobId`, valid for at most one hour.

## Ports — NON-NEGOTIABLE

- API local dev: **5656**. Never another port. Production container internal port: `5656` via `DEEPCRM_API_PORT`.

## Dev loop

- `pnpm dev` → API with `tsx watch` (polling — the volume has no fsevents) + embedded worker.
- `pnpm lint`, `pnpm typecheck`, `pnpm build` (lint-gated), `pnpm test` (Turbo; export `DATABASE_URL` or DB suites skip).
- After deploying the T16 matching-generation migration and before enabling the
  API, set the real operator UOA subject in `DEEPCRM_BOOTSTRAP_UOA_USER_ID` and
  run `pnpm --filter @deepcrm/worker exec tsx src/matching-bootstrap.ts`;
  use `--retry-terminal` only after correcting a terminal failed/cancelled
  bootstrap. Production runs the compiled equivalent before container startup.
- After starting/restarting the API verify `GET http://localhost:5656/health` returns `{ "ok": true }`.

## Docs discipline

Behaviour, contract or topology change ⇒ the matching `docs/*.md` changes in the same commit. Finished plan files move to `docs/done/`. A change to the MCP surface updates `docs/mcp-surface.md` **and** the tool's description in code — the description is the spec agents read.
