# Phase 7 — Visibility, suppression, erasure, origin guard

Outcome: the DeepSignal policy asks — round one **and the accepted round-two asks R1–R27** (`../../deepsignal.live/docs/plans/deepcrm-policy-asks.md`, triage in `docs/review-decisions.md`) — are implemented: per-record visibility, per-app provenance, the suppression store (channels/expiry/pinned normalizers), record erasure with its full reach, the write guard, schema-evolution semantics, and the search-tenancy chokepoint. Runs after Phase 5; independent of Phase 6 except T54.

Tool bookkeeping: T48 adds the six §7a tools to `NOT_YET` in `api/test/mcp/surface.test.ts` (they are documented before they exist); T50–T53 remove them as they land; the phase ends with `NOT_YET = []` again.

### T48 — Schema migration: visibility, suppression, origin, erase

**Depends on:** T42. **Spec:** `docs/schema-engine.md` §2 — the full compliance block: `Visibility`, `SuppressionKind/Channel/Reason`, `RecordVisibilityGrant`, `SuppressionEntry` (channel, subReason, expiresAt), `PrincipalLastSeen`, `Record.visibility/createdOnBehalfOf/origin/erasedAt`, `Team.rejectedOrigins/requireOrigin/teamVisibilityOnlyApps`, `Webhook.subscribingUoaUserId`, the `registry_id` attribute type, `record_search_model` index, `PolicyAction.erase`, `PolicyResourceType.suppression`.

**Files:**
- Edit `packages/db/prisma/schema.prisma` — apply exactly the §2 additions; new migration `visibility_compliance` (additive only; `lint:migrations` passes — no non-CONCURRENTLY indexes on the guarded tables outside init except none needed here).
- Edit `packages/db/src/policy-defaults.json` — sync from `docs/spec/policy-defaults.json` (the `record.erase` and `suppression.*` rows).
- Edit `scripts/lint-tenant-where.mjs` — add `recordVisibilityGrant`, `suppressionEntry` to the model list.
- Edit `api/test/mcp/surface.test.ts` — add the six §7a tools to `NOT_YET`.
- Backfill note: `records.created_on_behalf_of` is nullable; pre-existing rows (none in prod pre-launch) stay null and evaluate as `team`-visible only.

**Acceptance:** `pnpm --filter @deepcrm/db exec prisma migrate deploy && pnpm verify` green; `node scripts/lint-migrations.mjs` exits 0.

---

### T49 — Visibility gate in the engine

**Depends on:** T48. **Spec:** `docs/schema-engine.md` §4 step 1, §4c′; `docs/auth-and-tenancy.md` §4a.

**Files:**
- Create `packages/schema-engine/src/records/visibility.ts` — `canSee(ctx, record)` (pure); `visibilityWhere(ctx)` — the SQL fragment (`visibility = 'team' OR created_on_behalf_of = $ OR EXISTS (grant)`) composed into `compileQuery`, search, timeline, links-list, dedup-scan and `changesSince`.
- Edit `records/write.ts` — step 1 gate on every touched record (`NOT_FOUND` on fail); `visibility`/`visible_to` handling on create/update (grants diffed like links; `visible_to` implies `users`); merge requires all-visible, survivor keeps most-restrictive + union of grants; the owner-recovery path (widening an unseen record) is `record.edit` + approval with the owner bypassing only the *gate*, not redaction.
- Edit `unique-keys.ts` / `matching` — `DUPLICATE_FOUND` against an invisible record returns the generic form (no id, no candidates).
- Edit `api/src/mcp/tools/records.ts` — `visibility`, `visible_to`, `origin` arguments per contracts.
- Tests (DB): private record invisible to a second member principal and to an admin principal (NOT_FOUND, absent from query/search/timeline/links/feed); `users` grant admits exactly the listed human's agent; owner recovery flow widens it under approval; merge of mixed visibility keeps `private`; duplicate against invisible record leaks nothing.

**Acceptance:** api + engine tests green.

---

### T50 — Write guard + ordering

**Depends on:** T49. **Spec:** `docs/schema-engine.md` §4 step 3; `docs/spec/contracts.md` (`CrmOriginGuardSet`).

**Files:** engine checks in `validate.ts` (`ORIGIN_REJECTED {origin}` incl. `require_origin`; `VISIBILITY_REJECTED` for `team_visibility_only_apps`; `origin` set-once; **multi-value order preservation normative — R2**); `crm_write_guard_set` (owner) in a new `api/src/mcp/tools/compliance.ts`. Tests: rejected origin refused; origin-less write refused when required; a `visibility: users` write under a listed app key refused; guard change audited; origin immutable; a multi array round-trips in submitted order with first-occurrence dedup.

**Acceptance:** api tests green; `NOT_YET` shrinks by 1.

---

### T51 — Suppression store

**Depends on:** T50. **Spec:** `docs/schema-engine.md` §4d (suppression paragraph); `docs/spec/contracts.md` (`CrmSuppression*`).

**Files:**
- Create `packages/schema-engine/src/compliance/suppression.ts` — `suppressionHash(kind, value)` with the **pinned normalizers of §4d** (E.164-only phone; registry_id-style company_number; caller-pre-normalized postal), channel dimension, `expires_at` (refused on objection/erasure; expired ⇒ false; pruned by retention), `sub_reason`; raw values never persisted or logged.
- Tools in `tools/compliance.ts` (4); `crm_suppression_remove` approval-gated (`suppression.admin`).
- Tests (DB): add by email, check with a differently-cased/spaced variant ⇒ suppressed; channel `email` entry does not suppress `post` while an `all` entry suppresses both; expired entry answers false; `expires_at` on `objection` refused; national-format phone refused (E.164 only); company_number `01234567` ≡ `1234567`; list exposes hash not value; remove needs owner + approval; entries survive `dropTenant`.

**Acceptance:** api tests green; `NOT_YET` shrinks by 4.

---

### T52 — Erasure

**Depends on:** T51. **Spec:** `docs/schema-engine.md` §4d; `docs/auth-and-tenancy.md` §5 (erasure beats history).

**Files:**
- Create `packages/schema-engine/src/compliance/erase.ts` — the five §4d steps in one transaction (suppress-first incl. registry_id; scrub data/keys/search/grants/links **plus `record_links.data` and `list_entries.data` touching the record**; null historical values in place; tombstone; `reason` enum; enqueue `record.reindex_neighbours`); the feed emits typed `record.erased`; retention job (edit `worker/src/jobs/retention.ts`) skips tombstones and enforces the §4d residual bounds (completed jobs 7 d, approval rows expiry+30 d).
- Tool `crm_record_erase` (owner + approval) in `tools/compliance.ts`.
- Tests (DB): erase a person ⇒ data gone, edge/entry data cleared, history values nulled with rows/seqs intact, suppression entries exist for its emails, neighbour reindex enqueued, feed shows `record.erased`, `crm_record_get` ⇒ `ERASED`, unmerge/restore refuse, audit metadata value-free, chain verifies.

**Acceptance:** api + worker tests green; `NOT_YET` shrinks by 1.

---

### T53 — Webhook subscribing principal + per-app provenance

**Depends on:** T52. **Spec:** `docs/spec/events.md` §1 (webhook principal, value-free push); `docs/auth-and-tenancy.md` §1 (`DEEPCRM_APPS` registry, `X-App-Context` alias, `act` chain).

**Files:**
- (`Webhook.subscribingUoaUserId` already landed in T48's migration — R10.) Create the `principal_last_seen` upsert middleware (every authenticated request) + the PG-backed `seen_request_ids` unlogged table for the replay set.
- Edit `worker/src/jobs/change-deliver.ts` — events visibility-filtered as the subscribing principal; `confidential`/`restricted` values always omitted; deliveries pause when the subscriber is stale per `DEEPCRM_WEBHOOK_PRINCIPAL_STALE_DAYS` and resume on next authenticated call (R11).
- Edit `packages/mcp-inbound` — `X-App-Context` with the Nessie alias; **context claims `delegation_jti`/`tool`/`args_sha256` verified against the delegation and the actual call (R21)**; RFC 8693 `act` object flattened to `actChain` (R27); forward-compatible `tv` monotonic check (R22); `ActorContext.app`/`actChain` carried through to services and audit (R23); the `DEEPCRM_DIRECT_CLIENTS` strategy with the destructive-default-deny `app:direct` posture (R20); actor-reference validation against `principal_last_seen` (R25).
- Tests: webhook omits a private record's events and all restricted values; stale subscriber pauses delivery, next authenticated call resumes; context bound to a different delegation `jti`, tool or args hash ⇒ 401; nested `act` flattens correctly; a direct token authenticates but `crm_record_delete` is denied until an owner grants; owner set to an unseen uoaUserId ⇒ `VALIDATION_FAILED`; audit rows carry app + actChain.
- Edit `api/test/mcp/surface.test.ts` — `NOT_YET = []` again.

**Acceptance:** `pnpm verify` green; `pnpm docs:mcp && git diff --exit-code docs/mcp-surface.md`. **Docs:** architecture §6 (`DEEPCRM_APPS`).

---

### T54 — DeepSignal binding note (cross-repo, after T44)

**Depends on:** T53, T44. Written in the **deepsignal.live checkout** (worktree rule exempt): a short reply doc `docs/plans/deepcrm-policy-asks-response.md` recording what shipped for each ask (§1 visibility, §2 webhook principal + value-free push, §3 suppression/erasure, §4 Q5 decided org+team — org scope explicitly not available, §5 origin guard, §6 per-app registry + act chain) with links to the DeepCRM docs, so DeepSignal's integration plans build on the actual contract.

**Acceptance:** the file exists in deepsignal.live and links resolve.

---

### T55 — Schema evolution semantics (R9, R5a)

**Depends on:** T48. **Spec:** `docs/schema-engine.md` §3a.

**Files:** edit `packages/schema-engine/src/schema/mutate.ts` — normalize-affecting config changes refused without the key-recompute backfill Task (`worker/src/jobs/key-recompute.ts`, create); select/status option archive (never delete while referenced; archived = valid stored, invalid new); bounds-tightening MRTR + grandfathering; sensitivity-raise/archive/toSearchText-change ⇒ bulk `record.reindex` Task in the same commit. Tests (DB): text-normalisation change without backfill refused, with backfill re-hashes keys; archived option readable/filterable but unwritable; sensitivity raise reindexes (search content loses the value); grandfathered over-length value survives until its attribute is next written.

**Acceptance:** engine + worker tests green.

---

### T56 — Search chokepoint, model filter, similar_to, membership filters (R6, R13, R17, R4)

**Depends on:** T55. **Spec:** `docs/auth-and-tenancy.md` §3 (searchQuery chokepoint); `docs/schema-engine.md` §5 (`contains` on multi actor/record refs), §7 (merge multi ordering — R3), §8 (embedding_model filter, content assembly order — R14); `docs/spec/contracts.md` (`CrmSearch.similar_to`).

**Files:** `packages/schema-engine/src/search/query.ts` refactored so every raw SQL statement is composed by one audited `searchQuery()` interpolating `tenantWhere` + `visibilityWhere`; semantic queries filter `embedding_model = current`; `similar_to` nearest-neighbour mode; `compile.ts` gains `contains` on multi `actor_reference` (canonical element `@>`) and multi `record_reference` (via `linked_to`); merge planner implements survivor-first-append + wholesale `field_choices` override for multi; `buildSearchContent` implements the §8 assembly order incl. capped `rich_text`. Tests: the testing.md §5 cross-tenant adversarial test; mid-migration mixed models ⇒ only current-model rows rank; "records where actor X is in preferred_subowners" filter works; merged ranked list = survivor order + appended unseen.

**Acceptance:** `pnpm verify` green; `pnpm docs:mcp && git diff --exit-code docs/mcp-surface.md`.
