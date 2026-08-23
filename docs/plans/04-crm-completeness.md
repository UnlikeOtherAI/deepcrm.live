# Phase 4 — CRM completeness

Outcome: activities, notes, tasks, timeline, pipeline summary, lists/views, the worker reindex job with `last_activity_at`, the change feed and webhooks. After this phase the CRM is usable end to end by an agent.

### T27 — Activities and notes

**Depends on:** T26. **Spec:** `docs/mcp-surface.md` §6 (`crm_activity_log`, `crm_note_add`); `docs/schema-engine.md` §9 system types.

**Files:**
- Create `api/src/services/activity.ts` — `logActivity(ctx, input)`: idempotent on `external_ref` (unique attribute on `activity`) via `assertRecord`; links each `about` record through `activity_about`; `addNote` likewise with `note_about`. Both bump `records.last_activity_at = occurred_at` on the `about` records (direct update in the same tx, plus a `set` change on `last_activity_at`? — **No**: `last_activity_at` is a system column, not in `data`; update the column only).
- Create `api/src/mcp/tools/activity.ts` — register `crm_activity_log`, `crm_note_add`.
- Tests (harness): log a call about a person and a company; re-log with the same `external_ref` returns the same record id; `last_activity_at` updated on both.

**Acceptance:** api tests green; remove the two tools from `NOT_YET`.

---

### T28 — Tasks

**Depends on:** T27. **Spec:** `docs/mcp-surface.md` §6 (`crm_task_create/update`, `crm_tasks_list`).

**Files:** extend `services/activity.ts` (or create `services/tasks.ts` if activity.ts would exceed 300 lines) and `mcp/tools/activity.ts`; `crm_tasks_list` compiles to a `crm_records_query` on `task` with filters on `status`, `assignee`, `due_at`, and `linked_to task_about`. Tests: create assigned to `{type:'agent', id:'agent_dev'}`, list by assignee, update status to `done`.

**Acceptance:** api tests green; `NOT_YET` shrinks by 3.

---

### T29 — Timeline

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
- Create `api/src/mcp/tasks.ts` — MCP Tasks extension adapter: `tasks/get { taskId }` → `queue_jobs` row mapped to `{ status: working|completed|failed|cancelled, progress, result }`; `tasks/cancel`. Register the extension capability on the server (`io.modelcontextprotocol/tasks`) per SDK 1.30 API.
- Create `worker/src/jobs/bulk-assert.ts` — iterates rows with `assertRecord` in batches of 100 transactions, `progress({ done, total })`, result per §3. Register in `jobs/registry.ts`.
- Tool `crm_records_bulk_assert` enqueues (`LIMIT_EXCEEDED` above `DEEPCRM_MAX_BULK_ROWS`) and returns `{ task_id }`.
- Tests: pipeline summary over seeded stage moves; bulk assert of 250 rows through the harness + embedded worker, `tasks/get` reaches `completed` with `created: 250`.

**Acceptance:** api + worker tests green.

---

### T31 — Lists and views

**Depends on:** T30. **Spec:** `docs/mcp-surface.md` §5.

**Files:** `api/src/services/lists.ts`, `api/src/mcp/tools/lists.ts` (6 tools). List attributes validated with the same `validateRecordData` against the list's attribute set (the engine's `objectType` parameter accepts a `ListSchema` shape — extend `LoadedSchema` with `lists`). `crm_view_run` = stored filter → `queryRecords`. Tests: list with `priority` entry attribute; view saved and run returns the same ids as the direct query.

**Acceptance:** api tests green.

---

### T32 — Reindex job, search content, last_activity maintenance

**Depends on:** T31. **Spec:** `docs/schema-engine.md` §8; `docs/architecture.md` §1.

**Files:**
- Create `packages/schema-engine/src/search/content.ts` — `buildSearchContent(schema, record, links)` per §8 (excludes confidential/restricted).
- Create `packages/schema-engine/src/search/embedder.ts` — `Embedder` interface `{ embed(texts: string[]): Promise<number[][]>; model: string }`; `LedgerEmbedder` (POST `${LEDGER_PUBLIC_URL}/v1/jina/embeddings` with bearer, `dimensions: EMBEDDING_DIMENSIONS`, asserts returned width); `FakeEmbedder` (sha256 → 1024 floats, deterministic) for tests/dev when `LEDGER_PROXY_TOKEN` unset.
- Create `worker/src/jobs/record-reindex.ts` — load record + active links, write `record_search` (`content`, `embedding` via `$executeRaw` with `::vector`), `embedding_model`. Register.
- Edit `records/write.ts` — every write already enqueues `record.reindex` (T13); verify links writes do too (edit `links/write.ts` to enqueue for both ends).
- Tests (worker DB): after create + link, `record_search.content` contains the company name; vector length 1024.

**Acceptance:** worker tests green.

---

### T33 — Change feed tool

**Depends on:** T32. **Spec:** `docs/mcp-surface.md` §8 (`crm_changes_since`).

**Files:** `api/src/services/io.ts` (`changesSince(ctx, { cursor, object_types, kinds, limit })` keyset on `seq`, redaction of restricted values), tool in `api/src/mcp/tools/io.ts`. Cursor = string of the last `seq`. Tests: cursor walk over 120 changes yields each exactly once; `has_more` false at end.

**Acceptance:** api tests green.

---

### T34 — Webhooks and delivery job

**Depends on:** T33. **Spec:** `docs/mcp-surface.md` §8 (webhook tools + payload); `docs/architecture.md` §4 (`safeFetch`).

**Files:**
- Create `packages/schemas/src/net/safe-fetch.ts` — port of nessie's guard: resolve host, reject private/loopback/link-local ranges, pin via undici `Agent` `connect.lookup`, re-validate on each redirect (max 3). Unit tests with fake resolver.
- Create `packages/schemas/src/crypto/secret-box.ts` — AES-256-GCM with keyring from `DEEPCRM_SECRET_KEYRING_B64` (`{ active: kid, keys: { kid: base64 } }`), `seal`/`open`.
- Create `api/src/services/webhooks.ts` — set/list/delete; secret generated server-side (32 bytes hex), sealed, returned once.
- Create `worker/src/jobs/change-deliver.ts` — for each active webhook of the team: select changes `seq > last_delivered_seq` (≤ 500), POST with HMAC-SHA256 signature over the body, on 2xx advance `last_delivered_seq`, else `fail` with backoff schedule from §8 and `last_error`. Register. The write path's `change.deliver` enqueue (T13, idempotency per team per 30 s) already exists — verify `visibleAt = now + 30s`.
- Tools `crm_webhook_set/list/delete` (admin policy).
- Tests: in-process Fastify receiver; signature verifies; a 500 receiver leads to a retry with `attempts = 1`; private IP url rejected at `crm_webhook_set`.

**Acceptance:** api + worker + schemas tests green; `NOT_YET` now contains only §7 tools and `crm_export`.
