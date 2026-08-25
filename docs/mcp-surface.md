# MCP surface

The product. One streamable-HTTP endpoint, MCP spec **2026-07-28**, stateless. Tool names, descriptions and schemas here are normative; code registers exactly these, and `pnpm docs:mcp` regenerates the tables in §2–§8 from the registrations.

## 0. Conventions

### 0.1 Transport & protocol conformance (MCP 2026-07-28, normative)

- `POST /mcp` — one JSON-RPC request per HTTP request. `GET`/`DELETE /mcp` ⇒ 405; `subscriptions/listen` is **not implemented** (−32601) — staleness is signalled by `ttlMs` and by `SCHEMA_CONFLICT`/`UNKNOWN_ATTRIBUTE` errors.
- **Required headers:** `Mcp-Method` and `Mcp-Name` on every POST (mismatch with the body ⇒ `HeaderMismatchError` −32020). **Required `_meta` on every request:** `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` (missing ⇒ −32602; unsupported version ⇒ `UnsupportedProtocolVersionError` −32022). Every result carries `_meta["io.modelcontextprotocol/serverInfo"]`.
- **`server/discover` is implemented** (spec MUST): advertises supported protocol versions (`2026-07-28`), standard Tasks capabilities (`tasks.cancel`, `tasks.requests.tools.call`), the compatibility `io.modelcontextprotocol/tasks` extension, server identity, and DeepCRM limits metadata (`maxBulkRows`, `maxFilterNodes`, page caps).
- **Every ordinary result carries `resultType`**: `"complete"` for ordinary results and `"input_required"` for MRTR interim results. SDK Task results use their standard shapes without `resultType`.
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

`crm_records_bulk_assert`, `crm_find_duplicates`, `crm_export` return the SDK-standard unsolicited `{ task: Task }` result (camel `taskId`) and the server advertises `tasks.cancel` plus `tasks.requests.tools.call`; the `io.modelcontextprotocol/tasks` extension capability remains discoverable for compatibility. Clients poll `tasks/get { taskId }`, then call `tasks/result { taskId }` for the original completed `tools/call` result. Both are tenant scoped (`NOT_FOUND` otherwise). `tasks/cancel` requests cooperative stop at a batch boundary; `tasks/update` returns JSON-RPC −32601. Clients without task support receive text poll guidance in the compatible tool result.

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

<!-- tools:start:2 -->
| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_schema_get` | Get the workspace data model and visible saved views. Call this first in a session; cache by schema_version. Pass object_type for full field detail. | `{ object_type?: string }` | `crm://schema` body or one `ObjectTypeDetail` |
| `crm_object_type_define` | Create a custom object type (a new kind of record, e.g. "subscription"). Attributes can be added now or later with crm_attribute_define. | `{ slug: string, singular_name: string, plural_name: string, description: string, icon?: string, attributes?: array, primary_attribute?: string }` | `ObjectTypeDetail` |
| `crm_object_type_update` | Rename or re-describe an object type, or change its primary attribute. | `{ object_type: string, singular_name?: string, plural_name?: string, description?: string, icon?: string, primary_attribute?: string }` | `ObjectTypeDetail` |
| `crm_object_type_archive` | Archive a custom object type. Records are kept but hidden; MRTR confirmation states the record count. | `{ object_type: string, reason?: string }` | `{ archived: true, records: n }` |
| `crm_attribute_define` | Add an attribute (field) to an object type. Use record_reference to relate to other object types. Unique attributes enable crm_record_assert. | `{ slug: string, name: string, description: string, type: "text" \| "rich_text" \| "number" \| "currency" \| "percent" \| "boolean" \| "date" \| "datetime" \| "select" \| "status" \| "rating" \| "email" \| "phone" \| "url" \| "domain" \| "registry_id" \| "location" \| "personal_name" \| "actor_reference" \| "record_reference" \| "timestamp_system" \| "json", config?: object, is_multi?: boolean, is_required?: boolean, is_unique?: boolean, is_indexed?: boolean, sensitivity?: "public" \| "internal" \| "confidential" \| "restricted", default_value?: unknown, object_type: string }` | `AttributeDetail` |
| `crm_attribute_update` | Change an attribute name, description, options, required/indexed/sensitivity flags. Type, slug and is_multi are immutable. Tightening may require MRTR; normalize-affecting config changes require a key-recompute backfill; sensitivity raises trigger a reindex Task. | `{ object_type: string, attribute: string, name?: string, description?: string, config?: object, is_required?: boolean, is_unique?: boolean, is_indexed?: boolean, sensitivity?: "public" \| "internal" \| "confidential" \| "restricted", default_value?: unknown, recompute_keys?: boolean }` | `AttributeDetail` |
| `crm_attribute_archive` | Archive an attribute; values are retained in history. MRTR confirmation states how many records carry a value. | `{ object_type: string, attribute: string, reason?: string }` | `{ archived: true, records_with_values: n }` |
| `crm_attribute_group_define` | Create ordered display metadata for attributes on an object type. Optionally assigns existing fields to the group; record values and visibility rules are unchanged. | `{ object_type: string, slug: string, name: string, description?: string, attributes?: array }` | `AttributeGroupDetail` |
| `crm_attribute_group_reorder` | Replace the display order for all active attribute groups on an object type. Does not change field values, sensitivity, or visibility behavior. | `{ object_type: string, groups: array }` | `{ groups: AttributeGroupDetail[] }` |
| `crm_attribute_group_archive` | Archive an attribute display group and leave its fields active as ungrouped fields. Does not alter any stored record values. | `{ object_type: string, group: string, reason?: string }` | `{ archived: true }` |
| `crm_derived_attribute_define` | Define a read-only derived attribute using a bounded formula, rollup, relation sync, or score definition. Values are materialized; direct record writes fail. | `{ slug: string, name: string, description: string, type: "text" \| "rich_text" \| "number" \| "currency" \| "percent" \| "boolean" \| "date" \| "datetime" \| "select" \| "status" \| "rating" \| "email" \| "phone" \| "url" \| "domain" \| "registry_id" \| "location" \| "personal_name" \| "actor_reference" \| "record_reference" \| "timestamp_system" \| "json", config?: object, is_required?: boolean, is_indexed?: boolean, sensitivity?: "public" \| "internal" \| "confidential" \| "restricted", object_type: string, value_source: "formula" \| "rollup" \| "relation_sync" \| "score", derivation_config: object }` | `AttributeDetail` |
| `crm_derived_attribute_update` | Update a derived attribute definition or metadata. Definition changes mark refresh pending and may change materialized values after worker refresh. | `{ object_type: string, attribute: string, name?: string, description?: string, is_required?: boolean, is_indexed?: boolean, sensitivity?: "public" \| "internal" \| "confidential" \| "restricted", derivation_config?: object }` | `AttributeDetail` |
| `crm_derived_refresh_status` | Read compact refresh state for derived attributes. Use after writes or definition changes to see pending, refreshing, ready, or failed materialization. | `{ object_type?: string, attribute?: string }` | `{ attributes: AttributeDerivationDetail[] }` |
| `crm_relation_type_define` | Define a named, typed relationship between object types (e.g. person —works_at→ company) with cardinality and optional attributes on the link itself. All four cardinalities are supported; a record_reference attribute owns exactly one backing relation, never shared. | `{ slug: string, from_object_type: string \| null, to_object_type: string \| null, forward_name: string, inverse_name: string, description?: string, cardinality: "one_to_one" \| "one_to_many" \| "many_to_one" \| "many_to_many", on_delete?: "unlink" \| "cascade" \| "restrict", edge_attributes?: array, edge_limits?: object }` | `RelationTypeDetail` |
| `crm_relation_type_update` | Update relation metadata, edge attributes, delete behavior or active-edge limits. Limit reductions that conflict with live data fail with relation/label/bound evidence only. | `{ relation_type: string, forward_name?: string, inverse_name?: string, description?: string, cardinality?: "one_to_one" \| "one_to_many" \| "many_to_one" \| "many_to_many", on_delete?: "unlink" \| "cascade" \| "restrict", edge_attributes?: array, edge_limits?: object }` | `RelationTypeDetail` |
| `crm_relation_type_archive` | Archive a relation type; links are kept but inactive. | `{ relation_type: string, reason?: string }` | `{ archived: true, links: n }` |
| `crm_matching_rule_set` | Replace duplicate rules for an object type. Existing live data may require an internal backfill; until collision-free activation, the old generation remains effective. Re-call to inspect; set retry_backfill only after resolving reported collisions or a terminal job failure/cancel. | `{ object_type: string, rules: array, retry_backfill?: boolean }` | `{ rules, activation: { state: active, taskId: null } \| { state: pending_backfill, taskId } \| { state: collision_blocked, taskId, group_count, record_count } }` |
| `crm_template_apply` | Apply a schema template by slug (see crm://templates), e.g. standard_crm: people, companies, deals. Idempotent: existing slugs untouched. Unknown slug ⇒ UNKNOWN_TEMPLATE {available}. | `{ template: string }` | `{ added: { object_types, attributes, relation_types, matching_rules } }` (numeric counts) |
<!-- tools:end -->

`AttributeSpec = { slug, name, description, type, config?, is_multi?, is_required?, is_unique?, is_indexed?, sensitivity?, default_value? }`. Policy: all `define` on `schema`.

## 3. Record tools

<!-- tools:start:3 -->
| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_record_create` | Create one record. Use crm_record_assert for sync-safe upserts. Inline links are atomic. Unique or block collisions return DUPLICATE_FOUND; warn matches return duplicates. | `{ object_type: string, data: object, links?: array, owner?: object, visibility?: "team" \| "users" \| "private", visible_to?: array, origin?: string, reason?: string, idempotency_key?: string }` | `{ record, duplicates?: Candidate[] }` |
| `crm_record_update` | Patch attributes; null clears an attribute. Supply expected_version for concurrency protection. Metadata changes are policy enforced. | `{ id: string, data: object, owner?: object \| null, visibility?: "team" \| "users" \| "private", visible_to?: array, origin?: string, expected_version?: integer, reason?: string, idempotency_key?: string }` | `{ record }` |
| `crm_record_assert` | Create or patch by a unique attribute for sync/import writes. Multiple multi-value matches return DUPLICATE_FOUND. Inline links are atomic. | `{ object_type: string, match_attribute: string, data: object, links?: array, owner?: object, reason?: string, idempotency_key?: string }` | `{ record, created: boolean, duplicates?: Candidate[] }` |
| `crm_record_get` | Fetch one visible record by id or a unique attribute. include_links groups active related records; include_timeline returns recent activity. | `{ id?: string, object_type?: string, match_attribute?: string, value?: unknown, include_links?: boolean, include_timeline?: integer }` | `{ record, links?, timeline? }` |
| `crm_records_query` | List visible records with exact structured filters, sort and opaque cursor. Use crm_record_get for a known record and crm_search for fuzzy text. | `{ object_type: string, filter?: object, sort?: array, attributes?: array, include_total?: boolean, cursor?: string, limit?: integer }` | `{ records, next_cursor, total? }` |
| `crm_records_count` | Count visible records matching an exact structured filter. This shares crm_records_query policy and visibility rules and avoids pagination. | `{ object_type: string, filter?: object }` | `{ count }` |
| `crm_records_get_many` | Fetch up to 100 visible records by id in input order. Hidden, unavailable, and foreign-tenant ids are reported only as missing. | `{ ids: array }` | `{ records, missing: [uuid] }` |
| `crm_records_bulk_assert` | Queue 1–10,000 sync-safe record upserts by one unique attribute. Returns a Task immediately; poll tasks/get, then read tasks/result. Each row is independently reported. | `{ object_type: string, match_attribute: string, rows: array, reason?: string, idempotency_key?: string }` | `{ task: { taskId, status, ttl, createdAt, lastUpdatedAt, pollInterval?, statusMessage? } }`; `tasks/result` returns `{ created, updated, failed: [{ index, code, message }] }` in the original tool result |
| `crm_record_delete` | Soft-delete a visible record and end links according to relation policy. Requires delete entitlement or approval. | `{ id: string, expected_version?: integer, reason?: string }` | `{ deleted: true }` |
| `crm_record_restore` | Restore a soft-deleted record and recoverable links. Restore conflicts identify a current unique-key holder. | `{ id: string }` | `{ record }` |
| `crm_record_at` | Reconstruct visible record values and reference links at an ISO timestamp from change history. | `{ id: string, at: string }` | `{ record_at: { data, version_at, as_of, links } }` |
| `crm_record_history` | Read field-level history for one visible record. Cursor is bound to id, attributes and limit. | `{ id: string, attributes?: array, cursor?: string, limit?: integer }` | `{ changes: Change[], next_cursor }` |
<!-- tools:end -->

## 4. Link tools

<!-- tools:start:4 -->
| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_link` | Relate two visible records with optional edge data. Cardinality replacements are returned in ended_links. Reusing an idempotency key with changed arguments fails. | `{ relation_type: string, from_record_id: string, to_record_id: string, data?: object, label?: string, reason?: string, idempotency_key?: string }` | `{ link, ended_links: [link_id] }` |
| `crm_unlink` | End an active link while retaining history. Identify it by link_id or a full relation triple; an ambiguous triple ends the newest active link. | `{ link_id?: string, relation_type?: string, from_record_id?: string, to_record_id?: string, reason?: string }` | `{ link_id }` |
| `crm_links_list` | List visible links for one visible record with related record summaries. Filter by relation and direction; include_history adds ended links. Cursor binds all filters. | `{ record_id: string, relation_type?: string, direction?: "from" \| "to" \| "both", include_history?: boolean, cursor?: string, limit?: integer }` | `{ links: [{ link, related: RecordSummary }], next_cursor }` |
<!-- tools:end -->

## 5. Lists, views

<!-- tools:start:5 -->
| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_list_create` | Create a curated single-object or mixed-record list with optional typed entry attributes. Entry metadata uses the same validation rules as record data. Errors: policy denial, unknown object type, or schema conflict. | `{ slug: string, name: string, description?: string, kind?: "static" \| "dynamic", object_type?: string, filter?: object, attributes?: array }` | `ListDetail` |
| `crm_list_update` | Update list metadata; for dynamic lists, replacing filter schedules a membership refresh and advances evaluation_version. Static lists reject filter changes. | `{ list: string, name?: string, description?: string, filter?: object }` | `ListDetail` |
| `crm_list_status` | Read dynamic-list evaluation state, object scope, filter, version, error code and last completed evaluation time. | `{ list: string }` | `{ status }` |
| `crm_list_add` | Add visible live records to a curated list. Data is validated against list attributes; existing memberships are unchanged and excluded from added. Errors: policy denial, NOT_FOUND, or invalid object type/data. | `{ list: string, entries: array }` | `{ added: n }` |
| `crm_list_remove` | Remove visible record memberships from a curated list. Missing memberships are ignored. Errors: policy denial or NOT_FOUND for the list or a hidden/foreign record. | `{ list: string, record_ids: array }` | `{ removed: n }` |
| `crm_list_entries` | Read a cursor page of list entries joined to visible, policy-permitted live records. Entry attributes and record data are redacted independently. Errors: policy denial, NOT_FOUND, or cursor mismatch. | `{ list: string, cursor?: string, limit?: integer }` | `{ entries: [{ entry, record }], next_cursor }` |
| `crm_view_save` | Create or replace a reusable structured record query. Filters, sort keys and projected attributes are validated against the active schema. Exact replays are no-ops. Errors: policy denial or invalid query metadata. | `{ slug: string, name: string, object_type: string, filter: object, sort?: array, attributes?: array, description?: string }` | `ViewDetail` |
| `crm_view_run` | Run a saved view with current row visibility, policy and attribute redaction. The opaque cursor is bound to the saved definition. Use crm_records_query for an ad hoc filter. Errors: policy denial, NOT_FOUND, or cursor mismatch. | `{ view: string, cursor?: string, limit?: integer }` | same as `crm_records_query` |
| `crm_view_delete` | Delete a saved view by slug and invalidate the schema resource version. This does not delete records. Errors: policy denial or NOT_FOUND. | `{ view: string }` | `{ deleted: true }` |
<!-- tools:end -->

## 6. Activities, timeline, tasks, pipeline

<!-- tools:start:6 -->
| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_activity_log` | Log a timestamped interaction about visible records; use crm_note_add for an untimed note. external_ref updates the existing activity and last_activity_at stays monotonic. Returns the activity record. Fails NOT_FOUND for hidden targets or policy errors when create/link is not allowed. | `{ kind: "email" \| "call" \| "meeting" \| "note" \| "message" \| "task_event" \| "custom", occurred_at: string, subject?: string, body?: string, direction?: "inbound" \| "outbound" \| "internal", participants?: array, about: array, external_ref?: string, reason?: string, idempotency_key?: string }` | `{ record }` (the activity record) |
| `crm_note_add` | Attach an untimed markdown note to visible records; use crm_activity_log for a timestamped interaction. The note, links, and monotonic last_activity_at update are atomic. Returns the note record. Fails NOT_FOUND for hidden targets or policy errors when create/link is not allowed. | `{ title?: string, body: string, about: array, reason?: string, idempotency_key?: string }` | `{ record }` |
| `crm_record_timeline` | Read a visible record's activities, notes, tasks, and changes; hops 1 includes visible linked records. Use crm_record_history for change-only audit detail. Returns redacted items and a cursor. Errors: NOT_FOUND for hidden anchors, policy errors for denied view, VALIDATION_FAILED for cursor mismatch. | `{ id: string, hops?: 0 \| 1, relation_types?: array, kinds?: array, since?: string, cursor?: string, limit?: integer }` | `{ items: TimelineItem[], next_cursor }` |
| `crm_task_create` | Create a task, optionally assigned and atomically linked to visible records. Use crm_note_add for information with no action. Returns the task record with applied defaults. Fails NOT_FOUND for hidden about records or policy errors when create/link is not allowed. | `{ title: string, body?: string, due_at?: string, assignee?: object, priority?: "low" \| "normal" \| "high" \| "urgent", about?: array, reason?: string, idempotency_key?: string }` | `{ record }` |
| `crm_task_update` | Patch a visible active task; null clears nullable fields. Use expected_version to prevent stale writes. Returns the updated task record. Fails NOT_FOUND for non-task or hidden records, VERSION_CONFLICT for stale versions, and policy errors when edit is not allowed. | `{ id: string, status?: "open" \| "in_progress" \| "done" \| "cancelled", assignee?: object \| null, due_at?: string \| null, priority?: "low" \| "normal" \| "high" \| "urgent" \| null, title?: string, body?: string \| null, expected_version?: integer, reason?: string, idempotency_key?: string }` | `{ record }` |
| `crm_tasks_list` | List visible tasks by exact status or assignee, inclusive due window, and optional visible about record. Use crm_records_query for custom task filters. Returns a redacted page and opaque cursor. Fails NOT_FOUND for a hidden about record or VALIDATION_FAILED for cursor mismatch. | `{ status?: "open" \| "in_progress" \| "done" \| "cancelled", assignee?: object, due_before?: string, due_after?: string, about?: string, cursor?: string, limit?: integer }` | `{ records, next_cursor }` |
| `crm_pipeline_define` | Define a generic pipeline and ordered stages for one object type. Use before stage moves; errors on duplicate slugs or non-contiguous positions. | `{ object_type: string, slug: string, name: string, description?: string, is_default?: boolean, stages: array }` | `PipelineDetail` |
| `crm_pipeline_update` | Rename, describe, or make a generic object pipeline the default. Use crm_pipeline_define to create stages; errors when the pipeline is absent. | `{ object_type: string, pipeline: string, name?: string, description?: string, is_default?: boolean }` | `PipelineDetail` |
| `crm_pipeline_stage_set` | Move one visible record to an active pipeline stage. Appends immutable stage history; same-stage calls are no-ops. Errors on hidden records or stages. | `{ record_id: string, pipeline: string, stage: string, occurred_at?: string, reason?: string, idempotency_key?: string }` | `{ record_id, pipeline, stage, changed, interval_id }` |
| `crm_pipeline_stages_list` | List one pipeline and its active ordered stages. Use before crm_pipeline_stage_set or crm_pipeline_summary to inspect valid stage slugs. | `{ object_type: string, pipeline: string }` | `{ pipeline: PipelineDetail, stages: PipelineStageDetail[] }` |
| `crm_pipeline_summary` | Summarize visible live records from pipeline stage history with optional fixed-currency sums and conversions. Use crm_records_query for rows. | `{ object_type: string, pipeline?: string, amount_attribute?: string, filter?: object, since?: string }` | `{ stages: [{ id, label, category, count, amount_sum?, avg_days_in_stage }] , conversions: [{ from, to, count }] }` |
| `crm_event_type_define` | Define an immutable behavioural event vocabulary and property schema. Use this before ingesting product or integration events. | `{ slug: string, name: string, description?: string, subject_object_type?: string, property_schema?: object }` | `{ event_type }` |
| `crm_event_ingest` | Append one immutable behavioural event. source plus external_id is idempotent; corrections are new events linked to the original, never updates. | `{ event_type: string, source: string, external_id: string, occurred_at: string, subject_record_id?: string, actor?: object, properties?: object, correction_of_event_id?: string }` | `{ event, created }` |
| `crm_events_query` | Query immutable behavioural events by type, source or visible subject record. Cross-tenant and hidden subjects return NOT_FOUND or are omitted. | `{ event_type?: string, subject_record_id?: string, source?: string, cursor?: string, limit?: integer }` | `{ events, next_cursor }` |
<!-- tools:end -->

## 7. Search, quality, merge

<!-- tools:start:7 -->
| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_search` | Rank visible records by keyword, semantic similarity, or hybrid RRF. Use similar_to for indexed neighbours and crm_records_query for exact lookup. Recently changed linked names can lag indexing briefly. | `{ query?: string, similar_to?: string, object_types?: array, mode?: "keyword" \| "semantic" \| "hybrid", limit?: integer }` | `{ hits: [{ record: RecordSummary, score, match }] }` |
| `crm_find_duplicates` | Scan visible records of one object type using active matching rules and optional semantic similarity. Returns a Task; poll it for evidence groups. Never merges records. | `{ object_type: string, filter?: object, include_semantic?: boolean }` | `{ task_id }` → `{ groups: [{ records: [RecordSummary], evidence }] }` |
| `crm_merge_records` | Merge visible same-type duplicates into one survivor. Re-points links and lists, moves surviving unique keys, and leaves reversible redirects. Requires merge entitlement; use crm_find_duplicates first. | `{ survivor_id: string, merged_ids: array, field_choices?: object, reason: string }` | `{ record, merge_change_id, repointed_links: n, ended_links: [id] }` |
| `crm_unmerge` | Undo one crm_merge_records operation from its merge_change_id. Restores records, links, lists, and derived keys atomically; returns conflicts without partial restoration. | `{ merge_change_id: string, reason: string }` | `{ restored: [id], conflicts: [{ kind, attribute?, rule_position?, link_id?, held_by? }] }` |
| `crm_data_quality` | Find visible records with missing required values, stale activity, required-relation orphans, or duplicate values on unique attributes. Each bucket includes a reusable crm_records_query filter. | `{ object_type?: string, stale_days?: integer }` | `{ missing_required, stale, orphans, collisions }` each `{ count, items: [{record, detail}] (≤100), query_filter }` |
<!-- tools:end -->

### 7a. Compliance: erasure, suppression, write guard

<!-- tools:start:7a -->
| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_record_erase` | Right-to-erasure operation. Suppresses contact facts first, scrubs record, link data, list entry data, historical values, search, keys, and grants, emits record.erased, and leaves a permanent ERASED tombstone. Owner approval-gated and irreversible. | `{ id: string, reason: "gdpr_request" \| "retention_policy" \| "legal_order" \| "other", suppress?: boolean }` | `{ erased: true, suppressed: [{kind, count}] }` |
| `crm_suppression_add` | Add a hashed suppression entry. Use for objections, erasure, bounces, and manual channel holds. Values are normalized in memory and never stored raw. | `{ kind: "email" \| "phone" \| "domain" \| "company_number" \| "postal", value: string, channel?: "all" \| "email" \| "phone_call" \| "sms" \| "post", reason: "objection" \| "erasure" \| "bounce" \| "manual", sub_reason?: string, expires_at?: string, note?: string }` | `{ added: true }` |
| `crm_suppression_check` | Call before outbound contact on the exact channel. all entries and unexpired channel entries suppress; expired entries return suppressed false. | `{ entries: array }` | `{ results: [{kind, suppressed, reason?, sub_reason?}] }` |
| `crm_suppression_list` | List suppression metadata and hashes only. Use filters to inspect compliance state; raw suppressed values are never returned. | `{ kind?: "email" \| "phone" \| "domain" \| "company_number" \| "postal", channel?: "all" \| "email" \| "phone_call" \| "sms" \| "post", reason?: "objection" \| "erasure" \| "bounce" \| "manual", sub_reason?: string, cursor?: string, limit?: integer }` | `{ entries, next_cursor }` |
| `crm_suppression_remove` | Remove one hashed suppression entry by value and channel. This is owner approval-gated because it may re-enable outbound contact. | `{ kind: "email" \| "phone" \| "domain" \| "company_number" \| "postal", value: string, channel?: "all" \| "email" \| "phone_call" \| "sms" \| "post", reason: string }` | `{ removed: boolean }` |
| `crm_write_guard_set` | Set rejected origins, require_origin, and app keys forced to team-visible writes. Owner-only; rejected writes return ORIGIN_REJECTED or VISIBILITY_REJECTED. | `{ rejected_origins?: array, require_origin?: boolean, team_visibility_only_apps?: array }` | the guard |
<!-- tools:end -->

Suppression entries survive tenant deletion and record erasure by construction (no foreign keys — schema-engine §2); erasure semantics: schema-engine §4d.

## 8. IO, change feed, webhooks

<!-- tools:start:8 -->
| Tool | Description | Input | Output |
|---|---|---|---|
| `crm_file_register` | Register external file metadata only. DeepCRM stores provider/key, size, MIME and checksum, never blobs, signed URLs or secrets. Conflicting provider keys fail. | `{ provider: string, provider_key: string, filename: string, mime_type: string, size_bytes: string, checksum_sha256?: string, metadata?: object }` | `{ file }` |
| `crm_file_link` | Attach a registered file to a visible record/activity or event with a typed purpose. Target visibility is checked before the attachment is stored. | `{ file_id: string, target_type: "record" \| "activity" \| "event", record_id?: string, event_id?: string, purpose: string, metadata?: object }` | `{ link }` |
| `crm_file_list` | List authorized file links and short-lived storage access URLs. URLs expire quickly; provider keys remain metadata and are not bearer credentials. | `{ target_type?: "record" \| "activity" \| "event", record_id?: string, event_id?: string, limit?: integer }` | `{ files: [{ file, link, access }] }` |
| `crm_export` | Export exactly one object type or saved view for offline analysis when paginated queries are unsuitable. Returns a Task with a redacted, row-capped CSV or JSONL result at a signed, single-use URL valid for at most one hour; may raise POLICY_DENIED or APPROVAL_REQUIRED. | `{ object_type?: string, view?: string, format: "jsonl" \| "csv", attributes?: array, reason?: string, idempotency_key?: string }` | `{ task_id }` → `{ url, rows, expires_at }` |
| `crm_changes_since` | Read the visible, policy-redacted team change feed by commit-ordered decimal cursor. Omit cursor to start now; use from=beginning only for retained-history replay. | `{ cursor?: string, from?: "beginning", object_types?: array, kinds?: array, limit?: integer }` | `{ changes: Change[], next_cursor, has_more }` |
| `crm_webhook_set` | Register or update an owner-approved HMAC webhook from now on. Creation or explicit rotation returns secret material once; integration code must keep it out of model context. | `{ url: string, events: array, active?: boolean, rotate_secret?: boolean }` | `{ webhook: { id, url, events, active }, secret?: string (creation or rotate only) }` |
| `crm_webhook_list` | List all webhooks in the entitled tenant, including inactive delivery errors. Secrets are never returned. | `{}` | `{ webhooks }` |
| `crm_webhook_delete` | Delete one owner-approved webhook by id inside the entitled tenant. | `{ id: string }` | `{ deleted: true }` |
<!-- tools:end -->

Webhook wire contract (envelope, signature, retry, catch-up): **normative in [events.md](spec/events.md) §3** — this section only names the tools.

## 9. Prompts

| Name | Arguments | Purpose |
|---|---|---|
| `crm/qualify-lead` | `record_id` | Steps: fetch record + timeline + company, check required attributes, propose stage move, log activity. |
| `crm/prepare-account-review` | `company_record_id` | Gather people, open deals, last 90 days of activity, data-quality issues; produce a review. |
| `crm/clean-duplicates` | `object_type` | Run `crm_find_duplicates`, review groups with evidence, merge only with human confirmation. |

Prompts are text scaffolds referencing tool names; they contain no logic. Each states that merge/delete/export gates are **enforced server-side** via approvals — they are not etiquette the agent may skip. `prompts/list` carries the same `ttlMs`/`cacheScope` as other cacheable results.

## 10. Tool count and grouping

71 tools. Prefix groups: `crm_schema_*`/`crm_object_type_*`/`crm_attribute_*`/`crm_relation_type_*`/`crm_matching_rule_*`/`crm_template_*` (14), `crm_record*`/`crm_records_*` (12), `crm_link*` (3), `crm_list_*`/`crm_view_*` (9), `crm_activity_*`/`crm_note_*`/`crm_task*`/`crm_pipeline_*`/`crm_event_*`/`crm_events_*` (14), `crm_search`/`crm_find_duplicates`/`crm_merge_records`/`crm_unmerge`/`crm_data_quality` (5), `crm_record_erase`/`crm_suppression_*`/`crm_write_guard_set` (6), `crm_file_*`/`crm_export`/`crm_changes_since`/`crm_webhook_*` (8). Descriptions stay under 300 characters (enforced at registration) so a client's find/load meta-tools work; longer guidance lives in the `crm://help/*` resources.
