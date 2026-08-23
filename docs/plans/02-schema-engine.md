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
- Create `api/src/services/policy.ts` — `checkPolicy` per auth-and-tenancy §4 and `seedDefaultPolicies(tx, tenant)` inserting the rows from `docs/spec/policy-defaults.json` (copy the file to `packages/schema-engine/src/policy-defaults.json`; called from `resolveTenant` on first creation). Unit test for deny-overrides and priority.
- Tests (DB): define type + attributes + relation; duplicate slug conflict; `schema_version` increments; archive hides from `loadSchema` but row remains.

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/schema-engine --filter=@deepcrm/api` green; `node scripts/lint-tenant-where.mjs` exits 0.

---

### T11 — Templates and tenant provisioning

**Depends on:** T10. **Spec:** `docs/schema-engine.md` §9; `docs/spec/templates/system.json` and `standard_crm.json` (copy verbatim).

**Files:**
- Copy `docs/spec/templates/system.json` and `standard_crm.json` into `packages/schema-engine/src/templates/` unchanged; define `TemplateSchema` (zod) that both files parse against.
- Create `packages/schema-engine/src/templates/apply.ts` — `applyTemplate(tx, tenant, actor, slug)`: idempotent (skip existing slugs), returns `{ added }`; `listTemplates()`.
- Edit `api/src/services/tenancy.ts` — on first creation of a team: `seedDefaultPolicies` + `applyTemplate(system)`.
- Tests (DB): applying `standard_crm` twice adds nothing the second time; provisioning creates `activity`, `note`, `task`, `activity_about`.

**Acceptance:** tests green; `node -e "JSON.parse(require('fs').readFileSync('packages/schema-engine/src/templates/standard_crm.json'))"`.

---

### T12 — Record validation and normalisation

**Depends on:** T11. **Spec:** `docs/schema-engine.md` §4 steps 2–3.

**Files:**
- Create `packages/schema-engine/src/records/validate.ts` — `validateRecordData(schema, objectType, patch, mode: 'create'|'update'): { data: ValidatedData; issues: Issue[] }` → throws `ServiceError('VALIDATION_FAILED', …, { issues })`; rejects unknown/archived/system slugs; applies `default_value` on create; `isMulti` arrays de-duplicated by `normalize`; computes `_n` shadow map `{ slug: normalized }` for normalised-matching attributes.
- Create `packages/schema-engine/src/records/display-name.ts` — `computeDisplayName(schema, objectType, data)`.
- Unit tests with the `standard_crm` template loaded from JSON (no DB): required on create, null unsets on update, email normalisation, unknown attribute error lists the slug.

**Acceptance:** engine tests green.

---

### T13 — Write path: create, update, assert, delete, restore

**Depends on:** T12. **Spec:** `docs/schema-engine.md` §4 (all steps).

**Files:**
- Create `packages/schema-engine/src/records/locks.ts` — `lockRecords(tx, ids)` (sorted, `pg_advisory_xact_lock(hashtext($1))`).
- Create `packages/schema-engine/src/records/unique-keys.ts` — `syncUniqueKeys(tx, tenant, schema, objectType, recordId, before, after)`; maps unique violation (`P2002`) to `DUPLICATE_FOUND` with the colliding `record_id` (query by `(attribute_id, normalized_value)`).
- Create `packages/schema-engine/src/records/changes.ts` — `diffChanges(before, after)` → `RecordChange` inserts (`set`/`unset` per slug); `writeChanges(tx, …)`.
- Create `packages/schema-engine/src/records/write.ts` — `createRecord`, `updateRecord`, `assertRecord`, `deleteRecord`, `restoreRecord` each taking `(tx, ctx, schema, input)` and performing §4 steps 2–11 (policy is the service's job; links are T14 — here only `record_reference` handling is delegated to a `LinkWriter` interface with a no-op default so T13 compiles alone). `expected_version` ⇒ `VERSION_CONFLICT`. Deleted/merged targets ⇒ `NOT_FOUND` / `MERGED { redirect_to }`.
- Create `api/src/services/records.ts` — transaction + policy + `writeAudit` + `enqueue('record.reindex')`; `idempotency_key` handling via `idempotency_replays`.
- Tests (DB, `api/test/db/records.test.ts`): create person → version 1, change row `create`; update email → `set` change with old/new; assert by email updates not creates; unique email collision ⇒ `DUPLICATE_FOUND` with record id; version conflict; soft delete then get ⇒ `NOT_FOUND`, restore works; idempotent replay returns same record id.

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/api --filter=@deepcrm/schema-engine` green; `node scripts/lint-tenant-where.mjs` exits 0.

---

### T14 — Links and cardinality, record_reference projection

**Depends on:** T13. **Spec:** `docs/schema-engine.md` §4 step 9, §2 `RecordLink`.

**Files:**
- Create `packages/schema-engine/src/links/write.ts` — `linkRecords(tx, ctx, schema, { relationType, from, to, data?, label? })`: validate both records (tenant, type allowed, not deleted/merged), validate `data` against `edgeAttributes`, enforce cardinality (end conflicting active links with `active_until`), insert, write `link` changes on both records; `unlinkRecords` (set `active_until`, `unlink` changes); `listLinks`.
- Create `packages/schema-engine/src/links/projection.ts` — implements the `LinkWriter` from T13: for `record_reference` attributes, diff desired ids vs active links and call `linkRecords`/`unlinkRecords`; `projectLinksIntoData(schema, objectType, links)` rebuilds `data[slug]`.
- Edit `records/write.ts` to use the real `LinkWriter`.
- Create `api/src/services/links.ts`.
- Tests (DB): person `works_at` company via `record_reference` ⇒ link row + projection; re-pointing ends the old link; many_to_many edge data `role` stored; `restrict` on delete.

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
- Create `packages/schema-engine/src/matching/evaluate.ts` — `findMatches(tx, tenant, schema, objectType, data, excludeRecordId?)` → `Candidate[]` per method (`exact`, `normalized` via `_n` shadow keys / unique keys, `fuzzy` via `similarity(display_name, $) >= threshold`).
- Edit `records/write.ts` — step 7: `block` ⇒ `DUPLICATE_FOUND { candidates }`, `warn` ⇒ attach `duplicates` to result.
- Tests (DB): standard template rule "company by normalised name warn": creating "Asahi Europe " when "asahi europe" exists returns `duplicates` with evidence; email block rule refuses.

**Acceptance:** tests green.

---

### T17 — History: record_at and record_history

**Depends on:** T16. **Spec:** `docs/mcp-surface.md` §3 (`crm_record_at`, `crm_record_history`).

**Files:**
- Create `packages/schema-engine/src/records/history.ts` — `recordAt(tx, tenant, recordId, at)` replays `record_changes` up to `at` from the `create` change (apply `set`/`unset`); `recordHistory(tx, tenant, recordId, { attributes?, cursor?, limit })`.
- Edit `api/src/services/records.ts` — expose both with policy + redaction.
- Tests (DB): create, update twice with explicit `occurred_at` spacing, `recordAt(t1)` returns the middle state.

**Acceptance:** tests green.

---

### T18 — Property tests for engine invariants

**Depends on:** T17. **Spec:** `docs/testing.md` §4.

**Files:** create `packages/schema-engine/test/db/properties.test.ts` with fast-check: generate a random custom object type (3–6 attributes of random types incl. one unique email and one `record_reference` to `company`), 20–60 random ops (create/update/assert/link/unlink/delete/restore), then assert invariants (a)–(c) from testing.md (d comes in T39). `numRuns: 25`.

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/schema-engine` green in < 3 min.
