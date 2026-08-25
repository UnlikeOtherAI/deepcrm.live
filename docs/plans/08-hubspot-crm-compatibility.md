# Phase 8 — CRM semantic packages and MCP compatibility

Outcome: DeepCRM remains a generic runtime-schema CRM, while a tenant can install
the sales, service and commerce semantics that an agent normally expects from a
HubSpot-like CRM. This phase turns the supplied HubSpot comparison into a
compatibility benchmark; it does not assert anything about a third party's live
implementation. The benchmark is the supplied object/association vocabulary and
the ability to round-trip it through DeepCRM's discoverable MCP surface.

## Design boundary and shared acceptance

`object_types`, `attributes`, `records`, `relation_types` and `record_links`
remain the storage primitive for CRM domain objects. Ticket, lead, product,
line item, quote, subscription, invoice, payment and order are template-defined
object types and records, not bespoke domain tables. The only new physical tables
in this phase may be generic runtime metadata, immutable event/file facts, and
their generic links/cache state; no table may be named for a template object.

Every task below must preserve these invariants in its implementation and tests:

- Tenant scope is `(organization_id, team_id)` on every mutable/readable row and
  every raw query goes through the T56 search/row-access chokepoints. Cross-tenant
  reads, task polling and ID probing answer `NOT_FOUND`.
- Every mutation uses `applyWrite` or a named equivalent transaction, performs
  record visibility then policy checks, writes `record_changes` and an audit row
  in the same commit, and binds idempotency/replay to the calling principal.
- Derived data, list membership, file metadata and event payloads respect
  attribute sensitivity and visibility. Audit logs, error payloads, worker logs,
  webhooks and task results contain only IDs, counts and error codes—not raw
  record data or file/event payloads.
- Worker work is tenant-scoped, idempotent, lease-safe and cancellation-aware;
  stale derived/list indexes must have an explicit, bounded state rather than a
  silently incorrect result. Tests use a uniquely named disposable database, not
  the shared `deepcrm` database.
- Each new capability is discoverable in `tools/list` and the appropriate
  `crm://` resource. Every input field has a Zod `.describe()`, tool descriptions
  state when to use the tool and its errors, and `pnpm docs:mcp` regenerates
  `docs/mcp-surface.md`.

The final manual MCP acceptance is T68. Earlier task acceptances prove their
own unit, DB, worker and harness contracts; they are not substitutes for T68.

### T57 ✅ — Semantic metadata foundation and forward migration

**Depends on:** T56. **Spec:** this file; `docs/schema-engine.md` §§2–5;
`docs/spec/contracts.md`; `docs/mcp-surface.md` §§1–2, §5–§6.

**Files:**

- Edit `docs/schema-engine.md` and `packages/db/prisma/schema.prisma` to define
  the generic semantic metadata contract before code: `AttributeValueSource`
  (`stored`, `formula`, `rollup`, `relation_sync`, `score`, `system`);
  `attribute_groups`; `pipelines`; `pipeline_stages`; `record_stage_history`;
  generic attribute derivation/config/dependency state; dynamic-list definition
  state; generic file metadata/link state; and immutable event-type/event state.
  State exactly which values are materialized, which are read-only, and which
  values are virtual. Do not add template-specific models.
- Extend `RelationType` with directional active-edge limits (including optional
  label-specific limits) rather than overloading the four existing cardinality
  values. Define the precedence between cardinality, projection ownership and a
  configured limit, including the concurrent-write lock key.
- Create one additive, named Prisma migration and SQL indexes/constraints for
  this foundation. The migration must have preflight checks, backfill only
  derivable legacy data, leave existing stored attributes as `stored`, and fail
  rather than guess where an old status cannot be mapped to a pipeline stage.
- Add contract types and migration tests for an empty tenant, an upgraded tenant
  with `standard_crm`, idempotent re-application, rollback-free deploy, tenant
  isolation and constrained concurrent edge writes. Record any undecidable
  legacy mapping as a documented migration report, not a sentinel value.

**Acceptance:** `pnpm --filter @deepcrm/db exec prisma migrate deploy` succeeds
against a fresh disposable database and an upgraded fixture; `pnpm --filter
@deepcrm/db test`, `pnpm --filter @deepcrm/schemas test`, `pnpm typecheck`, and
`node scripts/lint-migrations.mjs` all exit 0. `pnpm docs:mcp && git diff
--exit-code docs/mcp-surface.md` exits 0 when no tools have been registered yet.
**Docs:** `docs/schema-engine.md` §§2–5; `docs/spec/contracts.md`.

---

### T58 ✅ — First-class pipelines, stages and stage history

**Depends on:** T57. **Spec:** this file; `docs/schema-engine.md` §§3a–5;
`docs/mcp-surface.md` §6.

**Files:**

- Create `packages/schema-engine/src/pipelines/` with schema mutation, stage
  validation, transition and history services. A pipeline belongs to one object
  type; a stage has stable slug, display order, optional probability and terminal
  category. A record selects a pipeline/stage through the generic schema—not a
  template-only column. Stage changes append immutable intervals atomically;
  reopen, same-stage no-op, delete/restore and merge semantics are explicit.
- Edit record writes, merge/unmerge, timeline and `crm_pipeline_summary` so the
  summary uses recorded stage intervals rather than reconstructing status from
  arbitrary change logs. Preserve existing status attributes until an explicit
  mapped migration completes; do not silently reinterpret custom status fields.
- Add `crm_pipeline_define`, `crm_pipeline_update`, `crm_pipeline_stage_set`,
  `crm_pipeline_stages_list` and a stage-aware `crm_pipeline_summary`. Add
  `crm://schema/{object_type}` pipeline/stage metadata and update the template
  contract to name its default pipeline.
- DB/harness tests cover out-of-order stage rejection, concurrent stage moves,
  terminal/reopen transitions, duration calculations, visibility/policy
  redaction, cursor stability and no duplicate history/audit rows on replay.

**Acceptance:** engine and API DB suites pass with a real isolated database;
the MCP harness defines a deal pipeline, moves a deal through two stages, and
returns the expected duration/count from `crm_pipeline_summary`; `pnpm docs:mcp
&& git diff --exit-code docs/mcp-surface.md` exits 0. **Docs:**
`docs/schema-engine.md` §§2, 4, 5, 9; `docs/mcp-surface.md` §§1, 2, 6.

---

### T59 ✅ — Derived attributes: formula, rollup, relation sync and score

**Depends on:** T58. **Spec:** this file; `docs/schema-engine.md` §§3–5, §8;
`docs/auth-and-tenancy.md` §3.

**Files:**

- Create a deterministic, bounded expression AST and type checker in
  `packages/schema-engine/src/derived/`; formulas never execute JavaScript,
  SQL, templates or model-generated code. Define null/error/overflow/divide-by-
  zero behavior, dependency DAG validation and cycle rejection.
- Implement four read-only `value_source`s over generic attributes: formula;
  rollup (`count`, `sum`, `min`, `max`, `average`, earliest/latest date) over
  an explicit relation/filter; relation sync from one explicitly selected active
  relation; and score from a bounded weighted criteria definition with optional
  time decay. Direct record writes to all four return `READ_ONLY_ATTRIBUTE`.
- Materialize only typed, policy-safe results and enqueue dependency refreshes
  from record/link/stage writes. The worker deduplicates by tenant, record,
  attribute and resulting version; it records a visible refresh state and never
  exposes a stale result as current. Reindex only the permitted derived values.
- Add schema tools for defining/updating a derived attribute and a compact
  `crm_derived_refresh_status` read. Define MRTR behavior for a definition that
  would change existing values; include derivation metadata in schema resources,
  never in ordinary record output unless its value is readable.
- Tests cover dependency cycles, typed formulas, filters, relation changes,
  deletion/restore/merge, score decay with a fixed clock, concurrent refresh,
  cancellation/retry, redacted source data, tenant isolation and audit-last
  ordering.

**Acceptance:** engine, worker and API DB suites pass; an MCP harness creates
company `total_open_pipeline` rollup, `last_contacted` relation sync and a
lead-score attribute, then proves updates after an associated write and no
direct write is accepted; `pnpm docs:mcp && git diff --exit-code
docs/mcp-surface.md` exits 0. **Docs:** `docs/schema-engine.md` §§2–5, §8;
`docs/mcp-surface.md` §§1–3.

---

### T60 ✅ — Dynamic lists and segment evaluation

**Depends on:** T59. **Spec:** this file; `docs/schema-engine.md` §5;
`docs/mcp-surface.md` §5.

**Files:**

- Extend the generic list model with `kind: static|dynamic`, typed object scope,
  a validated filter AST and `evaluation_version`/state. Static lists keep their
  existing `list_entries` behavior unchanged. Dynamic lists never accept manual
  membership writes.
- Compile dynamic definitions exclusively through the T56 query/visibility/policy
  path. Support record attributes, associations, stage state, activities, events
  and line-item relations only where each primitive already has a typed query
  operator; reject arbitrary JSON paths and unsupported cross-object joins.
- Implement incremental, tenant-scoped membership refresh jobs plus a bounded
  full reconciliation. Cached membership, if used, is a derived cache with
  provenance/version—not authority. List reads state `ready`, `refreshing` or
  `failed`; a failed or stale cache cannot masquerade as a complete segment.
- Add `crm_list_create`/`crm_list_update` kind+definition inputs, dynamic-list
  status/read tools, and a `crm://schema`/`crm://lists` explanation of its
  object scope and freshness. MRTR protects turning a static list into a dynamic
  one and list deletion.
- Tests include cross-tenant candidates, private source records, relationship
  and activity/event predicates, empty sets, write storms, cancellation/retry,
  redefinition, static-list non-regression, idempotent replay and audit chain.

**Acceptance:** API and worker DB suites pass; MCP harness creates a dynamic
company list for a typed filter, changes one qualifying record, waits via the
published task/status path, and sees exactly the entitlement-visible members.
`pnpm docs:mcp && git diff --exit-code docs/mcp-surface.md` exits 0.
**Docs:** `docs/schema-engine.md` §§2, 5; `docs/mcp-surface.md` §§1, 5.

---

### T61 ✅ — Files, attachments and immutable behavioural events

**Depends on:** T60. **Spec:** this file; `docs/schema-engine.md` §§2, 4, 5,
8; `docs/spec/events.md`.

**Files:**

- Create generic storage-provider seams and `files`/`file_links` services. A
  file stores provider/key, metadata, checksum and creator—not blobs in
  PostgreSQL. Link files to records, activities or events using a typed purpose;
  storage access is authorized before minting a short-lived URL. Erasure and
  retention delete provider objects only through an auditable/retry-safe job.
- Create immutable generic behavioural event services and event-type definitions:
  stable external id/source, occurred time, subject record/actor and validated
  typed properties. Events are append-only; correction means a separately linked
  correction event, never update/delete. No natural-language interpretation or
  content classification is added.
- Provide `crm_file_register`, `crm_file_link`, `crm_file_list`, `crm_event_type_define`,
  `crm_event_ingest` and `crm_events_query`; use task handles for bulk ingestion.
  File/event tools must disclose storage/retention and conflict errors. Timeline,
  search and dynamic-list inputs only surface fields that their policy permits.
- Tests cover MIME/size/checksum validation, tenant/visibility enforcement,
  content-free audit/log/error output, event external-id idempotency, ordered
  event cursors, append-only enforcement, attachment access expiry, erasure,
  webhook redaction and worker retry/cancellation.

**Acceptance:** API, engine and worker DB suites pass; MCP harness registers and
links a file, ingests a `product.feature_used` event, queries it from a permitted
principal and receives `NOT_FOUND` from another tenant. `pnpm docs:mcp && git
diff --exit-code docs/mcp-surface.md` exits 0. **Docs:**
`docs/schema-engine.md` §§2, 4, 5, 8; `docs/mcp-surface.md` §§1, 3, 6, 8.

---

### T62 ✅ — Association limits, attribute groups and actor-role semantics

**Depends on:** T61. **Spec:** this file; `docs/schema-engine.md` §§2–5;
`docs/mcp-surface.md` §§1–4.

**Files:**

- Implement relation active-edge limits from T57 with transaction-scoped
  topology locks. Limit failures name the relation/label and configured bound
  but reveal no inaccessible record IDs. Cardinality replacement, direct links
  and record-reference projections share exactly one enforcement path.
- Implement ordered `attribute_groups` as display/schema metadata only. Group
  archive/reorder must not alter data values or bypass visibility/sensitivity;
  attributes have at most one group within an object type and ungrouped fields
  remain valid.
- Extend `actor_reference` config with explicit, immutable semantics:
  `owner`, `collaborator`, `assignee`, `created_by` or `modified_by`. Reuse UOA
  references and `principal_last_seen`; do not persist UOA profile or membership
  copies. Define exactly which role semantics grant edit capability, and enforce
  it in policy rather than treating arbitrary actor IDs as authorization.
- Add relation-limit fields to `crm_relation_type_define/update`, group tools,
  actor-role-aware attribute definition, and schema-resource detail. Migration
  checks existing active edges first and requires MRTR plus a resolution plan if
  lowering a limit would violate live data.
- Test concurrent limit races, hidden-record error shape, labelled limits,
  projection links, group ordering/archives, absent/stale actors, role-derived
  permissions, cross-tenant actor references and audit/change ordering.

**Acceptance:** engine and API DB suites pass; MCP harness defines a CEO relation
with `max_active_edges_from: 1`, proves a second link fails without leaking the
first person, groups a field, and verifies an explicit collaborator role through
policy. `pnpm docs:mcp && git diff --exit-code docs/mcp-surface.md` exits 0.
**Docs:** `docs/schema-engine.md` §§2–5; `docs/mcp-surface.md` §§1–4.

---

### T63 ✅ — Standard sales and service templates

**Depends on:** T62. **Spec:** this file; `docs/schema-engine.md` §9;
`docs/mcp-surface.md` §§1–3, §6.

**Files:**

- Add idempotent template packages `standard_sales` and `standard_service`, and
  extend `standard_crm` only with a non-breaking lifecycle attribute on person
  and company. Lifecycle is tenant-customizable shipped schema data, distinct
  from a deal/lead/ticket pipeline; it is never a hard-coded state machine.
- `standard_sales` defines `lead` (not another person) with qualification and
  disqualification lifecycle, ownership and its own pipeline, plus relations to
  person, company and deal. It preserves multiple pursuits for one person.
- `standard_service` defines `ticket` with subject, description, priority,
  category, source/channel, open/close/SLA/first-response/resolution fields and
  its own pipeline; relations connect ticket to person, company, deal, product,
  other tickets and generic activities/tasks.
- Add standard activity schemas over the existing generic activity object rather
  than physical activity tables: email, call, meeting and message fields
  (including direction, participants, timing/outcome and external/thread refs).
  Store transcript/attachment references only when policy/sensitivity permits.
- Extend template discovery and tool/schema docs. Tests prove repeated apply is
  additive/no-op, existing custom slugs are untouched, matching is structural
  only, lifecycle/pipeline are distinct, rich activity values redact correctly,
  and all template writes are tenant-scoped and audited.

**Acceptance:** template/engine/API DB suites pass; MCP harness applies each
template twice, creates one person with two leads, a ticket and call/email/meeting
activities, and reads only permitted timeline details. `pnpm docs:mcp && git
diff --exit-code docs/mcp-surface.md` exits 0. **Docs:**
`docs/schema-engine.md` §9; `docs/mcp-surface.md` §§1–3, §6.

---

### T64 ✅ — Product and line-item revenue foundation

**Depends on:** T63. **Spec:** this file; `docs/schema-engine.md` §§3–5, §9;
`docs/mcp-surface.md` §§2–4.

**Files:**

- Add an idempotent `standard_commerce` template package beginning with generic
  `product` and `line_item` object types. Product holds current catalogue data;
  line item holds a historical commercial snapshot (SKU, description, quantity,
  unit price/cost, currency, discount, tax, billing frequency/start/terms and
  total). Never model a deal as `products[]`.
- Define typed line-item relations to product and commercial parents. Enforce
  a line-item snapshot at creation: product changes do not rewrite historical
  line items; explicit correction is an audited record update. Use existing
  currency rules and fixed-currency protections rather than unsafe arithmetic.
- Add derived templates/attributes for common commercial totals only through T59
  rollups; define how multi-currency aggregation is rejected or grouped rather
  than silently summed. Support product-based dynamic segments from T60.
- Add/extend MCP schema/template/record guidance so an agent can distinguish
  catalogue product updates from a commercial line-item snapshot. Tests cover
  product price change preservation, discount/tax validation, parent deletion
  behavior, constrained links, access redaction, duplicate/replay and worker
  refresh correctness.

**Acceptance:** engine/API/worker DB suites pass; MCP harness creates a product,
two price-distinct line items for it, links them to a deal, and proves the first
snapshot is unchanged after the product price changes. `pnpm docs:mcp && git
diff --exit-code docs/mcp-surface.md` exits 0. **Docs:**
`docs/schema-engine.md` §§3–5, §9; `docs/mcp-surface.md` §§1–4.

---

### T65 — Quote, subscription, invoice, payment and order templates

**Depends on:** T64. **Spec:** this file; `docs/schema-engine.md` §9;
`docs/mcp-surface.md` §§1–4, §8.

**Files:**

- Extend `standard_commerce` idempotently with `quote`, `subscription`,
  `invoice`, `payment` and `order` object types, their required commercial
  attributes, lifecycle/pipeline choices where appropriate, and typed relations
  to company, person, deal and line item. Do not add checkout, card processing
  or a local payment credential store.
- Define the revenue graph contract: a line item may be copied into a quote,
  order, invoice or subscription as a snapshot; subsequent product/parent edits
  never rewrite it. Payment records hold provider references/status/amount only;
  secrets, bank/card data and raw provider payloads are rejected.
- Give templates deterministic matching/unique assertions only for structural
  external references and make imports use `crm_record_assert`/bulk tasks. Add
  dynamic segment examples such as buyers of SKU X without an active support
  subscription, subject to visibility and policy.
- Tests cover package idempotence and mixed installation order; every graph edge
  direction/cardinality/delete rule; copied snapshot isolation; currency and
  amount rules; payment-data rejection; tenant/visibility redaction; history,
  audit, webhook and bulk-import worker behavior.

**Acceptance:** engine/API/worker DB suites pass; MCP harness applies commerce,
creates and links a quote, subscription, invoice, payment and order with line
items, then returns the permitted segment result without exposing another
tenant's revenue data. `pnpm docs:mcp && git diff --exit-code
docs/mcp-surface.md` exits 0. **Docs:** `docs/schema-engine.md` §9;
`docs/mcp-surface.md` §§1–5, §8.

---

### T66 — MCP schema discoverability and compatibility fixture

**Depends on:** T65. **Spec:** this file; `docs/mcp-surface.md`; all T57–T65
contracts.

**Files:**

- Regenerate the MCP surface from registration and make `crm://schema`,
  `crm://templates`, `crm://help/filtering`, `crm://help/limits` and any new
  resource expose every Phase 8 capability. Document the choice point between
  static/dynamic lists, product/line item, activity/event, ordinary/derived
  attributes and pipeline/lifecycle.
- Create a versioned, local compatibility fixture representing the supplied
  benchmark vocabulary: person/contact, company, deal, ticket, lead, product,
  line item, quote, subscription, invoice, payment, order, lists/segments,
  calls/emails/meetings/notes/tasks and their named associations. It is a
  DeepCRM fixture—not a scraped or network-fetched third-party contract.
- Create an MCP harness suite that discovers tools/resources first, applies
  relevant packages, imports the fixture through supported tools, reads it back,
  tests association/history/pipeline/derived/list behavior, and checks schema
  descriptions/field docs. Include invalid, hidden and cross-tenant cases.
- Update `docs/testing.md` with the fixture invocation and manual-verification
  prerequisites; no production endpoint, credentials or third-party server is
  contacted by this task.

**Acceptance:** `pnpm verify` passes; `pnpm docs:mcp && git diff --exit-code
docs/mcp-surface.md` exits 0; the compatibility harness imports and round-trips
the local fixture through MCP with no `NOT_YET` tools; `git diff --check` exits
0. **Docs:** `docs/mcp-surface.md`; `docs/testing.md`; this file.

---

### T67 — Full endpoint and worker regression loop

**Depends on:** T66. **Spec:** `docs/testing.md`; `docs/mcp-surface.md`; this
file.

**Files:** create `scripts/verify-crm-semantic-loop.mjs` and
`docs/done/phase-8-regression.md` only after the loop is green.

- The script starts isolated API/worker processes on allocated per-worktree
  ports, waits for `/health`, provisions a unique disposable database, migrates
  it, runs every registered MCP tool with valid discovery-first arguments from
  the compatibility fixture, then exercises each failure/authorization branch
  named in T57–T66. It must capture command, tool/resource names, status and
  redacted result shape—not payload values.
- Run the loop repeatedly until one complete pass has no failures. A failing
  endpoint is fixed in its owning prior task scope/branch, merged, then the full
  loop restarts; do not mark this task done on a partial green subset. Verify
  worker queues drain or reach an explicit terminal state and that the audit
  chain verifier passes after every complete pass.
- Write `docs/done/phase-8-regression.md` only from the successful final run:
  commit SHA, disposable database name, tool/resource inventory, endpoint
  results, worker jobs, audit verification and cleanup confirmation. Do not put
  raw CRM, event or file data in the transcript.

**Acceptance:** `pnpm verify`, `node scripts/verify-audit-chain.mjs` and
`node scripts/verify-crm-semantic-loop.mjs` exit 0; `curl -sf
http://localhost:<allocated-port>/health` succeeded after the final restart;
the exact disposable database is dropped and no API/worker process remains.
**Docs:** `docs/testing.md`; `docs/done/phase-8-regression.md`.

---

### T68 — Human MCP interoperability acceptance (HUMAN-GATED)

**Depends on:** T67. **Spec:** this file; `docs/done/phase-8-regression.md`.

**This task is executed by a human or with explicit human approval in the
session. An agent must stop and ask before starting it.**

Using an authenticated non-production tenant and an MCP client, a human performs
the following discover-first flow: inspect `tools/list` and `crm://templates`;
install core/sales/service/commerce packages; create a company/person, lead,
deal pipeline/stage, ticket, activity, product and historical line item; create
a dynamic segment; attach a file; ingest an event; create a quote, subscription,
invoice, payment and order; and retrieve the resulting graph, history and
derived values. The human also checks a lower-privilege principal cannot discover
or retrieve a private/restricted sample, and confirms an invalid direct write to
a derived property fails.

Record redacted tool names, response shapes, commit SHA, client/version, tenant
test identifier and pass/fail evidence in `docs/done/phase-8-mcp-smoke.md`.
No credentials, raw customer data, signed URLs or secrets may be recorded.

**Acceptance:** the transcript proves every flow above through the MCP client,
`/health` answers after the client session, `node scripts/verify-audit-chain.mjs`
passes against the non-production test database, and the transcript has no
secrets or raw CRM data. **Docs:** `docs/done/phase-8-mcp-smoke.md`.
