# Architecture

The Nessie backend pattern (Fastify + Prisma + PostgreSQL, Postgres-backed queue, separate worker, shared packages, pnpm + Turbo) with every presentation layer removed and an MCP server as the only product surface. Read [brief.md](brief.md) §4 for what is reused from Nessie and why; this document is the concrete layout and the guardrails.

## 1. Topology

```
MCP client (Nessie agent run, or any 2026-07-28 client)
   │  POST /mcp   (streamable HTTP, stateless; one JSON-RPC request per HTTP request)
   │  Authorization: Bearer <app key>
   │  X-UOA-Delegation: <resource token: user + org + team>
   │  X-Nessie-Context: <RS256 JWT: agentId, runId, toolCallId, requestId>
   ▼
deepcrm-api (Fastify, port 5656)
   ├─ plugins/mcp-http.ts       per-request McpServer + StreamableHTTPServerTransport
   ├─ mcp/tools/*.ts            crm_* tool registrations (thin adapters)
   ├─ mcp/resources.ts          crm://schema, crm://schema/{type}, crm://templates
   ├─ routes/health.ts          GET /health
   ├─ routes/oauth-metadata.ts  GET /.well-known/oauth-protected-resource
   └─ services/*                one module per CRM concern; ALL business logic
          │
          ▼ Prisma (packages/db)
   PostgreSQL 16 + pgvector ──── queue_jobs ──► deepcrm-worker
   (metadata, records, links,                   jobs/record-reindex(-neighbours).ts
    changes, unique keys, search,               jobs/dedup-scan.ts, attribute-index.ts
    audit, policy, approvals, jobs)             jobs/bulk-assert.ts, bulk-export.ts, match-key-backfill.ts
                                                jobs/change-deliver.ts, embed-model-migrate.ts
                                                jobs/retention.ts
```

Process modes: `api` (default), `worker`, and `all` (api with the worker embedded — the local-dev default, exactly like nessie's embedded worker).

## 2. Repository layout

```
deepcrm.live/
  api/                      @deepcrm/api      Fastify process
    src/
      index.ts              boot: env → prisma → build app → listen (+ embedded worker in `all` mode)
      app.ts                buildApp(deps): registers plugins/routes; no side effects at import
      env.ts                zod-validated process env (deepsignal pattern)
      plugins/mcp-http.ts   /mcp transport; builds McpServer per request from principal
      mcp/server.ts         buildMcpServer(ctx, deps) → registers tool groups
      mcp/tools/schema.ts   crm_schema_*, crm_object_type_*, crm_attribute_*, crm_relation_type_*, crm_matching_rule_set, crm_template_apply
      mcp/tools/records.ts  crm_record_*, crm_records_query/count/get_many, crm_records_bulk_assert (split files allowed to honour the 500-line cap)
      mcp/tools/links.ts    crm_link, crm_unlink, crm_links_list
      mcp/tools/lists.ts    crm_list_*, crm_view_*
      mcp/tools/activity.ts crm_activity_log, crm_record_timeline, crm_task_*
      mcp/tools/pipeline.ts crm_pipeline_summary
      mcp/tools/search.ts   crm_search
      mcp/tools/quality.ts  crm_find_duplicates, crm_merge_records, crm_unmerge, crm_data_quality
      mcp/tools/io.ts       crm_export, crm_changes_since, crm_webhook_set
      mcp/tools/errors.ts   ServiceError → MCP tool error/MRTR mapping
      mcp/resources.ts      incl. crm://help/* and resources/templates/list
      mcp/tasks.ts          Tasks-extension adapter (tasks/get, tasks/cancel) over queue_jobs
      mcp/prompts.ts
      routes/health.ts
      routes/oauth-metadata.ts
      services/             domain services (see §3)
    test/                   Fastify + MCP client harness tests
  worker/                   @deepcrm/worker
    src/index.ts            poll loop over queue_jobs
    src/jobs/*.ts            one file per job type (the set listed in the diagram above)
  packages/
    schemas/                @deepcrm/schemas   zod contracts, shared types, EMBEDDING_DIMENSIONS, error codes
    db/                     @deepcrm/db        Prisma schema + client factory + migrations + audit chain
    schema-engine/          @deepcrm/schema-engine  metadata, attribute types, validation/normalisation,
                                                    write path, query compiler, merge, templates
    mcp-inbound/            @deepcrm/mcp-inbound    header parsing, JWT verification, principal, tenant
    queue/                  @deepcrm/queue     enqueue/claim/complete over queue_jobs
  infrastructure/compose/   docker-compose.prod.yml, redeploy.sh
  scripts/                  lint-migrations.mjs, generate-mcp-docs.mjs
  docs/
```

## 3. Services (api/src/services)

Each service exports plain functions taking `(deps, ctx: ActorContext, input)` and returning typed results or throwing `ServiceError` (from `@deepcrm/schemas`). Tools never touch Prisma.

| Service | Owns |
|---|---|
| `tenancy.ts` | resolve/provision `Organization` + `Team` from principal (1:1 UOA). |
| `policy.ts` | `checkPolicy(ctx, resourceType, action, scope)` deny-overrides; default bindings. |
| `schema.ts` | object types, attributes, relation types, matching rules, templates, `schema_version`. |
| `records.ts` | create/update/assert/get/delete/restore/query/at. |
| `links.ts` | link/unlink/list with cardinality enforcement. |
| `lists.ts` | lists, entries, views. |
| `activity.ts` | activity log, timeline, tasks. |
| `pipeline.ts` | stage summaries from `record_changes`. |
| `search.ts` | keyword/semantic/hybrid over `record_search`. |
| `quality.ts` | duplicates, merge/unmerge, data quality report. |
| `io.ts` | export, change feed, webhooks. |
| `approvals.ts` | MRTR approval tokens ↔ `approval_requests`. |
| `audit.ts` | `writeAudit(tx, …)` hash-chained. |

The schema engine package holds the pure, Prisma-transaction-scoped core (`validateRecordData`, `normalizeValue`, `applyWrite`, `compileFilter`, `planMerge`); services orchestrate policy + engine + audit + queue.

## 4. Guardrails (things to avoid)

- No `helpers`, `utils`, `common`, `extras` modules. Name files after the responsibility they own.
- Tools do not own workflows: parse → service → map errors. A tool file registers tools and nothing else.
- No import-time side effects; `buildApp`, `buildMcpServer`, `createWorker` take explicit deps (prisma, clock, ids, fetch, queue, embedder).
- Never read tenancy from tool arguments. `ctx.tenant` comes from the authenticated principal only.
- Never write `records.data` without `validateRecordData` against the live schema; never write it outside a transaction that also writes `record_changes` and `audit_logs`.
- Never store a JSON array of ids as a relationship; links live in `record_links`. `data[slug]` for a `record_reference` attribute is **computed at read** from active links (schema-engine §4a) — never persisted.
- No per-tenant DDL. Ever.
- Never call `fetch` on an agent- or operator-supplied URL; use `safeFetch` from `@deepcrm/schemas/net` (port of nessie's IP-pinned guard).
- Never log `records.data`, tool arguments, tokens, or webhook bodies.
- No REST endpoints for CRM data. If a client cannot speak MCP it is not a DeepCRM client. **One blessed exception:** `GET /exports/:jobId` — the signed, single-use, expiring file download minted by `crm_export` (signature uses a dedicated keyring key id, `export`).
- Do not adopt deprecated MCP features (Sampling, Roots, Logging, HTTP+SSE transport).

## 5. Cross-process rules

- The worker and the API share `packages/*`; neither imports from the other.
- Queue jobs carry `{organizationId, teamId}` and an idempotency key; handlers are idempotent, **re-resolve the tenant from payload ids and abort on mismatch**. Claiming uses `FOR UPDATE SKIP LOCKED` with a lease (`locked_at` older than the lease ⇒ reclaimable); `change.deliver`/`record.reindex` run in a high-priority lane bulk jobs cannot starve; bulk payload rows carry per-row idempotency keys so batch retries skip completed rows.
- `schema_version` is bumped inside the same transaction as any metadata change; caches key on it.

## 6. Environment (api/src/env.ts)

| Var | Default | Purpose |
|---|---|---|
| `DEEPCRM_API_PORT` | `5656` | listen port |
| `DEEPCRM_API_PUBLIC_URL` | `http://localhost:5656` | resource id in OAuth metadata, webhook `source` |
| `DATABASE_URL` | — | Postgres |
| `DEEPCRM_PROCESS_MODE` | `all` | `api` / `worker` / `all` |
| `REQUIRE_AUTH` | `true` (prod) / `false` (dev) | off ⇒ dev principal |
| `DEEPCRM_APPS` | — | per-app registry JSON: key hashes + context JWKS/issuer + sourceDomain/product ([uoa-integration.md](spec/uoa-integration.md)) |
| `UOA_BASE_URL` | `https://authentication.unlikeotherai.com` | delegation issuer; JWKS at `${UOA_BASE_URL}/oauth/jwks.json` |
| `DEEPCRM_DIRECT_CLIENTS` | `false` | accept UOA public-profile OAuth tokens (no app key) |
| `DEEPCRM_UOA_CONFIG_PRIVATE_KEY_B64`, `DEEPCRM_UOA_CLIENT_SECRET` | — | DeepCRM's own UOA registration, outbound-only (chained Ledger attribution) |
| `DEEPCRM_SECRET_KEYRING_B64` | — | required versioned AES-256-GCM keyring (`{active, keys}`) for authenticated opaque query cursors and purpose-separated sealed material (webhooks/MRTR/exports as those tasks land) |
| `LEDGER_PUBLIC_URL`, `LEDGER_PROXY_TOKEN` | — | embeddings via Ledger `/v1/jina` |
| `DEEPCRM_EMBEDDING_MODEL` | `jina-embeddings-v3` | |
| `DEEPCRM_MAX_BULK_ROWS` | `10000` | bulk assert cap (mirrored in the tool schema) |
| `DEEPCRM_MAX_BODY_BYTES` | `10485760` | HTTP body cap (10 MB) |
| `DEEPCRM_MAX_EXPORT_ROWS` | `100000` | export row cap |
| `DEEPCRM_EXPORT_DIR` | `./.exports` | export spool directory |
| `DEEPCRM_ORG_ALLOWLIST` | — | optional comma-separated UOA org ids allowed to provision |
| `DEEPCRM_BOOTSTRAP_UOA_USER_ID` | — | required only by the T16 matching bootstrap runner; stable UOA subject attributed as `on_behalf_of` for its migration-scoped system ActorContext and audit |
| `DEEPCRM_AUDIT_RETENTION_YEARS` | `7` | crypto-shred horizon for audit personal fields |
| `DEEPCRM_RETENTION_DAYS` | `30` | soft-delete / merge snapshot retention |
| `DEEPCRM_TRUSTED_PROXY_HOPS` | `0` | `1` behind Caddy |

Rate limiting is a deployment requirement: the Caddy edge meters per app key × `Mcp-Name`; expensive tools get a stricter bucket. Boot fails closed when `REQUIRE_AUTH=false` outside localhost (auth-and-tenancy §1).
