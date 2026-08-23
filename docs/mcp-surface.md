# MCP surface

The product. One streamable-HTTP endpoint, MCP spec **2026-07-28**, stateless. Tool names, descriptions and schemas here are normative; code registers exactly these, and `pnpm docs:mcp` regenerates the tables in §2–§8 from the registrations.

## 0. Conventions

### 0.1 Transport
- `POST /mcp` — one JSON-RPC request per HTTP request. `GET`/`DELETE /mcp` ⇒ 405. Headers per [auth-and-tenancy.md](auth-and-tenancy.md) §1. Response: JSON (no SSE stream needed — no server-initiated messages are used).
- `tools/list`, `resources/list`, `prompts/list` results carry `_meta["io.modelcontextprotocol/cache"] = { ttlMs: 300000, cacheScope: "tenant" }` and an `etag` = `schema_version`.
- Server info: `{ name: "deepcrm", version: <package version> }`.

### 0.2 Argument conventions
- Object types, attributes, relation types, lists and views are addressed by **slug**; records, links and changes by **uuid**.
- Every mutating tool accepts optional `reason: string` (stored on the change) and `idempotency_key: string` (replay-safe for 24 h).
- Every write that touches an existing record accepts optional `expected_version: number`.
- `limit` defaults 50, max 200; `cursor` is opaque.

### 0.3 Result conventions
- Results are `structuredContent` JSON (plus a one-line `content[0].text` summary for clients that show text). Shapes below are the `structuredContent`.
- A **record** renders as `{ id, object_type, display_name, version, data, owner, created_at, updated_at, last_activity_at, redacted_attributes: [], links?: … , redirected_from? }`.
- Errors: `isError: true`, `structuredContent: { code, message, ...details }` with codes from `schema-engine.md` §10.

### 0.4 Multi round-trip (MRTR) — confirmations and approvals
When a call needs a decision before it proceeds, the tool returns `resultType: "input_required"` with `inputRequests`:

```json
{ "resultType": "input_required",
  "inputRequests": [{ "id": "confirm", "kind": "confirmation",
     "message": "Archiving attribute 'fax' will hide 12 existing values. Proceed?",
     "schema": { "type": "object", "properties": { "confirmed": { "type": "boolean" } }, "required": ["confirmed"] } }] }
```
The client re-issues the same `tools/call` with `inputResponses: { confirm: { confirmed: true } }`. Approval-gated actions use `kind: "approval"` with `approval_token`; the re-issue must carry `{ approval_token, approved: true }` **and** come from a principal whose role is admin/owner (the Nessie agent obtains the human's decision in-channel). Tokens expire after 24 h.

### 0.5 Long-running work — Tasks extension
`crm_records_bulk_assert`, `crm_find_duplicates`, `crm_export` return `{ task_id }`; clients poll `tasks/get { taskId }` (extension `io.modelcontextprotocol/tasks`) which maps to `queue_jobs.{status, progress, result}`. `tasks/cancel` marks the job cancelled if still queued.

## 1. Resources

| URI | Content |
|---|---|
| `crm://schema` | `{ schema_version, object_types: [ObjectTypeSummary], relation_types: [...], matching_rules: [...] }` |
| `crm://schema/{object_type}` | full `ObjectTypeDetail` (attributes with type, config, flags, sensitivity, description) |
| `crm://templates` | available template slugs with descriptions |
| `crm://views/{slug}` | a saved view's definition |

## 2. Schema tools

| Tool | Description (as registered) | Input | Output |
|---|---|---|---|
| `crm_schema_get` | Get the workspace data model: object types, their attributes, relation types and matching rules. Call this first in a session; cache by `schema_version`. | `{ object_type?: slug }` | `crm://schema` body or one `ObjectTypeDetail` |
| `crm_object_type_define` | Create a custom object type (a new kind of record, e.g. "subscription"). Attributes can be added now or later with `crm_attribute_define`. | `{ slug, singular_name, plural_name, description, icon?, attributes?: AttributeSpec[], primary_attribute?: slug }` | `ObjectTypeDetail` |
| `crm_object_type_update` | Rename or re-describe an object type, or change its primary attribute. | `{ object_type, singular_name?, plural_name?, description?, icon?, primary_attribute? }` | `ObjectTypeDetail` |
| `crm_object_type_archive` | Archive a custom object type. Records are kept but hidden; MRTR confirmation states the record count. | `{ object_type, reason? }` | `{ archived: true, records: n }` |
| `crm_attribute_define` | Add an attribute (field) to an object type. Use `record_reference` to relate to other object types. Unique attributes enable `crm_record_assert`. | `{ object_type, ...AttributeSpec }` | `AttributeDetail` |
| `crm_attribute_update` | Change an attribute's name, description, options, required/indexed/sensitivity flags. Type and slug are immutable. Tightening (required, unique) reports violations via MRTR before applying. | `{ object_type, attribute, name?, description?, config?, is_required?, is_unique?, is_indexed?, sensitivity?, default_value? }` | `AttributeDetail` |
| `crm_attribute_archive` | Archive an attribute; values are retained in history. MRTR confirmation states how many records carry a value. | `{ object_type, attribute, reason? }` | `{ archived: true, records_with_values: n }` |
| `crm_relation_type_define` | Define a named, typed relationship between object types (e.g. person —works_at→ company) with cardinality and optional attributes on the link itself. | `{ slug, from_object_type: slug \| null, to_object_type: slug \| null, forward_name, inverse_name, description?, cardinality, on_delete?, edge_attributes?: AttributeSpec[] }` | `RelationTypeDetail` |
| `crm_relation_type_archive` | Archive a relation type; links are kept but inactive. | `{ relation_type, reason? }` | `{ archived: true, links: n }` |
| `crm_matching_rule_set` | Replace the duplicate-matching rules for an object type. Rules decide what `crm_record_create` does when a likely duplicate exists (block / warn / allow). | `{ object_type, rules: [{ attributes: [slug], method: exact\|normalized\|fuzzy, threshold?, action }] }` | `{ rules }` |
| `crm_template_apply` | Apply a schema template (e.g. `standard_crm`: people, companies, deals). Idempotent: existing slugs untouched. | `{ template }` | `{ added: { object_types, attributes, relation_types } }` |

`AttributeSpec = { slug, name, description, type, config?, is_multi?, is_required?, is_unique?, is_indexed?, sensitivity?, default_value? }`. Policy: all `define` on `schema`.

## 3. Record tools

| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_record_create` | Create a record. Returns the record, plus `duplicates` when a matching rule with action `warn` found likely duplicates. Fails with `DUPLICATE_FOUND` on a unique-attribute collision or a `block` rule — then use `crm_record_assert` or `crm_merge_records`. | `{ object_type, data: {slug: value}, links?: [{ relation_type, to_record_id, data? }], owner?: Actor, reason?, idempotency_key? }` | `{ record, duplicates?: Candidate[] }` |
| `crm_record_update` | Patch attributes on a record. Keys set to `null` are cleared. Pass `expected_version` to avoid overwriting concurrent edits. | `{ id, data, owner?, expected_version?, reason?, idempotency_key? }` | `{ record }` |
| `crm_record_assert` | Create-or-update by a unique attribute (upsert), e.g. person by email, company by domain. The safe default for any sync or import. | `{ object_type, match_attribute: slug, data, links?, owner?, reason?, idempotency_key? }` | `{ record, created: boolean }` |
| `crm_record_get` | Fetch one record by id, or by a unique attribute value. Optionally include active links (grouped by relation) and the recent timeline. | `{ id? , object_type?, match_attribute?, value?, include_links?: boolean, include_timeline?: number }` | `{ record, links?, timeline? }` |
| `crm_records_query` | List records of one object type with a structured filter, sort and cursor. Use `crm_search` for free-text. Filter grammar: see `schema-engine.md` §5. | `{ object_type, filter?, sort?, attributes?: [slug], cursor?, limit? }` | `{ records, next_cursor, total? }` |
| `crm_records_bulk_assert` | Upsert many rows by a unique attribute as a background Task (cap `DEEPCRM_MAX_BULK_ROWS`). Poll `tasks/get`. | `{ object_type, match_attribute, rows: [{ data, links? }], reason? }` | `{ task_id }` → result `{ created, updated, failed: [{ index, code, message }] }` |
| `crm_record_delete` | Soft-delete a record (restorable for the retention window). Links are ended per relation `on_delete`. Admin or approval. | `{ id, reason?, expected_version? }` | `{ deleted: true }` |
| `crm_record_restore` | Restore a soft-deleted record and its links. | `{ id }` | `{ record }` |
| `crm_record_at` | The record's attribute values as they were at a point in time, reconstructed from history. | `{ id, at: datetime }` | `{ record_at: { data, version_at, as_of } }` |
| `crm_record_history` | Field-level change history for one record (who changed what, when, why). | `{ id, attributes?: [slug], cursor?, limit? }` | `{ changes: Change[], next_cursor }` |

## 4. Link tools

| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_link` | Relate two records through a relation type, optionally with link attributes (e.g. role, since). Cardinality is enforced: a `*_to_one` link replaces the existing one. | `{ relation_type, from_record_id, to_record_id, data?, label?, reason?, idempotency_key? }` | `{ link }` |
| `crm_unlink` | End an active link (kept in history). | `{ link_id?, relation_type?, from_record_id?, to_record_id?, reason? }` | `{ unlinked: true }` |
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

## 6. Activities, timeline, tasks, pipeline

| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_activity_log` | Log an interaction (email, call, meeting, message…) against one or more records. Idempotent on `external_ref`. Updates `last_activity_at` on linked records. | `{ kind, occurred_at, subject?, body?, direction?, participants?: Actor[], about: [record_id], external_ref?, reason? }` | `{ record }` (the activity record) |
| `crm_note_add` | Attach a note to one or more records. | `{ title?, body, about: [record_id] }` | `{ record }` |
| `crm_record_timeline` | Chronological activities and changes for a record; `hops: 1` also includes linked records (a company's people and deals). | `{ id, hops?: 0\|1, kinds?: [activity\|change\|note\|task], since?, cursor?, limit? }` | `{ items: TimelineItem[], next_cursor }` |
| `crm_task_create` | Create a task linked to records, assigned to an agent or a human. | `{ title, body?, due_at?, assignee?: Actor, priority?, about?: [record_id] }` | `{ record }` |
| `crm_task_update` | Update a task's status, assignee, due date. | `{ id, status?, assignee?, due_at?, priority?, title?, body? }` | `{ record }` |
| `crm_tasks_list` | Tasks by status/assignee/due window. | `{ status?, assignee?: Actor, due_before?, due_after?, about?: record_id, cursor?, limit? }` | `{ records, next_cursor }` |
| `crm_pipeline_summary` | Stage-by-stage counts, amounts and average time-in-stage for any object type with a `status` attribute (e.g. deals). Derived from history. | `{ object_type, status_attribute?: slug, amount_attribute?: slug, filter?, since? }` | `{ stages: [{ id, label, category, count, amount_sum?, avg_days_in_stage }] , conversions: [{ from, to, count }] }` |

## 7. Search, quality, merge

| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_search` | Free-text search across records: `keyword` (exact words), `semantic` (meaning), or `hybrid` (default). Restrict to object types. | `{ query, object_types?, mode?, limit? }` | `{ hits: [{ record: RecordSummary, score, match: keyword\|semantic\|both }] }` |
| `crm_find_duplicates` | Scan an object type for likely duplicates using matching rules and semantic similarity. Background Task; returns candidate groups with evidence. Never merges. | `{ object_type, filter?, include_semantic?: boolean }` | `{ task_id }` → `{ groups: [{ records: [RecordSummary], evidence }] }` |
| `crm_merge_records` | Merge duplicates into a survivor: per-attribute survivor values (override with `field_choices`), union of multi-values, links and list entries re-pointed, losers become redirects. Reversible with `crm_unmerge` within retention. Approval-gated by default. | `{ survivor_id, merged_ids: [id], field_choices?: { slug: record_id }, reason }` | `{ record, merge_change_id, repointed_links: n }` |
| `crm_unmerge` | Undo a merge from its snapshot. | `{ merge_change_id, reason }` | `{ restored: [id] }` |
| `crm_data_quality` | Report: required attributes missing, stale records (no activity in N days), orphans (deals without company/contact), unique collisions predating a rule. Deterministic; the agent decides what to fix. | `{ object_type?, stale_days?: number }` | `{ missing_required, stale, orphans, collisions }` each `[{ record: RecordSummary, detail }]` with counts |

## 8. IO, change feed, webhooks

| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_export` | Export an object type or view to JSONL/CSV as a Task; result carries a signed download URL valid for 1 h. Approval-gated by default. | `{ object_type?, view?, format: jsonl\|csv, attributes? }` | `{ task_id }` → `{ url, rows, expires_at }` |
| `crm_changes_since` | Global change feed for the workspace since a cursor: every create/set/unset/link/unlink/delete/merge with actor and provenance. Use on schedules to react to what changed. | `{ cursor?: string, object_types?, kinds?, limit? }` | `{ changes: Change[], next_cursor, has_more }` |
| `crm_webhook_set` | Register (or update) an HMAC-signed webhook URL that receives coalesced change batches. Admin only. | `{ url, events: [record.*\|link.*\|schema.*], active? }` | `{ webhook: { id, url, events, active }, secret: string (shown once) }` |
| `crm_webhook_list` | List webhooks (secrets never returned). | `{}` | `{ webhooks }` |
| `crm_webhook_delete` | Delete a webhook. | `{ id }` | `{ deleted: true }` |

Webhook payload: `POST url` with `X-DeepCRM-Signature: sha256=<hmac>` over the body, `X-DeepCRM-Delivery: <id>`, body `{ team: uoaTeamId, since_seq, until_seq, changes: Change[] }`, coalesced per 30 s window, retried with backoff (1 m, 5 m, 30 m, 2 h, 12 h) then parked with `last_error`.

## 9. Prompts

| Name | Arguments | Purpose |
|---|---|---|
| `crm/qualify-lead` | `record_id` | Steps: fetch record + timeline + company, check required attributes, propose stage move, log activity. |
| `crm/prepare-account-review` | `company_record_id` | Gather people, open deals, last 90 days of activity, data-quality issues; produce a review. |
| `crm/clean-duplicates` | `object_type` | Run `crm_find_duplicates`, review groups with evidence, merge only with human confirmation. |

Prompts are text scaffolds referencing tool names; they contain no logic.

## 10. Tool count and grouping

47 tools. Prefix groups: `crm_schema_*`/`crm_object_type_*`/`crm_attribute_*`/`crm_relation_type_*`/`crm_matching_rule_*`/`crm_template_*` (11), `crm_record*`/`crm_records_*` (10), `crm_link*` (3), `crm_list_*`/`crm_view_*` (6), `crm_activity_*`/`crm_note_*`/`crm_task*`/`crm_pipeline_*` (7), `crm_search`/`crm_find_duplicates`/`crm_merge_records`/`crm_unmerge`/`crm_data_quality` (5), `crm_export`/`crm_changes_since`/`crm_webhook_*` (5). Descriptions stay under 300 characters so a client's find/load meta-tools work.
