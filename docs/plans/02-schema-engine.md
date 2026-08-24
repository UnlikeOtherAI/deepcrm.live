# Phase 2 — Schema engine

Outcome: object types, attributes, relation types, templates, records, links, history, unique keys and matching work through `packages/schema-engine` + `api/src/services`, with property tests green. No MCP yet.

### T09 ✅ — Attribute type registry

**Depends on:** T08. **Spec:** `docs/schema-engine.md` §3.

**Files (create) in `packages/schema-engine/src/attribute-types/`:**
- `types.ts` — `AttributeTypeDef`, `FilterOp` union (`eq neq in not_in is_null is_not_null contains starts_with gt gte lt lte between`).
- Exactly 22 per-type files: `text`, `rich-text`, `number`, `currency`, `percent`, `boolean`, `date`, `datetime`, `select`, `status`, `rating`, `email`, `phone`, `url`, `domain`, `registry-id`, `location`, `personal-name`, `actor-reference`, `record-reference`, `timestamp-system`, `json`; plus `types.ts`, `registry.ts`, `index.ts` = exactly 25 production files.
- `registry.ts` — `export const attributeTypes: Record<AttributeType, AttributeTypeDef>`; `getAttributeType(type)`; exact key equality with all 22 `AttributeType` values.
- `index.ts`.
- Direct dependencies: `ajv@^8` (Draft 2020-12, no external refs) and `decimal.js` (reject-not-round number precision, canonical non-exponent decimals). Tests cover the full capability matrix: text YYY; rich_text YNN; number YYY; currency YNN; percent YNY; boolean YYY; date YYY; datetime YYY; select YYY; status NNY; rating YNY; email YYY; phone YYY; url YYY; domain YYY; registry_id YYY; location YNN; personal_name YYN; actor_reference YYN; record_reference YNY; timestamp_system NNN; json YNN. Cover phone `+` international input/no guessing, domain hostname or http(s) URL→tldts registrable lowercase, JSON 2020-12/Ajv/no refs/64KiB, Gregorian date, RFC3339 offset→UTC millisecond Z, select unique ids/status unique contiguous positions, ISO/fixed currency, URL canonicalization, and record_reference’s record_links/EXISTS-only indexing.

**Acceptance:** engine tests green; registry keys equal `AttributeType` exactly; `find packages/schema-engine/src/attribute-types -maxdepth 1 -name '*.ts' | wc -l` prints `25`.

---

### T10 ✅ — Schema metadata service

**Depends on:** T09. **Spec:** `docs/schema-engine.md` §2, §9; `docs/spec/contracts.md` (`schema-specs.ts` — copy verbatim).

**Files:**
- Create `packages/schemas/src/primitives.ts`, `schema-specs.ts`, `attribute-values.ts`, `attribute-config.ts` — copied verbatim from the same-named blocks in `docs/spec/contracts.md`; edit `packages/schemas/src/index.ts` to export them.
- Create `packages/schema-engine/src/schema/load.ts` — `loadSchema(db, tenant): Promise<LoadedSchema>` (object types with attributes, relation types, matching rules; maps by slug and id); in-process cache keyed `teamId:schemaVersion` (read `teams.schema_version` first).
- Create `packages/schema-engine/src/schema/mutate.ts` — inside one transaction each: `defineObjectType`, `updateObjectType`, `archiveObjectType`, `defineAttribute`, `updateAttribute`, `archiveAttribute`, `defineRelationType`, `archiveRelationType`, `setMatchingRules`. Rules: slug unique per tenant (`SCHEMA_CONFLICT`); `record_reference` attribute ⇒ create its backing `RelationType` per §4f — **every `record_reference` owns exactly one backing relation, never shares one**: `slug = <objectType>_<attr>`, `projectionAttributeSlug = attr`, cardinality `many_to_one` (scalar) or `many_to_many` (`isMulti`), `to_object_type_id` from `config.objectTypes` (null for multi-slug open targets); a caller-supplied `config.relationTypeSlug` must match on cardinality/from/to/projection or `SCHEMA_CONFLICT`. A compatible supplied relation whose `projectionAttributeSlug` is unset is atomically claimed by setting it to this attribute slug; a relation already claimed by another attribute is `SCHEMA_CONFLICT`. `record_reference` may be `isIndexed`: this is link-backed metadata for `record_links`/`EXISTS` filtering, never a `records.data` expression index or `attribute.index` DDL job. `defineRelationType`/`updateRelationType` validate `edge_attributes` against `AttributeSpec` (max 20, same zod as `schema-specs.ts`); `status` never `isMulti`; `isUnique` only when `supportsUnique`; every mutation ends with `UPDATE teams SET schema_version = schema_version + 1` and `writeAudit`.
- Create `api/src/services/schema.ts` — policy-checked wrappers (`checkPolicy(ctx,'schema','define',…)`), calling the engine; `getSchema(ctx, objectType?)`.
- Create `api/src/services/policy.ts` — `checkPolicy` per auth-and-tenancy §4 (deny absolute; role from `ctx.onBehalfOf.role`; agent bindings `agent:<app>:<agentId>`) and `seedDefaultPolicies(tx, tenant)` inserting the rows from `packages/db/src/policy-defaults.json` (copy `docs/spec/policy-defaults.json` there; **imported**, so it lands in `dist` via `resolveJsonModule` — never `fs.readFile`; mapping: JSON snake_case → Prisma camelCase, `bindings: [[actorType, actorId]]` tuples → `PolicyBinding` rows). Do not wire a call site — T11 does. Unit tests: deny-absolute, priority among allows, `requires_approval` surfaced.
- Tests (DB): define type + attributes + relation; duplicate slug conflict; `schema_version` increments; archive hides from `loadSchema` but row remains.

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/schema-engine --filter=@deepcrm/api` green; `node scripts/lint-tenant-where.mjs` exits 0.

---

### T11 ✅ — Templates and tenant provisioning

**Depends on:** T10. **Spec:** `docs/schema-engine.md` §9; `docs/spec/templates/system.json` and `standard_crm.json` (copy verbatim).

**Files:**
- Copy `docs/spec/templates/system.json` and `standard_crm.json` into `packages/schema-engine/src/templates/` unchanged; **import them** (`resolveJsonModule` inlines into dist — never `fs.readFile`, the Docker image copies only `dist`); define `TemplateSchema` (zod) that both parse against.
- Create `packages/schema-engine/src/templates/apply.ts` with `TemplateAdded = { objectTypes: number; attributes: number; relationTypes: number; matchingRules: number }`, `applyTemplateBatch(tx, tenant, actor, slug): Promise<{ added: TemplateAdded }>`, public `applyTemplate(tx, tenant, actor, slug): Promise<{ added: TemplateAdded }>`, and `listTemplates()`. The caller owns **one transaction** and takes the namespace-3 provisioning advisory lock before any write. `applyTemplateBatch` is the trusted internal seam: it performs exactly four passes in this order — (1) object-type shells with primary unset, (2) explicit relation types, (3) attributes and compatible supplied `record_reference` projection claims, (4) primaries plus matching rules — and never increments a version or writes an audit. It may pass the template's typed `isSystem` relation flag to the shared internal relation primitive, but must not expose projection ownership through the public schema mutation API. Independently absent object-type, attribute, and relation-type slugs are added; existing rows are never updated or archived. Primaries and matching rules are assigned only to object types created by this application. Any existing row referenced by a new definition must be compatible or the whole transaction fails. Public `applyTemplate` calls the batch seam, increments `schemaVersion` exactly once iff the sum of `added` is non-zero, and writes exactly one terminal `schema.template.apply` audit; a zero-addition call changes neither version nor audit state.
- Edit `api/src/services/tenancy.ts` — after authentication and the tenant allowlist gate but before any provisioning write, take the namespace-3 lock; **only when the team row was first created**, call `seedDefaultPolicies` and `applyTemplateBatch(system)` in the same caller transaction. Provisioning does not call public `applyTemplate`: after policy seeding and the template batch both succeed, it increments `policyVersion` exactly once for the seeded defaults and `schemaVersion` exactly once iff the system-template `added` total is non-zero, then writes exactly one terminal `tenant.provisioned` audit. Existing teams do not receive implicit policy/template mutation.
- Tests (DB): both imported JSON templates parse through `TemplateSchema`; applying `standard_crm` twice returns zero for every `added` field the second time and changes neither version nor audit state; partial pre-existing compatible definitions are left byte-for-byte unchanged while independently absent slugs are added; incompatible referenced definitions roll back the whole transaction; template system relations persist `isSystem: true` without exposing projection ownership; provisioning creates `activity`, `note`, `task`, `activity_about`, advances `schemaVersion` and `policyVersion` from 0 to 1 exactly once, and writes exactly one final `tenant.provisioned` audit row; resolving the existing team again changes none of them.

**Acceptance:** tests green; imported `system.json` and `standard_crm.json` parse through `TemplateSchema`; no production template path uses `fs`.

---

### T12 ✅ — Record validation and normalisation

**Depends on:** T11. **Spec:** `docs/schema-engine.md` §4 steps 2–3.

**Files:**
- Create `packages/schema-engine/src/records/validate.ts` — pure `validateRecordData(schema, objectType, currentData, patch, mode: 'create'|'update'): { data; linkOps; issues }` (no DB calls; T10 `LoadedSchema` maps/backing resolver are authoritative) → throws `ServiceError('VALIDATION_FAILED', …, { issues })` (paths are RFC 6901 JSON Pointers). Reject unknown/archived slugs plus only reserved virtual slugs (`id`, `created_at`, `updated_at`, `last_activity_at`, `display_name`, `owner`) and `timestamp_system`/future explicit virtual-read-only types; `Attribute.isSystem` alone remains writable. Apply `default_value` on create; `isMulti` arrays de-duplicated by `normalize`. For ordinary stored attributes, `null` unsets/removes the key (and is rejected on `isRequired`); `[]` is a distinct stored empty list and is valid even when required. **Extract `record_reference` values into `linkOps: LinkIntent[]`** (never into `data`, §4a): omitted leaves links untouched; scalar null clears; multi null/`[]` clears; otherwise exact replace. Enforce the 256 KiB data cap and canonical fixed-key object values. There is no shadow map — normalized match state lives in `record_match_keys` (§6).
- Create `packages/schema-engine/src/records/display-name.ts` — `computeDisplayName(schema, objectType, data)`.
- Unit tests with the `standard_crm` template loaded from JSON (no DB): required on create, null unsets on update, email normalisation, unknown attribute error lists the slug.

**Acceptance:** engine tests green.

---

### T13 — Write path: create, update, assert, delete, restore

**Depends on:** T12. **Spec:** `docs/schema-engine.md` §4 (all steps).

**Files:**
- Create `packages/schema-engine/src/records/locks.ts` — `lockRecords(tx, ids)` (sorted, `pg_advisory_xact_lock(hashtext($1))`).
- Create `packages/schema-engine/src/records/unique-keys.ts` — `syncUniqueKeys(tx, …)` writing `(attribute_id, normalizedHash, normalizedValue)`; maps `P2002` to `DUPLICATE_FOUND` (colliding id by `(attribute_id, normalized_hash)`, returned only when the caller may view it). `syncMatchKeys(tx, …)` for block rules (compound sha-256, §6).
- Create `packages/schema-engine/src/records/changes.ts` — `diffChanges(before, after)` → change **intents** (`set`/`unset` per slug); `writeChanges(tx, …)` performs the step-12 seq block allocation then inserts rows carrying `{ …, resultingVersion, seq }`. A create emits the `create` marker row plus one `set` row per stored attribute of the initial state (defaults included), **every row carrying `resulting_version = 1`** (§4 step 11).
- Create `packages/schema-engine/src/records/write.ts` — `createRecord`, `updateRecord`, `assertRecord`, `deleteRecord`, `restoreRecord` each `(tx, ctx, schema, input, linkWriter: LinkWriter)` performing **§4 steps 0–14** (policy stays in the service; feed-seq block allocation is step 12, change-row inserts + both enqueues — `record.reindex` AND `change.deliver` — step 13, and the audit insert is **step 14, the last DB operation of the transaction** — all belong here). `LinkWriter` is a **required parameter** — T13's tests pass a throwing stub and use reference-free inputs; T14 supplies the real one (no no-op default — AGENTS.md bans sentinels). `assert` implements the savepoint retry-as-update (§4b, first-element rule for multi). Until T38, reads of a merged id throw `MERGED { redirect_to }`; T38 replaces this with the transitive redirect.
- Create `api/src/services/records.ts` — transaction + policy + `writeAudit`; idempotency per §4 step 0 (reserve in-tx, fill result in the same commit, `IDEMPOTENCY_IN_PROGRESS` on a live duplicate).
- Tests (DB, `api/test/db/records.test.ts`): create person → version 1, `create` change with `seq` allocated and `resulting_version = 1` on the marker and every initial `set` row; the `audit_logs` insert is verifiably the transaction's last write; update email → `set` change with old/new; assert by email updates not creates; **two concurrent asserts of the same new email produce one record** (savepoint path); unique collision ⇒ `DUPLICATE_FOUND` with record id; version conflict; soft delete releases the email key (a new person can claim it) and restore then yields `RESTORE_CONFLICT`; idempotent replay returns the same record id and a concurrent same-key call gets `IDEMPOTENCY_IN_PROGRESS`.

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/api --filter=@deepcrm/schema-engine` green; `node scripts/lint-tenant-where.mjs` exits 0.

---

### T14 — Links and cardinality, record_reference projection

**Depends on:** T13. **Spec:** `docs/schema-engine.md` §4 step 9, §2 `RecordLink`.

**Files:**
- Create `packages/schema-engine/src/links/write.ts` — `linkRecords(tx, ctx, schema, { relationType, from, to, data?, label? })`: validate both records (tenant, type allowed, not deleted/merged), validate `data` against `edgeAttributes`, enforce cardinality **in all four directions** (`many_to_one`: end conflicting active outgoing links of `from`; `one_to_many`: end conflicting active incoming links of `to`; `one_to_one`: both; `many_to_many`: none), insert, write `link` changes on both records; `unlinkRecords` (set `active_until`, `unlink` changes); `listLinks`.
- Create `packages/schema-engine/src/links/projection.ts` — implements `LinkWriter`: consumes the T12 `LinkIntent[]`, diffs desired ids vs the attribute's active backing links (via its one backing relation, §4f) and calls `linkRecords`/`unlinkRecords`; multi references write `position` = the target's index in the submitted array (contiguous 0-based; an interior end renumbers survivors to close the gap) — the `record_links_active_position_unique` partial index is the integrity backstop; direct links and scalar references keep `position = null`; replace-created links carry `data = {}` and surviving links retain their edge data (§4 step 10). `projectLinksIntoData(schema, objectType, links)` computes the reference values **for serialized output only**, multi ordered by `position` (§4a — nothing is written into `records.data`).
- Edit `api/src/services/records.ts` to construct the real `LinkWriter`; link/unlink write paired change rows (shared `group_id`) and bump `version` on both endpoints (§4 steps 6, 11).
- Create `api/src/services/links.ts`.
- Tests (DB): person `works_at` company via `record_reference` ⇒ link row, and `crm`-level read projects it into output `data.company`; re-pointing ends the old link (result reports `ended_links`); multi reference preserves submitted order in output (`position` round-trip) and an interior removal renumbers contiguously; omitted key on update leaves links untouched, explicit `[]` ends them all; cardinality enforced for `one_to_many` and `one_to_one` from the incoming side; many_to_many edge data `role` stored and retained across a re-point of an unrelated reference; `restrict` on delete (checked after locks).

**Acceptance:** tests green.

---

### T15 — Query compiler

**Depends on:** T14. **Spec:** `docs/schema-engine.md` §5.

**Files:**
- Create `packages/schemas/src/filter.ts` — copy from `docs/spec/contracts.md` (`filter.ts`).
- Create `packages/schema-engine/src/query/compile.ts` — `compileQuery(schema, objectType, { filter, sort, cursor, limit })` → `{ sql: Prisma.Sql, countSql }` using `Prisma.sql` fragments: `data->>'slug'` with casts (`::numeric`, `::timestamptz`, `::date`, `::boolean`), `?` / `@>` for multi, `EXISTS (SELECT 1 FROM record_links …)` for `linked_to`, `tsv @@ plainto_tsquery('simple', $)` join for `text`; always `organization_id = $ AND team_id = $ AND object_type_id = $ AND deleted_at IS NULL AND merged_into_id IS NULL`; keyset pagination on `(sortValue, id)`; unsupported op for type ⇒ `VALIDATION_FAILED`.
- Create `packages/schema-engine/src/query/run.ts` — `queryRecords(tx, tenant, schema, objectType, q)` → `{ records, next_cursor, total? }` (total only when `include_total`).
- Edit `api/src/services/records.ts` — add `queryRecords` with policy view check + attribute redaction (`redactForActor` in `api/src/services/redact.ts`, create).
- Tests: unit snapshot of generated SQL for the grammar example in §5; DB test with 30 seeded deals: stage `in`, amount `gte`, sort + cursor paging yields all 30 once.

**Acceptance:** tests green.

---

### T16 — Matching rules on create/assert

**Depends on:** T15. **Spec:** `docs/schema-engine.md` §6.

**Files:**
- Create `packages/schema-engine/src/matching/evaluate.ts` — `findMatches(tx, …)` → `Candidate[]`: `exact`/`normalized` warn rules via key-hash lookups, `fuzzy` via `similarity(display_name, $) >= threshold` (≥ 0.5, top 20); evidence redacted per §6.
- Edit `records/write.ts` — step 7/8: block rules enforced via `record_match_keys` unique violation ⇒ `DUPLICATE_FOUND { candidates }`; warn ⇒ attach `duplicates`. `crm_matching_rule_set` validation (block ⇒ exact/normalized only; fuzzy ⇒ warn, threshold ≥ 0.5) in `schema/mutate.ts`; setting a block rule enqueues `match-key-backfill`.
- Tests (DB): company fuzzy-name warn rule: creating "Asahi Europe " when "asahi europe" exists returns `duplicates` with evidence; person email block rule refuses **including under two concurrent creates** (the match-key constraint, not a read, is what blocks).

**Acceptance:** tests green.

---

### T17 — History: record_at and record_history

**Depends on:** T16. **Spec:** `docs/mcp-surface.md` §3 (`crm_record_at`, `crm_record_history`).

**Files:**
- Create `packages/schema-engine/src/records/history.ts` — `recordAt(tx, tenant, recordId, at)` replays `set`/`unset` changes in replay order exactly `occurred_at ASC, seq ASC` from `create` up to `at` for stored attributes (references are never in stored change values, §4a) and reconstructs reference/link state from link changes and `active_from`/`active_until` (returned as `links`, multi ordered by `position`); `version_at` derives from `resulting_version` of the latest change ≤ `at` (the field exists for exactly this). `recordAt` answers `NOT_FOUND` before the record's create and during any deleted interval (`at` between its `delete` and `restore` changes); restore resumes visibility from the restore point on. `recordHistory(tx, …)` pages changes keyset in cursor order exactly `occurred_at DESC, seq DESC, id DESC`; its cursor obeys the §0.2 rule — opaque, bound to the tool, the tenant and the canonical full argument set (including the `attributes` filter), mismatch ⇒ `VALIDATION_FAILED {detail: "cursor_mismatch"}`. Both redact by **current** sensitivity (auth §5); `snapshot` is never serialized (§4 step 11).
- Edit `api/src/services/records.ts` — expose both with policy + redaction.
- Tests (DB): create, update twice with explicit `occurred_at` spacing, `recordAt(t1)` returns the middle state with the correct `version_at`; history cursor from an unfiltered call rejected with `cursor_mismatch` when replayed with an `attributes` filter; `snapshot` fields absent from both outputs.

**Acceptance:** tests green.

---

### T18 — Property tests for engine invariants

**Depends on:** T17. **Spec:** `docs/testing.md` §4.

**Files:** create `packages/schema-engine/test/db/properties.test.ts` with fast-check: random custom object type (3–6 attributes incl. one unique email and one `record_reference` to `company`), 20–60 random ops, then invariants: (a) stored `records.data` equals replay of `set`/`unset` changes (references excluded — they are not stored, §4a); (b) serialized reference output equals active `record_links`, multi ordered by `position`; (c) `record_unique_keys` equals normalized unique values of live records; (e) every change row has a `seq` and per-team seqs are strictly increasing in commit order; (f) every change row with a `recordId` has non-null `resulting_version`, the last change's equals the record's current `version`, and a create's rows all carry `resulting_version = 1`; (g) projected multi reference links have contiguous 0-based positions, one active link per position. `numRuns: 25`. (Invariant (d) merge/unmerge comes in T39.)

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/schema-engine` green in < 3 min.
