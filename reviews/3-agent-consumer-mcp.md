# Review 3 — Agent-consumer ergonomics + MCP 2026-07-28 conformance

Perspective: a mid-tier LLM tool-user consuming the surface, plus a protocol
conformance audit. Docs reviewed: `docs/mcp-surface.md`, `docs/spec/contracts.md`,
`docs/spec/protocol-flows.md`, `docs/brief.md` §6, `docs/spec/templates/*.json`,
`docs/schema-engine.md` §5/§10 (referenced by tool descriptions).

Conformance claims were checked against the live MCP 2026-07-28 spec pages
(changelog, `basic/index` (`_meta`), `basic/patterns/mrtr`, `server/tools`,
`docs/extensions/tasks`) fetched from modelcontextprotocol.io on 2026-08-23.
Items I could not verify against a fetched page are marked **verify against spec**.

Severity: **B** = blocks/will fail on the wire or breaks agents outright;
**M** = repeated agent failure mode / conformance gap with a workaround;
**L** = polish, foot-gun, or documentation hole.

---

## Part A — MCP 2026-07-28 conformance

### A1. **B** MRTR `inputRequests` shape is not the spec shape
**Where:** `docs/mcp-surface.md` §0.4; `docs/spec/contracts.md` `mrtr.ts`;
`docs/spec/protocol-flows.md` F5, F6.
**Scenario:** The docs define `inputRequests` as an **array** of
`{ id, kind: "confirmation"|"approval", message, schema }` — a bespoke DeepCRM
discriminated union. The 2026-07-28 spec defines `inputRequests` as a **map**
whose values MUST be one of the *standard* request objects
(`elicitation/create`, `sampling/createMessage`, `roots/list`) with real
`method`/`params` fields, e.g.
`{ "confirm": { "method": "elicitation/create", "params": { "mode": "form", "message": "…", "requestedSchema": {…} } } }`.
`kind: "confirmation"` / `kind: "approval"` do not exist in the protocol. A
spec-conformant client (and the whole point of MRTR is that the *client*, not
the agent, fulfills these) will not know what to do with this array; DeepCRM's
confirmation flow silently degrades to "client ignores it, agent retries with
a made-up `inputResponses` blob".
**Fix:** Re-express both flows as standard elicitations:
`inputRequests: { confirm: { method: "elicitation/create", params: { mode: "form", message, requestedSchema: { properties: { confirmed: { type: "boolean" } }, required: ["confirmed"] } } } }`,
and the retry's `inputResponses.confirm` is an `ElicitResult`
`{ action: "accept", content: { confirmed: true } }`. The approval flow carries
the token server-side in `requestState` (see A2), not as a bespoke
`approval_token` field the agent must echo in a non-standard envelope.

### A2. **B** No `requestState`; retry correlation is underspecified and replayable
**Where:** `docs/mcp-surface.md` §0.4; `docs/spec/protocol-flows.md` F5/F6.
**Scenario:** The spec's retry carries `requestState` (opaque, integrity-protected
blob) alongside `inputResponses`, and servers "MUST NOT inspect-modify-assume"
rules apply to the client. F6 relies on `approval_token` + "identical args" and
an `arguments_hash` stored in an `approval_requests` row — server-side state,
which the spec tolerates but the docs never state how the retry is bound to the
original request absent `requestState`. Worse, §0.4's confirmation example has
no state at all: the client retries `crm_attribute_archive` with
`inputResponses: { confirm: { confirmed: true } }` — nothing binds that
confirmation to the object/attribute/count that was shown, so a stale
confirmation can be replayed against a different archive call by a buggy or
racing client. The spec explicitly says servers for which state must be
consumed at most once MUST enforce that server-side; F6 does this for approvals
but F5 confirmations have no such binding described.
**Fix:** Mandate `requestState` on every `InputRequiredResult` (HMAC-protected
payload: principal, tool name, args hash, impact summary, TTL), require the echo,
and document it in §0.4/F5/F6. This also unblocks truly stateless horizontal
scaling of the API.

### A3. **M** `inputResponses` is not part of any tool's input schema
**Where:** `docs/spec/contracts.md` `tools.ts` (no `inputResponses` anywhere);
`mrtr.ts` defines `InputResponses` standalone.
**Scenario:** In the spec, the retry is "the original request plus
`inputResponses`/`requestState`" at the protocol params level, not inside the
tool's `arguments`. If DeepCRM expects `inputResponses` inside `arguments`
(the docs are ambiguous — F5 shows it glued onto the call), then (a) zod schemas
strip/reject unknown keys, so the retry fails validation; (b) a conformant
client puts it at params level and the server never sees it. Either way the
round-trip breaks in one of the two plausible readings.
**Fix:** State explicitly: `inputResponses` and `requestState` live in
`tools/call` *params*, sibling to `arguments`; the server unwraps them before
zod validation. Add this to §0.4 and F5.

### A4. **M** `resultType: "complete"` required on all results; never mentioned
**Where:** `docs/mcp-surface.md` §0.3, §0.4; `docs/spec/protocol-flows.md` F1.
**Scenario:** 2026-07-28 changelog item 8: all results carry a required
`resultType` (`"complete"` / `"input_required"`). The docs only ever show
`resultType` on the MRTR path; F1's success example has none. An implementer
following these docs produces results a strict 2026-07-28 client flags as
legacy/pre-revision.
**Fix:** Add to §0.3: every result carries `resultType: "complete"` unless it is
an `InputRequiredResult`; show it in F1.

### A5. **M** Tasks: creation result shape, capability gating, `tasks/update` missing
**Where:** `docs/mcp-surface.md` §0.5; `docs/spec/protocol-flows.md` F7.
**Scenario:** Three gaps vs the extension docs (modelcontextprotocol.io
`docs/extensions/tasks`):
1. Task creation must be a `CreateTaskResult` with `resultType: "task"` and a
   `Task` object (`taskId`, initial status, `ttlMs`, `pollIntervalMs`) — and the
   server MUST NOT return it unless the client declared
   `extensions: { "io.modelcontextprotocol/tasks": {} }` in per-request
   `clientCapabilities`. The docs return a plain tool result `{ task_id }` and
   specify no capability check or fallback for non-tasks clients.
2. `tasks/update` exists in the extension (mid-flight input) — docs mention only
   `tasks/get`/`tasks/cancel`. If any long job ever needs input (e.g. a bulk
   import hitting an approval-gated row), there is no documented path.
3. `task_id` vs spec `taskId` casing is unspecified for the wire.
**Fix:** §0.5: return `resultType: "task"` per the extension; define behavior
when the client didn't opt in (run synchronously up to a cap, or
`MissingRequiredClientCapabilityError` -32021); document `tasks/update` support
(or explicitly "not supported"); use `taskId` on the wire.

### A6. **M** Cache hints: wrong shape and illegal `cacheScope` value
**Where:** `docs/mcp-surface.md` §0.1.
**Scenario:** Spec (`server/tools` result example; changelog SEP-2549): `ttlMs`
and `cacheScope` are **top-level result fields** on list/read results, and
`cacheScope ∈ {"public","private"}`. The docs put them under
`_meta["io.modelcontextprotocol/cache"]` and invent `cacheScope: "tenant"`,
which is not a legal value — a client keying shared caches on it will treat it
as garbage. The custom `etag = schema_version` is fine as an extension field but
should also be documented as DeepCRM-vendor `_meta`, not implied to be spec.
**Fix:** Emit `ttlMs: 300000, cacheScope: "private"` as top-level fields on
`tools/list`, `resources/list`, `resources/read`, `prompts/list` (tenant-scoped
data ⇒ `"private"`, never `"public"`); keep `etag` as a documented
`live.deepcrm/` vendor `_meta` key.

### A7. **M** `server/discover` is MUST in 2026-07-28; undocumented
**Where:** absent from `docs/mcp-surface.md` §0.1 and `docs/spec/protocol-flows.md`.
**Scenario:** Changelog item 3: servers MUST implement `server/discover`
(protocol versions, capabilities incl. the tasks extension, identity). The docs
describe server info `{ name, version }` but no discover RPC, so a conformant
client's first call gets `-32601`.
**Fix:** Add `server/discover` to §0.1 with the advertised extensions
(`io.modelcontextprotocol/tasks`) and supported version list.

### A8. **L** Per-request `_meta` and header requirements only stated in passing
**Where:** `docs/spec/protocol-flows.md` intro line; `docs/brief.md` §3.3.
**Scenario:** `io.modelcontextprotocol/protocolVersion` and
`clientCapabilities` are REQUIRED on every request (missing ⇒ -32602 / HTTP 400);
`Mcp-Method`/`Mcp-Name` headers are REQUIRED on Streamable HTTP POSTs.
`mcp-surface.md` §0.1 (the normative surface doc) says neither; only the flows
doc mentions them once. Server-side enforcement behavior (reject vs tolerate)
is undefined.
**Fix:** §0.1: state the required inbound `_meta` fields and headers and the
exact rejection behavior; state that every result carries
`_meta["io.modelcontextprotocol/serverInfo"]` (the docs' "Server info" bullet
does not say where it goes).

### A9. **L** `GET /mcp` 405 conflicts with `subscriptions/listen` if ever adopted
**Where:** `docs/mcp-surface.md` §0.1.
**Scenario:** 2026-07-28 replaces GET/SSE with `subscriptions/listen`, a
long-lived POST stream. Today's "no server-initiated messages" is coherent, but
the docs don't say whether `subscriptions/listen` is unimplemented (-32601) —
and nothing can push `toolsListChanged`/`resourcesListChanged` (schema changes!)
to clients, which makes the 5-minute `ttlMs` the only staleness control.
`schema.changed` webhooks exist (§8) but that's a different consumer.
**Fix:** State explicitly that `subscriptions/listen` is not implemented and
that schema staleness is signaled via `SCHEMA_CONFLICT`/`UNKNOWN_ATTRIBUTE`
errors (F2) — or plan the subscription. Also: `resources/read` on
`crm://schema` should carry `ttlMs` (it's `CacheableResult` too); only
`tools/list` is mentioned in §0.1/F2.

### A10. **L** No resource *templates* registered despite `{param}` URIs
**Where:** `docs/mcp-surface.md` §1.
**Scenario:** `crm://schema/{object_type}` and `crm://views/{slug}` are template
URIs. Conformant discovery requires `resources/templates/list` entries with
`uriTemplate` (RFC 6570), else clients can't know `{object_type}` is a variable.
The docs only tabulate static-looking URIs and never mention
`resources/templates/list`. Also minor doc drift: brief §6.6 says
`crm://views/{id}`, mcp-surface says `{slug}`.
**Fix:** Register two resource templates; align the URI variable on `slug`
everywhere.

### A11. **L** `structuredContent`/`content` convention diverges from spec guidance
**Where:** `docs/mcp-surface.md` §0.3.
**Scenario:** Spec: "a tool that returns structured content SHOULD also return
the serialized JSON in a TextContent block" (backwards compatibility). DeepCRM
instead returns a *one-line summary* as `content[0].text`. That's legal, but
clients that read only `content` (older or simpler hosts) then cannot see e.g.
the record id or the `next_cursor` — exactly the values the agent needs to
continue. For mutation tools whose text summary is "Anna Novak (person)" the
id never reaches a text-only client.
**Fix:** Either serialize the JSON into `content` per spec guidance, or at
minimum guarantee the text summary always contains the primary id/cursor.

### A12. **L** Deterministic `tools/list` order not specified
**Where:** `docs/mcp-surface.md` §10; absent.
**Scenario:** Changelog minor 3: servers SHOULD return tools in deterministic
order for client caching/prompt-cache hits. `pnpm docs:mcp` regeneration implies
generation order; unstated whether registration order is stable.
**Fix:** One line in §10: tools are registered and listed in the fixed order of
§2–§8.

### A13. **L** `description` length: no cap in the spec; self-imposed 300 is fine but unverified by tooling
**Where:** `docs/mcp-surface.md` §10.
**Scenario:** The 300-char cap is DeepCRM's own rule (for find/load meta-tools),
not a spec limit. Current longest registered descriptions: `crm_merge_records`
254 chars, `crm_record_create` 253, `crm_data_quality` 198 — all under 300
today, but nothing enforces it and the fixes proposed in Part B will push
several descriptions past 300, forcing a choice between the cap and
actionability.
**Fix:** Add a lint/test asserting ≤300 (or drop the cap to a documented
higher number) — and decide now whether description body or a companion
`docs`-style resource carries the long guidance (see B2).

---

## Part B — Agent ergonomics

### B1. **B** `crm_record_assert` and `crm_record_get` cannot use the template's unique attributes
**Where:** `docs/spec/contracts.md` `CrmRecordAssert.in.match_attribute`;
`docs/schema-engine.md` §4 write path ("assert: …look up `record_unique_keys`");
`docs/spec/templates/standard_crm.json` (`emails`, `domains` are
`is_multi: true, is_unique: true`).
**Scenario:** Every doc flow uses `match_attribute: "emails"` / `"domains"`,
but nothing defines how the matcher picks the lookup *value* for a multi-value
unique attribute. If the intended semantic is "any element of
`data.emails` matches any stored key", then an upsert where *different* elements
of the submitted array collide with *different* existing records (anna@→record1,
anovak@→record2) has no documented outcome: update both? pick one? error? A
mid-tier agent will hit this on the second import. `crm_record_get`'s
`value` for `match_attribute: "emails"` is likewise undefined (scalar element?
array?).
**Fix:** Normative rule in `mcp-surface.md` §3 and schema-engine §4: for a
multi-value unique match attribute, the match value is the *first array
element* (or: every element must resolve to the same record, else
`DUPLICATE_FOUND` with all candidates). Same rule for `crm_record_get.value`.
Also state that `match_attribute` MUST be `is_unique` (docs imply it; the error
code for passing a non-unique attribute — `VALIDATION_FAILED`? — is unnamed).

### B2. **M** Description-only guidance for the Filter grammar; agents will flail
**Where:** `docs/mcp-surface.md` §3 `crm_records_query` ("Filter grammar: see
`schema-engine.md` §5"); `docs/spec/contracts.md` `filter.ts`
(`.describe('see docs/schema-engine.md §5')`).
**Scenario:** An agent consuming the live server cannot see
`docs/schema-engine.md`. Its only in-band help is the zod `.describe()` text
(a URL-less pointer to a doc file) plus whatever the client shows of the
recursive `Filter` JSON Schema — and zod-lazy recursive unions often render
poorly or circularly through `zod-to-json-schema`, so the agent may see a
useless `$ref` loop. Consequence: trial-and-error querying with
`VALIDATION_FAILED` on op/type mismatches (the op-by-type table lives only in
docs too).
**Fix:** (a) Ship the grammar in-band: a `crm://help/filtering` resource (or a
`docs` field in `crm_schema_get`) with the op-by-type table and 3 worked
examples; (b) make `VALIDATION_FAILED` issues spell out the allowed ops for the
attribute's type ("op 'contains' not valid on type 'date'; use gte/lte/between");
(c) verify the generated JSON Schema for `Filter` is actually navigable
(verify against SDK output) — if not, flatten to a non-recursive schema with
`maxDepth`.

### B3. **M** `data` null-clearing vs `is_multi` and required attributes is under-specified
**Where:** `docs/spec/contracts.md` `CrmRecordUpdate.in.data` (`.describe('null
clears a value')`); `mcp-surface.md` §3.
**Scenario:** Three foot-guns: (1) patch `{ emails: null }` on a required
multi attribute — rejected (`VALIDATION_FAILED`) or silently kept? Undocumented.
(2) Patch `{ tags: [] }` — is `[]` a clear or a no-op distinct from `null`?
Undocumented. (3) An agent that fetched a record with `redacted_attributes`
and echoes `data` back in an update will null-clear or validate-fail on
attributes it cannot see; nothing warns it. Mid-tier models do exactly this
round-trip.
**Fix:** Define in §0.2/§3: `null` = unset (rejected with `VALIDATION_FAILED`
on `is_required`); `[]` = set to empty list (distinct from clear); and make
`redacted_attributes` present-but-omitted so echo-back patches are naturally
safe, plus an error message that names the redacted attribute when it is
written.

### B4. **M** create vs assert vs bulk_assert: decision rule exists but is load-bearing in one sentence
**Where:** `docs/mcp-surface.md` §3 descriptions.
**Scenario:** `crm_record_assert`'s description says "The safe default for any
sync or import" — good. But `crm_record_create`'s description doesn't say
"prefer `crm_record_assert` unless you intentionally want duplicates surfaced",
so a fresh agent doing a one-off insert has a coin flip. Worse, there's no
guidance for "I have 30 rows" (loop `assert` vs `bulk_assert` Task overhead) or
"I have 3 rows but no unique attribute on the type" (assert is unavailable —
fall back to create + `crm_find_duplicates`, but no tool description says so).
`DEEPCRM_MAX_BULK_ROWS`'s value is discoverable nowhere in-band; an agent
submitting 5,000 rows learns the cap only from a `LIMIT_EXCEEDED` it cannot
predict.
**Fix:** Cross-reference in descriptions ("for one-off inserts; syncing? use
crm_record_assert; >N rows? crm_records_bulk_assert"), add a `LIMIT_EXCEEDED`
detail field carrying the numeric cap, and consider exposing caps via
`crm://schema` or server `server/discover` metadata.

### B5. **M** record_get vs records_query vs search: no "which read do I use" story in descriptions
**Where:** `docs/mcp-surface.md` §3, §7.
**Scenario:** Three read tools overlap: `crm_record_get` (by id or unique
value), `crm_records_query` (structured filter), `crm_search` (free text). The
descriptions each describe *what*, none describe *when instead of the
neighbour*. Classic failure: agent has "Anna at Asahi" and calls `crm_search`
(wasteful, fuzzy) when `crm_records_query` with
`{ attribute: "emails", op: "eq" }` is exact; or calls `crm_records_query` with
a `text` filter when `crm_search` semantic would be better. Also,
`crm_records_query`'s filter `{ text }` node duplicates `crm_search
mode: keyword` — two tools doing the same thing with different words, which the
repo's own rule-zero calls a defect.
**Fix:** Add "use X when / use Y instead" clauses to all three descriptions
(budget allowing; see A13), and either drop the `{ text }` filter node or
document it strictly as the composable-in-`and` variant for narrowing.

### B6. **M** Linking: two mechanisms (inline `links[]` vs `crm_link`) with contradictory failure modes
**Where:** `docs/mcp-surface.md` §3/§4; `docs/spec/contracts.md` `LinkInput`.
**Scenario:** `crm_record_create/assert` accept `links[]`; `crm_link` exists
separately. Undocumented: is a create with a failing link (bad target id,
cardinality replace) atomic — record created but link dropped, or whole call
fails? If the record is created and one link fails, the agent cannot retry the
call (idempotency key would return the stored partial result) and must discover
`crm_link` itself. Cardinality is also a silent foot-gun: `crm_link` on a
`*_to_one` relation "replaces the existing one" — an agent linking a person to
a new employer unknowingly ends the old employment link; the description says
it, but the result `{ link }` does not report the replaced link id, so the
agent can't narrate or undo what happened.
**Fix:** Document atomicity (recommended: all-or-nothing) in §3; add
`ended_links: [link_id]` to `crm_link`'s output when replacement occurred.

### B7. **M** Errors don't consistently say what to do next
**Where:** `docs/spec/contracts.md` `errors.ts`; `docs/schema-engine.md` §10.
**Scenario:** Good: `DUPLICATE_FOUND` carries candidates; `VERSION_CONFLICT`
carries `current`; `MERGED` carries `redirect_to`. Gaps:
- `POLICY_DENIED {resource, action}` doesn't say whether an approval can change
  the outcome — agent can't distinguish "ask an admin" from "never possible".
- `APPROVAL_REQUIRED` (F6 rejections) returns a `detail` string but no
  structured `approval_token`/next-step; the agent must parse prose.
- `CARDINALITY_VIOLATION` and `DELETE_RESTRICTED` carry no offending link id,
  so the agent can't offer the fix ("end link X first").
- `LIMIT_EXCEEDED` names no limit (see B4).
- `VALIDATION_FAILED.issues[].path` — JSON Pointer vs dotted path is unstated;
  agents guess wrong on array indices.
- No error code at all for "task not found / task already terminal" on
  `tasks/get`/`tasks/cancel` (raw JSON-RPC -32602?).
**Fix:** Extend `ErrorPayload`: add `next: string` (machine-checkable hint
enum: `retry_with_approval`, `fetch_and_retry`, `use_redirect`, `fix_input`,
`fatal`) and code-specific ids (`link_id`, `limit`). Document `path` format as
JSON Pointer (RFC 6901).

### B8. **M** Cursor handling: mixing/misuse modes unspecified
**Where:** `docs/spec/contracts.md` `Cursor` (".describe('opaque cursor from a
previous page')"); `mcp-surface.md` §0.2.
**Scenario:** Agents routinely mutate filters mid-pagination ("same query but
now only open deals") and pass the old cursor. Nothing says whether that's
rejected, silently wrong, or fine. `crm_changes_since`'s cursor is a *seq*
(stringified int, "omit for oldest"), a different animal from query cursors,
but both are typed `Cursor` with the same description — an agent that feeds a
query `next_cursor` into `crm_changes_since` gets undefined behavior. Also:
do cursors expire (retention)? `has_more` exists on `crm_changes_since` but
not on `crm_records_query` (must infer from `next_cursor: null` — fine, but
unstated).
**Fix:** State in §0.2: cursors are bound to (tool, tenant, full argument set);
a mismatched cursor returns `VALIDATION_FAILED { detail: "cursor_mismatch" }`;
change-feed cursors are a distinct namespace (different field description,
different error); document retention/expiry.

### B9. **M** No batch get / count — guaranteed chatty flows
**Where:** `docs/mcp-surface.md` §3 (absent).
**Scenario:** Two flows every agent hits: (1) "here are 40 person ids from an
external system, give me their records" — requires 40 `crm_record_get` calls or
an `in` filter hack on a synthetic attribute; (2) "how many deals are open?" —
requires paginating `crm_records_query` (max 200/page) just to count, or
`include_total: true` (exists in contracts.ts but is missing from the
mcp-surface.md input column — doc drift), which fetches a page anyway. A
`crm_records_count` or `aggregate(group_by, metrics)` covers both;
`crm_pipeline_summary` only works for status pipelines.
**Fix:** Add `crm_records_count { object_type, filter } → { count }`
(cheap, exact) and `crm_records_get_many { ids } → { records, missing }`.
Also fix the `include_total` omission in mcp-surface.md §3.

### B10. **L** No undo of a single change; no schema diff
**Where:** `docs/mcp-surface.md` §2/§3 (absent); change feed §8.
**Scenario:** (1) An agent sets the wrong stage on a deal. It can read
`crm_record_history` and issue a corrective `crm_record_update`, but there's no
`crm_change_revert { change_id }` — for multi-attribute damage (a bad bulk
import row) the agent must reconstruct old values by hand from `Change.old_value`,
and `old_value` is typed `unknown` so its shape per attribute type is
undocumented. (2) After a teammate applies a template, an agent holding a stale
`crm://schema` cache has no way to ask "what changed since schema_version 12"
— only full re-read. Given `schema.changed` webhooks exist, a
`crm_schema_changes_since { version }` is the natural read.
**Fix:** Consider `crm_change_revert` (scope: `set`/`unset` kinds only) and a
schema diff tool, or explicitly document the manual-recovery recipe in
`crm_record_history`'s description.

### B11. **L** `crm_unlink`'s triple form can target the wrong link; result confirms nothing
**Where:** `docs/spec/contracts.md` `CrmUnlink`.
**Scenario:** With `relation_type + from + to` on a `many_to_many` relation that
has *history* (link ended and re-created), the active link is presumably unique
— but if data drift leaves two active, which ends? Undocumented. Output
`{ unlinked: true }` doesn't echo the `link_id` that was ended, so the agent
cannot record or reverse it precisely (a re-`crm_link` creates a *new* link id,
losing the edge attributes of the old one).
**Fix:** Return `{ link_id }`; document the ambiguity behavior
(error `CARDINALITY_VIOLATION`-style if >1 active, or deterministic newest).

### B12. **L** Approval flow relies on a *different principal* retrying — auth interaction undocumented
**Where:** `docs/spec/protocol-flows.md` F6; `docs/mcp-surface.md` §0.4.
**Scenario:** F6 says the retry must "come from a principal whose role is
admin/owner" — but the retry carries `X-UOA-Delegation` for *that* admin while
the agent identity stays in `X-Nessie-Context`. Now the change's `actor` is
`agent:<id>` but `on_behalf_of` flips from the original user to the approving
admin — silently rewriting provenance, and no doc says which identity lands on
`record_changes.actor/on_behalf_of` for the approved write. An agent planning
"the human approved, I'll retry" can accidentally make the admin the owner of
every subsequent write in the run if delegation tokens are cached per-run.
**Fix:** Document in F6 exactly which headers change on the approval retry and
what lands in `Change.actor`/`on_behalf_of`; recommend scoping the admin
delegation to the single retry call.

### B13. **L** `owner` appears twice with different types; `Actor` on writes is forgeable-looking
**Where:** `docs/spec/contracts.md` `RecordOut.owner: Actor.nullable()` vs
`person.owner` attribute (`actor_reference`) in `standard_crm.json`;
`CrmRecordCreate.owner: Actor.optional()`.
**Scenario:** Two confusions: (1) The template gives `person` an *attribute*
named `owner` while every record also has a system `owner` field — agents will
set `data.owner` expecting the record-level field, or vice versa. (2) Callers
pass `owner`/`assignee` as free-text `Actor { type, id }` — no tool validates
that `human:usr_x` exists (it's an external UOA id; fair) but nothing in the
description warns that a typo silently attributes ownership to a nonexistent
user, and there's no tool to resolve "which human id is Alice?".
**Fix:** Rename the system field in prose ("record owner (responsibility)" vs
attribute), or drop the template's `owner` attribute in favor of the system
field; add `.describe()` warning that Actor ids are not validated against UOA.

### B14. **L** `crm_view_run` vs `crm_records_query` duplication; views lack list/delete
**Where:** `docs/mcp-surface.md` §5.
**Scenario:** `crm_view_run` is `crm_records_query` with a saved filter —
defensible — but there's no `crm_view_delete`/`crm_view_archive` (stale views
accumulate and pollute `crm://views/{slug}` forever) and no `crm_view_list`
other than… nothing (the resource lists one view by slug; how does an agent
enumerate view slugs? `crm://views/{slug}` requires knowing the slug; only
`crm_schema_get` might carry them — brief §6.1 says the schema resource
includes "views" but `mcp-surface.md` §1's `crm://schema` body and
`SchemaSnapshot` in contracts.ts do not include views. Doc drift.)
**Fix:** Add view lifecycle tools (or document views as immutable-once-saved),
add views to `SchemaSnapshot` (aligning contracts.ts with brief §6.1), and a
`crm://views` index resource.

### B15. **L** `crm_export` has no idempotency/reason; `crm_webhook_set` rotation story missing
**Where:** `docs/spec/contracts.md` `CrmExport.in`, `CrmWebhookSet.in`.
**Scenario:** (1) `crm_export` is a mutating-ish, approval-gated, expensive
tool yet takes neither `reason` nor `idempotency_key` — a retried double-click
spawns two jobs and two signed URLs; audit has no "why". (2)
`crm_webhook_set` "Register (or update)" — updating the URL for an existing
webhook: by what key? There's no `id` input; is it upsert-by-URL? If an agent
calls set twice with the same URL, does the second call rotate `secret`
(invalidating the first)? Undocumented, and the secret is "shown once", so the
failure mode is a silently dead webhook.
**Fix:** Add `reason?`/`idempotency_key?` to `CrmExport`; define webhook
identity (upsert by URL? return existing without rotating secret unless
`rotate_secret: true`).

### B16. **L** Prompts reference tools by name but their arguments/types are thin
**Where:** `docs/mcp-surface.md` §9.
**Scenario:** `crm/clean-duplicates` says "merge only with human confirmation"
but the merge path is *approval-gated* (F6), and the prompt doesn't state that
the gate is enforced server-side (an agent could read the prompt as "I should
ask", then skip it when the human isn't around). Prompts/get results format
(messages array) is also unspecified, and there's no
`resources/templates/list`/prompts caching statement (prompts/list is
CacheableResult too).
**Fix:** Note in the prompt text that approval is enforced by the server, not
by the agent's good behavior; document the prompts/get message shape; add
`ttlMs`/`cacheScope` note for prompts/list.

### B17. **L** Timeline `hops: 1` fan-out is unbounded in the doc
**Where:** `docs/mcp-surface.md` §6 `crm_record_timeline`.
**Scenario:** "hops: 1 also includes linked records (a company's people and
deals)" — for a company with 5,000 people, the interleaved timeline is
dominated by strangers' activities; no per-linked-record cap or
`relation_type` filter exists, and `limit` semantics across hops (total items?
per record?) is unstated. Agents will call this on big accounts and get noise.
**Fix:** Document limit semantics under hops=1; consider a `relation_types?:`
argument; at minimum warn in the description.

### B18. **L** Template/tool drift: `saas`, `agency` are valid enum values but don't exist
**Where:** `docs/spec/contracts.md` `CrmTemplateApply.in.template`
(`z.enum(['standard_crm','saas','agency'])`); `docs/spec/templates/` (only
`standard_crm.json`, `system.json`); schema-engine §9 says "later `saas`,
`agency`"; `crm://templates` resource lists "available" templates.
**Scenario:** An agent reads the enum in the tool schema, calls
`crm_template_apply { template: "saas" }`, and gets… `NOT_FOUND`?
`VALIDATION_FAILED`? Either way the enum advertised a capability that 404s —
the exact "agent can't discover what actually works" failure rule-zero exists
to prevent. Hard-coding template slugs in the zod enum also means the enum must
be redeployed to add a template, while `crm://templates` implies dynamism.
**Fix:** Make `template` a plain `Slug` (or `z.string()`) validated against the
template registry at call time, with `UNKNOWN_TEMPLATE { available: [...] }`
error; or ship the two missing template files before this enum ships.

### B19. **L** `crm_data_quality` buckets are capped at 100 items with no cursor
**Where:** `docs/spec/contracts.md` `QualityBucket` (`items: … .max(100)`).
**Scenario:** A workspace with 5,000 stale records returns `count: 5000` +
100 items and *no pagination* — the agent can fix 100, re-run, get overlapping
100, with no cursor or offset. The tool's own description ("the agent decides
what to fix") promises a remediation loop the shape can't support at scale.
**Fix:** Add `cursor?`/`bucket?` pagination or return record-ids-only pages;
at minimum document the cap in the description.

### B20. **L** `crm_search` returns no cursor and no `total`
**Where:** `docs/spec/contracts.md` `CrmSearch`.
**Scenario:** `limit` max 50, no `next_cursor` — "show me more like that" is
impossible; the agent must re-query with a bigger limit and re-receive
duplicates. Minor, but it breaks the otherwise uniform pagination convention
of §0.2, so agents' generic "keep paging" habit fails silently here.
**Fix:** Add an optional cursor (or document search as intentionally
single-page in the description).

---

## Cross-cutting note

The single highest-leverage fix is A1+A2 (MRTR shape + `requestState`): the
confirmation/approval flows are DeepCRM's main human-in-the-loop story, and as
documented they are not interoperable with any spec-conformant 2026-07-28
client — the pattern works only if the Nessie client hand-implements DeepCRM's
bespoke envelope. Second is B1: the template's flagship attributes
(`emails`, `domains`) are exactly the ones whose upsert semantics are undefined.
