# MCP surface

The product. One streamable-HTTP endpoint, MCP spec **2026-07-28**, stateless. Tool names, descriptions and schemas here are normative; code registers exactly these, and `pnpm docs:mcp` regenerates the tables in §2–§8 from the registrations.

## 0. Conventions

### 0.1 Transport & protocol conformance (MCP 2026-07-28, normative)

- `POST /mcp` — one JSON-RPC request per HTTP request. `GET`/`DELETE /mcp` ⇒ 405; `subscriptions/listen` is **not implemented** (−32601) — staleness is signalled by `ttlMs` and by `SCHEMA_CONFLICT`/`UNKNOWN_ATTRIBUTE` errors.
- **Required headers:** `Mcp-Method` and `Mcp-Name` on every POST (mismatch with the body ⇒ `HeaderMismatchError` −32020). **Required `_meta` on every request:** `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` (missing ⇒ −32602; unsupported version ⇒ `UnsupportedProtocolVersionError` −32022). Every result carries `_meta["io.modelcontextprotocol/serverInfo"]`.
- **`server/discover` is implemented** (spec MUST): advertises supported protocol versions (`2026-07-28`), capabilities including `extensions: { "io.modelcontextprotocol/tasks": {} }`, server identity, and DeepCRM limits metadata (`maxBulkRows`, `maxFilterNodes`, page caps).
- **Every result carries `resultType`**: `"complete"` for ordinary results, `"input_required"` for MRTR interim results, task-shaped results per the Tasks extension.
- **Cacheable results**: `tools/list`, `prompts/list`, `resources/list`, `resources/read`, `resources/templates/list` carry **top-level** `ttlMs: 300000` and `cacheScope: "private"` (never `"public"` — everything is tenant data). The schema version rides in vendor `_meta["live.deepcrm/etag"]`; the tool list's etag is the server build, since tools don't vary with tenant schema.
- Tools are registered and listed in the fixed order of §2–§8 (deterministic order for prompt-cache hits).
- Server identity: `{ name: "deepcrm", version: <package version> }`.

### 0.2 Argument conventions

- Object types, attributes, relation types, lists, views and templates are addressed by **slug**; records, links, changes and tasks by id.
- Every mutating tool accepts optional `reason: string` (stored on the change) and `idempotency_key: string` (replay-safe 24 h, bound to the calling principal and tool).
- Writes to an existing record accept `expected_version: number`.
- `limit` defaults 50, max 200. Cursors are opaque and **bound to (tool, tenant, argument set)**; reusing one with different arguments fails with `VALIDATION_FAILED {detail: "cursor_mismatch"}`. The change-feed cursor (`crm_changes_since`) is a distinct kind — a plain decimal seq — and is documented as such on that tool.
- In `data` patches: `null` unsets a value (rejected on required attributes), `[]` sets an empty list. Redacted attributes are absent from reads and rejected by name when written back.

### 0.3 Result conventions

- Results are `structuredContent` JSON; `content[0].text` carries **the serialized JSON of the same payload** (spec guidance — text-only clients still see ids and cursors).
- A **record** renders as `{ id, object_type, display_name, version, data, owner, created_at, updated_at, last_activity_at, redacted_attributes: [], links?, redirected_from? }`. Every embedded record (timeline items, link `related`, candidates, hits, feed events) passes the same redaction as a primary read.
- Errors: `isError: true`, `structuredContent: { code, message, next, ...details }` with codes from `schema-engine.md` §10. `next` is a machine hint: `retry_with_approval | fetch_and_retry | use_redirect | fix_input | fatal`.

### 0.4 Multi round-trip (MRTR) — confirmations and approvals

Spec-shaped (2026-07-28 MRTR pattern). When a call needs a decision, the result is:

```json
{ "resultType": "input_required",
  "inputRequests": {
    "confirm": { "method": "elicitation/create",
      "params": { "mode": "form",
        "message": "Archiving attribute 'fax' will hide 12 existing values. Proceed?",
        "requestedSchema": { "type": "object",
          "properties": { "confirmed": { "type": "boolean" } }, "required": ["confirmed"] } } } },
  "requestState": "<AEAD blob>" }
```

- `inputRequests` values are standard `elicitation/create` requests only (the client fulfils them; `elicitation` must be in the client's declared capabilities, else the server returns a plain error explaining the required capability).
- **`requestState` is always present and AEAD-protected**, encoding: principal (app + uoaUserId), tool name, canonical arguments hash, an impact summary, a TTL — and for approvals the approval id. Tampered or expired state is rejected; state from a different principal or different arguments is rejected. Single-use consumption (approvals) is additionally enforced server-side against the `approval_requests` row.
- The client retries the **same** `tools/call` with `inputResponses` (a map of `ElicitResult`s keyed like `inputRequests`) and the echoed `requestState`, both at **params level, sibling to `arguments`** — the server unwraps them before argument validation:

```json
{ "method": "tools/call", "params": {
    "name": "crm_attribute_archive",
    "arguments": { "object_type": "person", "attribute": "fax" },
    "inputResponses": { "confirm": { "action": "accept", "content": { "confirmed": true } } },
    "requestState": "<echoed>" } }
```

- **Approvals** are the same shape with an elicitation asking the approving admin/owner for `{ approved: boolean, note? }`; the retry must arrive under a delegation whose `role` satisfies `required_role` exactly, from a different human than the original requester. The executed arguments come from the stored approval snapshot, not the retry body (auth-and-tenancy §4). Approval requests expire after 24 h.

### 0.5 Long-running work — Tasks extension

`crm_records_bulk_assert`, `crm_find_duplicates`, `crm_export` return task-shaped results per `io.modelcontextprotocol/tasks` (the extension allows unsolicited task handles; wire field `taskId`). Clients poll `tasks/get { taskId }` — mapped to `queue_jobs.{status, progress, result}` **in the caller's tenant only** (`NOT_FOUND` otherwise); `tasks/cancel` cancels a queued job and requests cooperative stop of a running one (status `cancelled`). `tasks/update` is not supported in v1. Clients without the extension get the text-summary poll guidance and can call `tasks/get` anyway (it is a plain method).

## 1. Resources

| URI | Content |
|---|---|
| `crm://schema` | `{ schema_version, object_types: [ObjectTypeSummary], relation_types: [...], matching_rules: [...], views: [ViewSummary] }` |
| `crm://schema/{object_type}` | full `ObjectTypeDetail` (attributes with type, config, flags, sensitivity, description) |
| `crm://templates` | available template slugs with descriptions (the live registry — `crm_template_apply` validates against it) |
| `crm://views` | index of saved views (slug, name, object type) |
| `crm://views/{slug}` | a saved view's definition |
| `crm://help/filtering` | the filter grammar: op-by-type table + three worked examples (in-band copy of `schema-engine.md` §5) |
| `crm://help/limits` | numeric caps: bulk rows, filter nodes, page sizes, export rows |

Template URIs (`crm://schema/{object_type}`, `crm://views/{slug}`) are registered via `resources/templates/list` with RFC 6570 `uriTemplate`s.

## 2. Schema tools

| Tool | Description (as registered) | Input | Output |
|---|---|---|---|
| `crm_schema_get` | Get the workspace data model: object types, their attributes, relation types and matching rules. Call this first in a session; cache by `schema_version`. | `{ object_type?: slug }` | `crm://schema` body or one `ObjectTypeDetail` |
| `crm_object_type_define` | Create a custom object type (a new kind of record, e.g. "subscription"). Attributes can be added now or later with `crm_attribute_define`. | `{ slug, singular_name, plural_name, description, icon?, attributes?: AttributeSpec[], primary_attribute?: slug }` | `ObjectTypeDetail` |
| `crm_object_type_update` | Rename or re-describe an object type, or change its primary attribute. | `{ object_type, singular_name?, plural_name?, description?, icon?, primary_attribute? }` | `ObjectTypeDetail` |
| `crm_object_type_archive` | Archive a custom object type. Records are kept but hidden; MRTR confirmation states the record count. | `{ object_type, reason? }` | `{ archived: true, records: n }` |
| `crm_attribute_define` | Add an attribute (field) to an object type. Use `record_reference` to relate to other object types. Unique attributes enable `crm_record_assert`. | `{ object_type, ...AttributeSpec }` | `AttributeDetail` |
| `crm_attribute_update` | Change an attribute's name, description, options, required/indexed/sensitivity flags. Type, slug **and `is_multi`** are immutable. Tightening reports violations via MRTR; normalize-affecting config changes require a key-recompute backfill; sensitivity raises trigger a reindex Task (schema-engine §3a). | `{ object_type, attribute, name?, description?, config?, is_required?, is_unique?, is_indexed?, sensitivity?, default_value? }` | `AttributeDetail` |
| `crm_attribute_archive` | Archive an attribute; values are retained in history. MRTR confirmation states how many records carry a value. | `{ object_type, attribute, reason? }` | `{ archived: true, records_with_values: n }` |
| `crm_relation_type_define` | Define a named, typed relationship between object types (e.g. person —works_at→ company) with cardinality and optional attributes on the link itself. All four cardinalities (`many_to_one`, `one_to_many`, `one_to_one`, `many_to_many`) are supported; a `record_reference` attribute owns exactly one backing relation, never shared (schema-engine §4f). | `{ slug, from_object_type: slug \| null, to_object_type: slug \| null, forward_name, inverse_name, description?, cardinality, on_delete?, edge_attributes?: AttributeSpec[] }` | `RelationTypeDetail` |
| `crm_relation_type_archive` | Archive a relation type; links are kept but inactive. | `{ relation_type, reason? }` | `{ archived: true, links: n }` |
| `crm_matching_rule_set` | Replace the duplicate-matching rules for an object type. Rules decide what `crm_record_create` does when a likely duplicate exists (block / warn / allow). | `{ object_type, rules: [{ attributes: [slug], method: exact\|normalized\|fuzzy, threshold?, action }] }` | `{ rules }` |
| `crm_template_apply` | Apply a schema template by slug (see `crm://templates`), e.g. `standard_crm`: people, companies, deals. Idempotent: existing slugs untouched. Unknown slug ⇒ `UNKNOWN_TEMPLATE {available}`. | `{ template: slug }` | `{ added: { object_types, attributes, relation_types } }` |

`AttributeSpec = { slug, name, description, type, config?, is_multi?, is_required?, is_unique?, is_indexed?, sensitivity?, default_value? }`. Policy: all `define` on `schema`.

## 3. Record tools

| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_record_create` | Create a record (one-off inserts; syncing or importing? use `crm_record_assert`; many rows? `crm_records_bulk_assert`). Inline `links` are atomic with the create. `visibility`/`visible_to` restrict who can see it (data-level, admins not exempt); `origin` declares the data's source class. Returns `duplicates` on `warn` matches; fails `DUPLICATE_FOUND` on unique/`block` collisions. | `{ object_type, data: {slug: value}, links?: [{ relation_type, to_record_id, data? }], owner?: Actor, reason?, idempotency_key? }` | `{ record, duplicates?: Candidate[] }` |
| `crm_record_update` | Patch attributes on a record. Keys set to `null` are cleared. Pass `expected_version` to avoid overwriting concurrent edits. | `{ id, data, owner?, expected_version?, reason?, idempotency_key? }` | `{ record }` |
| `crm_record_assert` | Create-or-update by a unique attribute (upsert) — the safe default for any sync or import. Multi-value match attribute: the first element is the key; other elements resolving to different records ⇒ `DUPLICATE_FOUND` with all candidates (merge cue). | `{ object_type, match_attribute: slug, data, links?, owner?, reason?, idempotency_key? }` | `{ record, created: boolean }` |
| `crm_record_get` | Fetch one record by id, or by a unique attribute value. Optionally include active links (grouped by relation) and the recent timeline. | `{ id? , object_type?, match_attribute?, value?, include_links?: boolean, include_timeline?: number }` | `{ record, links?, timeline? }` |
| `crm_records_query` | List records of one object type with a structured filter, sort and cursor (exact reads; use `crm_record_get` for one known record, `crm_search` for fuzzy/free-text). Grammar + examples: resource `crm://help/filtering`. | `{ object_type, filter?, sort?, attributes?: [slug], include_total?, cursor?, limit? }` | `{ records, next_cursor, total? }` |
| `crm_records_count` | Count records matching a filter — cheap and exact; use instead of paginating to count. | `{ object_type, filter? }` | `{ count }` |
| `crm_records_get_many` | Fetch up to 100 records by id in one call. | `{ ids: [uuid] }` | `{ records, missing: [uuid] }` |
| `crm_records_bulk_assert` | Upsert many rows by a unique attribute as a background Task (cap `DEEPCRM_MAX_BULK_ROWS`). Poll `tasks/get`. | `{ object_type, match_attribute, rows: [{ data, links? }], reason? }` | `{ task_id }` → result `{ created, updated, failed: [{ index, code, message }] }` |
| `crm_record_delete` | Soft-delete a record (restorable for the retention window). Links are ended per relation `on_delete`. Admin or approval. | `{ id, reason?, expected_version? }` | `{ deleted: true }` |
| `crm_record_restore` | Restore a soft-deleted record and its links. | `{ id }` | `{ record }` |
| `crm_record_at` | The record's attribute values as they were at a point in time, replayed from `set`/`unset` changes; reference state is reconstructed from link history (`links`, multi ordered by `position`), never from stored data (§4a). `version_at` derives from the latest change's `resulting_version` ≤ `at`. | `{ id, at: datetime }` | `{ record_at: { data, version_at, as_of, links } }` |
| `crm_record_history` | Field-level change history for one record (who changed what, when, why). To undo a bad change, read `old_value` here and apply a corrective `crm_record_update` — there is no automatic revert. The cursor is opaque and bound to the full argument set including `attributes` (§0.2). | `{ id, attributes?: [slug], cursor?, limit? }` | `{ changes: Change[], next_cursor }` |

## 4. Link tools

| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_link` | Relate two records through a relation type, optionally with link attributes (e.g. role, since). Cardinality is enforced: a `*_to_one` link replaces the existing one — the result names what was ended. | `{ relation_type, from_record_id, to_record_id, data?, label?, reason?, idempotency_key? }` | `{ link, ended_links: [link_id] }` |
| `crm_unlink` | End an active link (kept in history). The triple form targets the newest active link when more than one exists. | `{ link_id?, relation_type?, from_record_id?, to_record_id?, reason? }` | `{ link_id }` |
| `crm_links_list` | Active links of a record, optionally filtered by relation type and direction, with the related records' summaries. | `{ record_id, relation_type?, direction?: from\|to\|both, include_history?: boolean, cursor?, limit? }` | `{ links: [{ link, related: RecordSummary }], next_cursor }` |

## 5. Lists, views

| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_list_create` | Create a curated list of records (any object type, or mixed) with optional per-entry attributes — e.g. "Q4 target accounts" with a `priority` per entry. | `{ slug, name, description?, object_type?, attributes?: AttributeSpec[] }` | `ListDetail` |
| `crm_list_add` | Add records to a list with optional entry data. | `{ list, entries: [{ record_id, data? }] }` | `{ added: n }` |
| `crm_list_remove` | Remove records from a list. | `{ list, record_ids }` | `{ removed: n }` |
| `crm_list_entries` | Entries of a list with their records. | `{ list, cursor?, limit? }` | `{ entries: [{ entry, record }], next_cursor }` |
| `crm_view_save` | Save a reusable query (filter + sort + attributes) for an object type. | `{ slug, name, object_type, filter, sort?, attributes?, description? }` | `ViewDetail` |
| `crm_view_run` | Run a saved view. | `{ view, cursor?, limit? }` | same as `crm_records_query` |
| `crm_view_delete` | Delete a saved view. | `{ view }` | `{ deleted: true }` |

## 6. Activities, timeline, tasks, pipeline

| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_activity_log` | Log an interaction (email, call, meeting, message…) against one or more records. Idempotent on `external_ref`. Updates `last_activity_at` on linked records. | `{ kind, occurred_at, subject?, body?, direction?, participants?: Actor[], about: [record_id], external_ref?, reason? }` | `{ record }` (the activity record) |
| `crm_note_add` | Attach a note to one or more records. | `{ title?, body, about: [record_id] }` | `{ record }` |
| `crm_record_timeline` | Chronological activities and changes for a record; `hops: 1` also merges in linked records' items (policy-filtered; `limit` is total items — on large accounts filter by `relation_types` or `kinds`). | `{ id, hops?: 0\|1, relation_types?: [slug], kinds?: [activity\|change\|note\|task], since?, cursor?, limit? }` | `{ items: TimelineItem[], next_cursor }` |
| `crm_task_create` | Create a task linked to records, assigned to an agent or a human. | `{ title, body?, due_at?, assignee?: Actor, priority?, about?: [record_id] }` | `{ record }` |
| `crm_task_update` | Update a task's status, assignee, due date. | `{ id, status?, assignee?, due_at?, priority?, title?, body? }` | `{ record }` |
| `crm_tasks_list` | Tasks by status/assignee/due window. | `{ status?, assignee?: Actor, due_before?, due_after?, about?: record_id, cursor?, limit? }` | `{ records, next_cursor }` |
| `crm_pipeline_summary` | Stage-by-stage counts, amounts and average time-in-stage for any object type with a `status` attribute (e.g. deals). Derived from history. | `{ object_type, status_attribute?: slug, amount_attribute?: slug, filter?, since? }` | `{ stages: [{ id, label, category, count, amount_sum?, avg_days_in_stage }] , conversions: [{ from, to, count }] }` |

## 7. Search, quality, merge

| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_search` | Free-text or by-example search: `query` text (keyword/semantic/hybrid) **or** `similar_to` (nearest neighbours of an existing record's embedding — "companies like this one"). Single-page, ranked; recently changed linked records may lag the index briefly. Exact lookups: `crm_records_query`. | `{ query?, similar_to?: record_id, object_types?, mode?, limit? }` | `{ hits: [{ record: RecordSummary, score, match }] }` |
| `crm_find_duplicates` | Scan an object type for likely duplicates using matching rules and semantic similarity. Background Task; returns candidate groups with evidence. Never merges. | `{ object_type, filter?, include_semantic?: boolean }` | `{ task_id }` → `{ groups: [{ records: [RecordSummary], evidence }] }` |
| `crm_merge_records` | Merge duplicates into a survivor: per-attribute survivor values (override with `field_choices`), union of multi-values, links and list entries re-pointed, losers become redirects. Reversible with `crm_unmerge` within retention. Approval-gated by default. | `{ survivor_id, merged_ids: [id], field_choices?: { slug: record_id }, reason }` | `{ record, merge_change_id, repointed_links: n }` |
| `crm_unmerge` | Undo a merge from its snapshot. | `{ merge_change_id, reason }` | `{ restored: [id] }` |
| `crm_data_quality` | Report: required attributes missing, stale records (no activity in N days), orphans (many-side of a `restrict` relation with no active link), unique collisions predating a rule. Each bucket carries a `query_filter` to paginate the full set via `crm_records_query`. | `{ object_type?, stale_days?: number }` | `{ missing_required, stale, orphans, collisions }` each `{ count, items: [{record, detail}] (≤100), query_filter }` |

### 7a. Compliance: erasure, suppression, write guard

| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_record_erase` | Right-to-erasure: suppress first, scrub data + edge/entry data + historical values in place, reindex neighbours, leave a permanent tombstone, emit `record.erased` (consumers must erase their copies). Owner-only, approval-gated, irreversible. | `{ id, reason: gdpr_request\|retention_policy\|legal_order\|other, suppress?: true }` | `{ erased: true, suppressed: [{kind, count}] }` |
| `crm_suppression_add` | Record a do-not-contact entry (email/phone/domain/company number/postal), optionally per channel and time-boxed (`expires_at` refused on objection/erasure). Value normalized (pinned rules, schema-engine §4d) and hashed in memory — never stored readable. | `{ kind, value, channel?, reason, sub_reason?, expires_at?, note? }` | `{ added: true }` |
| `crm_suppression_check` | **Call before any outbound send**, with the channel you are about to use; `all` entries and unexpired time-boxed entries suppress. | `{ entries: [{kind, value, channel?}] (≤100) }` | `{ results: [{kind, suppressed, reason?, sub_reason?}] }` |
| `crm_suppression_list` | List suppression entries (hashes and metadata only — the store holds no readable values). | `{ kind?, cursor?, limit? }` | `{ entries, next_cursor }` |
| `crm_suppression_remove` | Remove a suppression entry (un-suppressing an objector — owner + approval). | `{ kind, value, reason }` | `{ removed: boolean }` |
| `crm_write_guard_set` | Set the team's write guard: rejected origin classes (`ORIGIN_REJECTED`), `require_origin` (refuse origin-less writes), and `team_visibility_only_apps` (app keys whose writes must be team-visible — `VISIBILITY_REJECTED`; server-enforces "we write no private data"). Owner-only. | `{ rejected_origins?, require_origin?, team_visibility_only_apps? }` | the guard |

Suppression entries survive tenant deletion and record erasure by construction (no foreign keys — schema-engine §2); erasure semantics: schema-engine §4d.

## 8. IO, change feed, webhooks

| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_export` | Export an object type or view to JSONL/CSV as a Task; the approval names the exact attribute list, rows honour the approver's redaction, and the result is a single-use signed URL (≤1 h, row-capped). | `{ object_type?, view?, format: jsonl\|csv, attributes?, reason?, idempotency_key? }` | `{ task_id }` → `{ url, rows, expires_at }` |
| `crm_changes_since` | Global change feed since a cursor (a plain decimal seq, per team, commit-ordered). Omitting the cursor returns a **fresh cursor at now** — full history replay requires `from: "beginning"`. Use on schedules to react to what changed. | `{ cursor?: string, from?: "beginning", object_types?, kinds?, limit? }` | `{ changes: Change[], next_cursor, has_more }` |
| `crm_webhook_set` | Register (upsert by URL) an HMAC-signed webhook receiving coalesced change batches **from now on** (never historical replay). Owner-only + approval. Intended for integration code, not conversational agents: the once-shown secret must never enter model context. | `{ url, events: [record.*\|link.*\|schema.*], active?, rotate_secret? }` | `{ webhook: { id, url, events, active }, secret?: string (creation or rotate only) }` |
| `crm_webhook_list` | List webhooks (secrets never returned). | `{}` | `{ webhooks }` |
| `crm_webhook_delete` | Delete a webhook. | `{ id }` | `{ deleted: true }` |

Webhook wire contract (envelope, signature, retry, catch-up): **normative in [events.md](spec/events.md) §3** — this section only names the tools.

## 9. Prompts

| Name | Arguments | Purpose |
|---|---|---|
| `crm/qualify-lead` | `record_id` | Steps: fetch record + timeline + company, check required attributes, propose stage move, log activity. |
| `crm/prepare-account-review` | `company_record_id` | Gather people, open deals, last 90 days of activity, data-quality issues; produce a review. |
| `crm/clean-duplicates` | `object_type` | Run `crm_find_duplicates`, review groups with evidence, merge only with human confirmation. |

Prompts are text scaffolds referencing tool names; they contain no logic. Each states that merge/delete/export gates are **enforced server-side** via approvals — they are not etiquette the agent may skip. `prompts/list` carries the same `ttlMs`/`cacheScope` as other cacheable results.

## 10. Tool count and grouping

56 tools. Prefix groups: `crm_schema_*`/`crm_object_type_*`/`crm_attribute_*`/`crm_relation_type_*`/`crm_matching_rule_*`/`crm_template_*` (11), `crm_record*`/`crm_records_*` (12), `crm_link*` (3), `crm_list_*`/`crm_view_*` (7), `crm_activity_*`/`crm_note_*`/`crm_task*`/`crm_pipeline_*` (7), `crm_search`/`crm_find_duplicates`/`crm_merge_records`/`crm_unmerge`/`crm_data_quality` (5), `crm_record_erase`/`crm_suppression_*`/`crm_write_guard_set` (6), `crm_export`/`crm_changes_since`/`crm_webhook_*` (5). Descriptions stay under 300 characters (enforced at registration) so a client's find/load meta-tools work; longer guidance lives in the `crm://help/*` resources.
