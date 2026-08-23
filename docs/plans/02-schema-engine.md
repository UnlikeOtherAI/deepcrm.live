# Phase 2 — Schema engine

Outcome: object types, attributes, relation types, templates, records, links, history, unique keys and matching work through `packages/schema-engine` + `api/src/services`, with property tests green. No MCP yet.

### T09 — Attribute type registry

**Depends on:** T08. **Spec:** `docs/schema-engine.md` §3.

**Files (create) in `packages/schema-engine/src/attribute-types/`:**
- `types.ts` — `AttributeTypeDef`, `FilterOp` union (`eq neq in not_in is_null is_not_null contains starts_with gt gte lt lte between`).
- One file per type listed in §3 (`text.ts`, `rich-text.ts`, `number.ts`, `currency.ts`, `percent.ts`, `boolean.ts`, `date.ts`, `datetime.ts`, `select.ts`, `status.ts`, `rating.ts`, `email.ts`, `phone.ts`, `url.ts`, `domain.ts`, `location.ts`, `personal-name.ts`, `actor-reference.ts`, `record-reference.ts`, `timestamp-system.ts`, `json.ts`), each exporting `const def: AttributeTypeDef`.
- `registry.ts` — `export const attributeTypes: Record<AttributeType, AttributeTypeDef>`; `getAttributeType(type)`.
- `index.ts`.
- Tests `attribute-types.test.ts`: for every type, a valid value passes, an invalid fails; `normalize` cases: `email` `" Anna@Example.COM "` → `anna@example.com`; `phone` `"+44 20 7946 0958"` → `+442079460958`; `domain` `"https://www.Example.co.uk/x"` → `example.co.uk`; `personal_name` derives `full`; `currency` rejects `amount: 1.005` as number (must be string).

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/schema-engine` green; `ls packages/schema-engine/src/attribute-types/*.ts | wc -l` ≥ 24.

---

### T10 — Schema metadata service

**Depends on:** T09. **Spec:** `docs/schema-engine.md` §2, §9; `docs/spec/contracts.md` (`schema-specs.ts` — copy verbatim).

**Files:**
- Create `packages/schemas/src/schema-specs.ts`, `attribute-values.ts`, `attribute-config.ts` — copied from `docs/spec/contracts.md`.
- Create `packages/schema-engine/src/schema/load.ts` — `loadSchema(db, tenant): Promise<LoadedSchema>` (object types with attributes, relation types, matching rules; maps by slug and id); in-process cache keyed `teamId:schemaVersion` (read `teams.schema_version` first).
- Create `packages/schema-engine/src/schema/mutate.ts` — inside one transaction each: `defineObjectType`, `updateObjectType`, `archiveObjectType`, `defineAttribute`, `updateAttribute`, `archiveAttribute`, `defineRelationType`, `archiveRelationType`, `setMatchingRules`. Rules: slug unique per tenant (`SCHEMA_CONFLICT`); `record_reference` attribute ⇒ also create/lookup its backing `RelationType` (`slug = <objectType>_<attr>`, `projectionAttributeSlug = attr`, cardinality `many_to_one` or `many_to_many` when `isMulti`); `status` never `isMulti`; `isUnique` only when `supportsUnique`; every mutation ends with `UPDATE teams SET schema_version = schema_version + 1` and `writeAudit`.
- Create `api/src/services/schema.ts` — policy-checked wrappers (`checkPolicy(ctx,'schema','define',…)`), calling the engine; `getSchema(ctx, objectType?)`.
- Create `api/src/services/policy.ts` — `checkPolicy` per auth-and-tenancy §4 (deny absolute; role from `ctx.onBehalfOf.role`; agent bindings `agent:<app>:<agentId>`) and `seedDefaultPolicies(tx, tenant)` inserting the rows from `packages/db/src/policy-defaults.json` (copy `docs/spec/policy-defaults.json` there; **imported**, so it lands in `dist` via `resolveJsonModule` — never `fs.readFile`; mapping: JSON snake_case → Prisma camelCase, `bindings: [[actorType, actorId]]` tuples → `PolicyBinding` rows). Do not wire a call site — T11 does. Unit tests: deny-absolute, priority among allows, `requires_approval` surfaced.
- Tests (DB): define type + attributes + relation; duplicate slug conflict; `schema_version` increments; archive hides from `loadSchema` but row remains.

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/schema-engine --filter=@deepcrm/api` green; `node scripts/lint-tenant-where.mjs` exits 0.

---

### T11 — Templates and tenant provisioning

**Depends on:** T10. **Spec:** `docs/schema-engine.md` §9; `docs/spec/templates/system.json` and `standard_crm.json` (copy verbatim).

**Files:**
- Copy `docs/spec/templates/system.json` and `standard_crm.json` into `packages/schema-engine/src/templates/` unchanged; **import them** (`resolveJsonModule` inlines into dist — never `fs.readFile`, the Docker image copies only `dist`); define `TemplateSchema` (zod) that both parse against.
- Create `packages/schema-engine/src/templates/apply.ts` — `applyTemplate(tx, tenant, actor, slug)`: idempotent (skip existing slugs), returns `{ added }`; `listTemplates()`.
- Edit `api/src/services/tenancy.ts` — on first creation of a team: `seedDefaultPolicies` + `applyTemplate(system)`.
- Tests (DB): applying `standard_crm` twice adds nothing the second time; provisioning creates `activity`, `note`, `task`, `activity_about`.

**Acceptance:** tests green; `node -e "JSON.parse(require('fs').readFileSync('packages/schema-engine/src/templates/standard_crm.json'))"`.

---

### T12 — Record validation and normalisation

**Depends on:** T11. **Spec:** `docs/schema-engine.md` §4 steps 2–3.

**Files:**
- Create `packages/schema-engine/src/records/validate.ts` — `validateRecordData(schema, objectType, patch, mode: 'create'|'update'): { data; linkOps; issues }` → throws `ServiceError('VALIDATION_FAILED', …, { issues })` (paths are RFC 6901 JSON Pointers); rejects unknown/archived/system slugs; applies `default_value` on create; `isMulti` arrays de-duplicated by `normalize`; `null` unsets / `[]` empty list per §4 step 3; **extracts `record_reference` values into `linkOps`** (never into `data`, §4a); enforces the 256 KiB `data` cap; canonicalises object values (fixed key order) for JSONB equality. There is no shadow map — normalized match state lives in `record_match_keys` (§6).
- Create `packages/schema-engine/src/records/display-name.ts` — `computeDisplayName(schema, objectType, data)`.
- Unit tests with the `standard_crm` template loaded from JSON (no DB): required on create, null unsets on update, email normalisation, unknown attribute error lists the slug.

**Acceptance:** engine tests green.

---

### T13 — Write path: create, update, assert, delete, restore

**Depends on:** T12. **Spec:** `docs/schema-engine.md` §4 (all steps).

**Files:**
- Create `packages/schema-engine/src/records/locks.ts` — `lockRecords(tx, ids)` (sorted, `pg_advisory_xact_lock(hashtext($1))`).
- Create `packages/schema-engine/src/records/unique-keys.ts` — `syncUniqueKeys(tx, …)` writing `(attribute_id, normalizedHash, normalizedValue)`; maps `P2002` to `DUPLICATE_FOUND` (colliding id by `(attribute_id, normalized_hash)`, returned only when the caller may view it). `syncMatchKeys(tx, …)` for block rules (compound sha-256, §6).
- Create `packages/schema-engine/src/records/changes.ts` — `diffChanges(before, after)` → `RecordChange` inserts (`set`/`unset` per slug); `writeChanges(tx, …)`.
- Create `packages/schema-engine/src/records/write.ts` — `createRecord`, `updateRecord`, `assertRecord`, `deleteRecord`, `restoreRecord` each `(tx, ctx, schema, input, linkWriter: LinkWriter)` performing **§4 steps 0–14** (policy stays in the service; feed-seq allocation and both enqueues — `record.reindex` AND `change.deliver` — are steps 13–14 and belong here). `LinkWriter` is a **required parameter** — T13's tests pass a throwing stub and use reference-free inputs; T14 supplies the real one (no no-op default — AGENTS.md bans sentinels). `assert` implements the savepoint retry-as-update (§4b, first-element rule for multi). Until T38, reads of a merged id throw `MERGED { redirect_to }`; T38 replaces this with the transitive redirect.
- Create `api/src/services/records.ts` — transaction + policy + `writeAudit`; idempotency per §4 step 0 (reserve in-tx, fill result in the same commit, `IDEMPOTENCY_IN_PROGRESS` on a live duplicate).
- Tests (DB, `api/test/db/records.test.ts`): create person → version 1, `create` change with `seq` allocated; update email → `set` change with old/new; assert by email updates not creates; **two concurrent asserts of the same new email produce one record** (savepoint path); unique collision ⇒ `DUPLICATE_FOUND` with record id; version conflict; soft delete releases the email key (a new person can claim it) and restore then yields `RESTORE_CONFLICT`; idempotent replay returns the same record id and a concurrent same-key call gets `IDEMPOTENCY_IN_PROGRESS`.

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/api --filter=@deepcrm/schema-engine` green; `node scripts/lint-tenant-where.mjs` exits 0.

---

### T14 — Links and cardinality, record_reference projection

**Depends on:** T13. **Spec:** `docs/schema-engine.md` §4 step 9, §2 `RecordLink`.

**Files:**
- Create `packages/schema-engine/src/links/write.ts` — `linkRecords(tx, ctx, schema, { relationType, from, to, data?, label? })`: validate both records (tenant, type allowed, not deleted/merged), validate `data` against `edgeAttributes`, enforce cardinality (end conflicting active links with `active_until`), insert, write `link` changes on both records; `unlinkRecords` (set `active_until`, `unlink` changes); `listLinks`.
- Create `packages/schema-engine/src/links/projection.ts` — implements `LinkWriter`: for `record_reference` attributes, diff desired ids vs active links and call `linkRecords`/`unlinkRecords`; `projectLinksIntoData(schema, objectType, links)` computes the reference values **for serialized output only** (§4a — nothing is written into `records.data`).
- Edit `api/src/services/records.ts` to construct the real `LinkWriter`; link/unlink write paired change rows (shared `group_id`) and bump `version` on both endpoints (§4 steps 6, 11).
- Create `api/src/services/links.ts`.
- Tests (DB): person `works_at` company via `record_reference` ⇒ link row, and `crm`-level read projects it into output `data.company`; re-pointing ends the old link (result reports `ended_links`); many_to_many edge data `role` stored; `restrict` on delete (checked after locks).

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
- Create `packages/schema-engine/src/records/history.ts` — `recordAt(tx, tenant, recordId, at)` replays `set`/`unset` changes from `create` up to `at` for stored attributes, and reconstructs reference/link state from link changes and `active_from`/`active_until` (returned as `links`); `recordHistory(tx, …)`. Both redact by **current** sensitivity (auth §5).
- Edit `api/src/services/records.ts` — expose both with policy + redaction.
- Tests (DB): create, update twice with explicit `occurred_at` spacing, `recordAt(t1)` returns the middle state.

**Acceptance:** tests green.

---

### T18 — Property tests for engine invariants

**Depends on:** T17. **Spec:** `docs/testing.md` §4.

**Files:** create `packages/schema-engine/test/db/properties.test.ts` with fast-check: random custom object type (3–6 attributes incl. one unique email and one `record_reference` to `company`), 20–60 random ops, then invariants: (a) stored `records.data` equals replay of `set`/`unset` changes (references excluded — they are not stored, §4a); (b) serialized reference output equals active `record_links`; (c) `record_unique_keys` equals normalized unique values of live records; plus (e) every change row has a `seq` and per-team seqs are strictly increasing in commit order. `numRuns: 25`. (Invariant (d) merge/unmerge comes in T39.)

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/schema-engine` green in < 3 min.
