# Phase 5 — Quality: search, duplicates, merge, data quality, export, approvals

Outcome: every tool in `docs/mcp-surface.md` exists; `NOT_YET` in the surface test is empty.

### T35 — Search tool

**Depends on:** T34. **Spec:** `docs/schema-engine.md` §8; `docs/mcp-surface.md` §7 (`crm_search`).

**Files:**
- Create `packages/schema-engine/src/search/query.ts` — `keywordSearch` (`ts_rank(tsv, plainto_tsquery('simple', $))`), `semanticSearch` (`embedding <=> $::vector`, needs `Embedder`), `hybridSearch` (RRF k=60 over top 50 each). Tenant + object-type filters; excludes deleted/merged.
- `api/src/services/search.ts` + tool in `api/src/mcp/tools/search.ts`; results redacted; `match` field.
- Tests (DB with FakeEmbedder): keyword finds by company domain token; hybrid returns union.

**Acceptance:** api tests green.

---

### T36 — Find duplicates Task

**Depends on:** T35. **Spec:** `docs/schema-engine.md` §6; `docs/mcp-surface.md` §7 (`crm_find_duplicates`).

**Files:**
- Create `worker/src/jobs/dedup-scan.ts` — for the object type: (1) groups from T16 `record_match_lookup_keys` joined only through the **active** rule generation (the unique `record_match_keys` block table cannot contain a duplicate group, and pending/collision-blocked generations are not effective behavior), (2) fuzzy active rules via `pg_trgm` similarity (≥ 0.5), (3) when `include_semantic`: nearest-neighbour pairs with cosine distance < 0.08; union-find into groups; evidence per pair, redacted through the same T16 tenant/visibility/record-policy/batched-attribute-policy seam; `progress`; one dedup scan per team at a time. `record_unique_keys` may contribute the unique evidence kind for a pair found by another method, but is never queried as though its unique index could contain a duplicate group.
- Tool `crm_find_duplicates` enqueues; result shape per §7.
- Tests (worker DB): three near-identical people ⇒ one group with two evidence kinds.

**Acceptance:** worker tests green.

---

### T37 — Merge planner (pure)

**Depends on:** T36. **Spec:** `docs/schema-engine.md` §7 steps 2–3.

**Files:** create `packages/schema-engine/src/merge/plan.ts` — `planMerge(schema, objectType, survivor, losers, lastSetAt, fieldChoices)` → `{ data, uniqueKeyMoves, fieldSources }`; unit tests: survivor non-null wins, newest among losers otherwise, multi union de-duplicated, `field_choices` override, invalid choice ⇒ `VALIDATION_FAILED`.

**Acceptance:** engine tests green.

---

### T38 — Merge execution and redirects

**Depends on:** T37. **Spec:** `docs/schema-engine.md` §7 steps 1, 4–7; `docs/mcp-surface.md` §7 (`crm_merge_records`).

**Files:**
- Create `packages/schema-engine/src/merge/execute.ts` — transaction with locks; re-point `record_links` (both columns), collapse duplicates keeping oldest, cardinality fix-ups, `list_entries` re-point, unique keys per plan (**keys follow data**, §7.3), and recompute T16 block/lookup match rows for the survivor and every changed projection source against current active/replacement generations after data+links finalise (derived match rows are never moved or snapshotted); losers `merged_into_id`/`deleted_at` **and chained-pointer re-point** (§7.6), `merge` changes with the **normative snapshot shape of §7.7** (repointedLinks/endedLinks/movedKeys/droppedKeys/movedEntries), reindex enqueue for survivor.
- Edit `records` read paths (`getRecord`, `recordAt`, links list): replace T13's `MERGED`-throw with the redirect — a loser id resolves to the survivor with `redirected_from` (one hop, kept true by chained re-pointing; `MERGED` only when the survivor is itself deleted). Update the T13 tests this changes.
- Service with policy `merge.merge` (approval default — MRTR handled in T42; until then admin-only in tests) + tool.
- Tests (DB): two people merged — links re-pointed and de-duplicated, loser `crm_record_get` returns survivor with `redirected_from`, unique email moved.

**Acceptance:** api + engine tests green.

---

### T39 — Unmerge and property invariant (d)

**Depends on:** T38. **Spec:** `docs/schema-engine.md` §7 step 8.

**Files:** `packages/schema-engine/src/merge/unmerge.ts` — consumes exactly the §7.7 snapshot (repointedLinks back, endedLinks un-ended, moved unique keys/entries resolved; T16 match block/lookup rows recomputed from restored data/links against current generations, never restored from stale rule ids; post-merge survivor changes win; unique/matching-rule/link/list-entry collisions returned as `conflicts` and no live record is left without required block keys), `unmerge` changes; tool `crm_unmerge`; extend `properties.test.ts` with invariant (d): merge then immediate unmerge ⇒ losers' `data`, active link sets, and current active/replacement match rows equal their pre-merge-derived state and `conflicts` is empty.

**Acceptance:** engine property tests green.

---

### T40 — Data quality report

**Depends on:** T39. **Spec:** `docs/mcp-surface.md` §7 (`crm_data_quality`).

**Files:** `packages/schema-engine/src/quality/report.ts` — four SQL queries (`missing_required` via schema + `data ? slug`; `stale` via `last_activity_at`; `orphans` = records on the **many side of a `many_to_one` relation whose `on_delete = restrict`** with zero active links — unemployed people are not orphans, company-less deals are; `collisions` = duplicate normalized hashes for attributes made unique after data existed); service + tool; each bucket returns `count`, ≤ 100 items, and a `query_filter` runnable via `crm_records_query`. Tests with seeded dirty data.

**Acceptance:** api tests green.

---

### T41 — Export Task

**Depends on:** T40. **Spec:** `docs/mcp-surface.md` §8 (`crm_export`).

**Files:**
- Create `api/src/services/exports.ts` + `worker/src/jobs/bulk-export.ts` — stream records (query compiler, page 500) into JSONL or CSV (RFC 4180, header from attribute slugs) written to `DEEPCRM_EXPORT_DIR` (new env, default `./.exports`; add to `docs/architecture.md` §6 and `.env.example`), file name `<jobId>.<ext>`.
- Create `api/src/routes/exports.ts` — `GET /exports/:jobId?sig=…&exp=…` serving the file when the HMAC (keyring **kid `export`**) of `jobId:exp` matches, `exp` is future, and the URL is unused (single-use marker on the job row); the architecture-§4 blessed exception. Export rows honour the approver's redaction and `DEEPCRM_MAX_EXPORT_ROWS`. Result `{ url, rows, expires_at }`.
- Retention: `worker/src/jobs/retention.ts` (create) — daily: delete export files older than 1 h, hard-delete records with `deleted_at < now - DEEPCRM_RETENTION_DAYS` (cascade), prune `idempotency_replays` older than 24 h. Register with a self-rescheduling enqueue (`visibleAt = now + 24h`, idempotency `retention:<date>`).
- Tests: export 12 deals as CSV through harness + embedded worker; download URL returns 200 with 13 lines; expired signature 403.

**Acceptance:** api + worker tests green. **Docs:** `docs/architecture.md` §6.

---

### T42 — Approvals via MRTR

**Depends on:** T41. **Spec:** `docs/auth-and-tenancy.md` §4; `docs/mcp-surface.md` §0.4; flow F6 in `docs/spec/protocol-flows.md`; `docs/spec/policy-defaults.json` (requires_approval rows already seeded in T10 — verify, do not re-seed).

**Files:**
- Create `api/src/services/approvals.ts` — `requireApproval(ctx, { tool, resourceType, resourceId, args, reason })`: when the matching rule has `requiresApproval` and `ctx.onBehalfOf.role` does not satisfy it: create `approval_requests` (pending, 24 h, token ≥128-bit CSPRNG stored as `continuation_token_hash`, canonical `arguments_hash` via `canonicalJson`, full `argumentsSnapshot`; caps 100/team, 10/requester, dedupe identical pending) and return the elicitation + `requestState` (approvalId inside). `consumeApproval(tx, ctx, state, args)`: verify `requestState`, then the conditional `pending→consumed` UPDATE **inside the mutation's transaction** with tenant + tool + hash + `required_role` exact + approver ≠ requester checks; execution uses the stored snapshot. Zero rows ⇒ `APPROVAL_REQUIRED {next: 'retry_with_approval'}`.
- Edit tools `crm_merge_records`, `crm_record_delete`, `crm_record_restore`, `crm_export`, `crm_webhook_set`, and the schema `define`/archive tools — wrap with the F6 flow (spec MRTR): approval elicitation + `requestState` out, `consumeApproval` on the retry.
- Verify the `requires_approval: true` rows from `docs/spec/policy-defaults.json` were seeded in T10 (`seedDefaultPolicies`); do not re-seed. For tenants provisioned before T10 shipped them there is nothing to migrate (no such tenants exist pre-launch).
- Tests: member principal merging ⇒ `input_required` with token; re-issue as admin principal with the token ⇒ merge succeeds; wrong args hash ⇒ error; expired ⇒ error.
- Edit `api/test/mcp/surface.test.ts` — replace the whole declaration line with exactly `const NOT_YET = []`.

**Acceptance:** `pnpm verify` green; `grep -Ec "NOT_YET(: string\[\])? = \[\]" api/test/mcp/surface.test.ts` prints `1`; `pnpm docs:mcp && git diff --exit-code docs/mcp-surface.md`.
