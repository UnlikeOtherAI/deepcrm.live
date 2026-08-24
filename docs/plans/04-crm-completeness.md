# Phase 4 — CRM completeness

Outcome: activities, notes, tasks, timeline, pipeline summary, lists/views, the worker reindex job with `last_activity_at`, the change feed and webhooks. After this phase the CRM is usable end to end by an agent.

### T27 ✅ — Activities and notes

**Depends on:** T26. **Spec:** `docs/mcp-surface.md` §6 (`crm_activity_log`, `crm_note_add`); `docs/schema-engine.md` §9 system types.

**Files:**
- Create `api/src/services/activity.ts` — `logActivity(ctx, input)`: idempotent on `external_ref` (unique attribute on `activity`) via `assertRecord`; links each `about` record through `activity_about`; `addNote` likewise with `note_about`. Both bump `records.last_activity_at = greatest(last_activity_at, occurred_at)` on the `about` records (a system column, not in `data`; no change row — out-of-order logging cannot move it backwards).
- Create `api/src/mcp/tools/activity.ts` — register `crm_activity_log`, `crm_note_add`.
- Tests (harness): log a call about a person and a company; re-log with the same `external_ref` returns the same record id; `last_activity_at` updated on both.

**Acceptance:** api tests green; remove the two tools from `NOT_YET`.

---

### T28 ✅ — Tasks

**Depends on:** T27. **Spec:** `docs/mcp-surface.md` §6 (`crm_task_create/update`, `crm_tasks_list`).

**Files:** extend `services/activity.ts` (or create `services/tasks.ts` if activity.ts would exceed 300 lines) and `mcp/tools/activity.ts`; `crm_tasks_list` compiles to a `crm_records_query` on `task` with filters on `status`, `assignee` (JSONB equality on the canonicalised actor object — schema-engine §5), `due_at`, and `linked_to task_about`. Tests: create assigned to `{type:'agent', id:'agent_dev'}`, list by assignee, update status to `done`.

**Acceptance:** api tests green; `NOT_YET` shrinks by 3.

---

### T29 ✅ — Timeline

**Depends on:** T28. **Spec:** `docs/mcp-surface.md` §6 (`crm_record_timeline`).

**Files:**
- Create `packages/schema-engine/src/timeline/query.ts` — `timeline(tx, tenant, schema, recordId, { hops, kinds, since, cursor, limit })`: UNION of (a) activity/note/task records linked via `*_about` to the record (and, with `hops=1`, to records linked to it by any active link), (b) `record_changes` of the record; ordered by `occurred_at desc, id`; cursor keyset.
- Service + tool registration; redaction applies to change values.
- Tests: company timeline with `hops:1` includes a call logged about its person.

**Acceptance:** api tests green.

---

### T30 — Pipeline summary and bulk assert Task

**Depends on:** T29. **Spec:** `docs/mcp-surface.md` §6 (`crm_pipeline_summary`), §3 (`crm_records_bulk_assert`), §0.5.

**Files:**
- Create `packages/schema-engine/src/pipeline/summary.ts` — per stage: `count` (live records), `amount_sum` (when `amount_attribute`), `avg_days_in_stage` from consecutive `set` changes on the status attribute; `conversions` from `old_value → new_value` pairs since `since`.
- Create `api/src/mcp/tasks.ts` — MCP Tasks adapter: `tasks/get { taskId }` maps the tenant-scoped `queue_jobs` row to the full SDK Task shape (safe progress is summarized in `statusMessage`); `tasks/cancel` returns the full cancelled Task; `tasks/result` returns the original completed `tools/call` result; tenant mismatch and system jobs are `NOT_FOUND`; `tasks/update` answers −32601. Advertise standard `tasks.cancel` and `tasks.requests.tools.call`, retaining the named extension capability for compatibility.
- Create `worker/src/jobs/bulk-assert.ts` — iterates rows with `assertRecord` in batches of 100 transactions, `progress({ done, total })`, result per §3. Register in `jobs/registry.ts`.
- Tool `crm_records_bulk_assert` enqueues (`LIMIT_EXCEEDED {limit}` above `DEEPCRM_MAX_BULK_ROWS`; payload rows carry derived per-row idempotency keys so batch retries skip completed rows) and returns SDK `CreateTaskResult` (`{ task: Task }`, camel `taskId`) with compatible text poll guidance.
- Tests: pipeline summary over seeded stage moves; bulk assert of 250 rows through the harness + embedded worker, `tasks/get` reaches `completed` with `created: 250`.

**Acceptance:** api + worker tests green.

---

### T31 — Lists and views

**Depends on:** T30. **Spec:** `docs/mcp-surface.md` §5.

**Files:** `api/src/services/lists.ts`, `api/src/mcp/tools/lists.ts` (7 tools incl. `crm_view_delete`) and register `crm_records_count` + `crm_records_get_many` in `tools/records.ts` (shrinking `NOT_YET` accordingly). List attributes validated with `validateRecordData` against the list's attribute set (extend `LoadedSchema` with `lists`; **list-attribute mutations bump `teams.schema_version`** like any schema change, so the cache stays honest). `crm_view_run` = stored filter → `queryRecords`; views appear in `SchemaSnapshot.views` and `crm://views`. Tests: list with `priority` entry attribute; view saved, run, listed, deleted; count matches; get_many reports `missing`.

**Acceptance:** api tests green.

---

### T32 — Reindex job, search content, last_activity maintenance

**Depends on:** T31. **Spec:** `docs/schema-engine.md` §8; `docs/architecture.md` §1.

**Files:**
- Create `packages/schema-engine/src/search/content.ts` — `buildSearchContent(schema, record, links)` per §8 (excludes confidential/restricted).
- Create `packages/schema-engine/src/search/embedder.ts` — `Embedder` interface `{ embed(texts: string[]): Promise<number[][]>; model: string }`; `LedgerEmbedder` (POST `${LEDGER_PUBLIC_URL}/v1/jina/embeddings` with bearer, `dimensions: EMBEDDING_DIMENSIONS`, asserts returned width); `FakeEmbedder` (sha256 → 1024 floats, deterministic) for tests/dev when `LEDGER_PROXY_TOKEN` unset.
- Create `worker/src/jobs/record-reindex.ts` — load record + active links, write `record_search` (`content`, `embedding` via `$executeRaw` with `::vector`), `embedding_model`. Register.
- Both enqueues exist since T13 (§4 step 14); verify link writes enqueue reindex for **both ends** (they bump both versions, so the seq-keyed idempotency is naturally unique).
- Tests (worker DB): after create + link, `record_search.content` contains the company name; vector length 1024.

**Acceptance:** worker tests green.

---

### T33 — Change feed tool

**Depends on:** T32. **Spec:** `docs/spec/events.md` §1–§2; `docs/spec/contracts.md` (`Change`).

**Files:** `api/src/services/io.ts` (`changesSince(ctx, { cursor, from, object_types, kinds, limit })` keyset on the per-team `seq`; no cursor ⇒ empty page + fresh cursor at now; `from: "beginning"` opts into history; redaction per events.md §1), tool in `api/src/mcp/tools/io.ts`. Tests: no-cursor call returns empty + cursor; `from: beginning` walk over 120 changes yields each exactly once (including both rows of a link with shared `group_id`); `has_more` false at end.

**Acceptance:** api tests green.

---

### T34 — Webhooks and delivery job

**Depends on:** T33. **Spec:** `docs/spec/events.md` §3–§4 (envelope, signature, retry table, DeliveryTarget seam — implement the seam, ship only the webhook target); `docs/architecture.md` §4 (`safeFetch`).

**Files:**
- Create `packages/schemas/src/net/safe-fetch.ts` — port of nessie's guard using `undici` (dep added in T01): resolve host, reject private/loopback/link-local ranges, pin via `Agent` `connect.lookup`, refuse redirects, port 443 only, no userinfo; re-validated on **every delivery attempt**. Unit tests with a fake resolver.
- Reuse T15's `packages/schemas/src/crypto/secret-box.ts` AES-256-GCM keyring seam; do not create a webhook-only crypto implementation. Webhook ciphertext uses its own purpose-bound authenticated additional data.
- Create `api/src/services/webhooks.ts` — set (upsert by URL; `rotate_secret` mints anew; **new webhooks start at the current max seq**; owner + approval per policy)/list/delete; secret generated server-side, sealed with a `kid`-versioned keyring, returned once flagged as secret material.
- Create `worker/src/jobs/change-deliver.ts` — per active webhook (advisory lock namespace 4): select changes `seq > last_delivered_seq` (≤ 500/batch, ≤ 10 batches/run, `backlog_remaining` in the envelope), POST via `safeFetch` with the HMAC signature from `docs/spec/events.md` **§3**, on 2xx advance `last_delivered_seq`, else retry per the §3 backoff table then `active=false` + `last_error`. Register. The `change.deliver` enqueue exists since T13 (§4 step 14).
- Tools `crm_webhook_set/list/delete` (admin policy).
- Tests: in-process receiver; signature verifies; new webhook receives only post-registration changes; a 500 receiver retries (`attempts = 1`); private-IP URL rejected at set **and** at delivery time (flip the fake resolver between the two).

**Acceptance:** api + worker + schemas tests green; `NOT_YET` now contains only the §7 tools and `crm_export`.
