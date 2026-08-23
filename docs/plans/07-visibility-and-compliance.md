# Phase 7 — Visibility, suppression, erasure, origin guard

Outcome: the six DeepSignal policy asks (`../../deepsignal.live/docs/plans/deepcrm-policy-asks.md`, triaged in `docs/review-decisions.md` → "DeepSignal policy asks") are implemented: per-record visibility, per-app provenance, the suppression store, record erasure, and the origin write-guard. Runs after Phase 5; independent of Phase 6 except T54.

Tool bookkeeping: T48 adds the six §7a tools to `NOT_YET` in `api/test/mcp/surface.test.ts` (they are documented before they exist); T50–T53 remove them as they land; the phase ends with `NOT_YET = []` again.

### T48 — Schema migration: visibility, suppression, origin, erase

**Depends on:** T42. **Spec:** `docs/schema-engine.md` §2 (`Visibility`, `SuppressionKind/Reason`, `RecordVisibilityGrant`, `SuppressionEntry`, `Record.visibility/createdOnBehalfOf/origin/erasedAt`, `Team.rejectedOrigins`, `PolicyAction.erase`, `PolicyResourceType.suppression`).

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

### T50 — Origin guard

**Depends on:** T49. **Spec:** `docs/schema-engine.md` §4 step 3; `docs/spec/contracts.md` (`CrmOriginGuardSet`).

**Files:** engine check in `validate.ts` (`ORIGIN_REJECTED {origin}`; `origin` set-once); `crm_origin_guard_set` (owner) in a new `api/src/mcp/tools/compliance.ts`; `Team.rejectedOrigins` service in `api/src/services/schema.ts`. Tests: write with rejected origin refused; guard change audited; origin recorded on the record and immutable.

**Acceptance:** api tests green; `NOT_YET` shrinks by 1.

---

### T51 — Suppression store

**Depends on:** T50. **Spec:** `docs/schema-engine.md` §4d (suppression paragraph); `docs/spec/contracts.md` (`CrmSuppression*`).

**Files:**
- Create `packages/schema-engine/src/compliance/suppression.ts` — `suppressionHash(kind, value)` (normalize via the attribute-type registry, then `sha256hex(kind + '\x1f' + normalized)`), add/check/list/remove; raw values never persisted or logged.
- Tools in `tools/compliance.ts` (4); `crm_suppression_remove` approval-gated (`suppression.admin`).
- Tests (DB): add by email, check with differently-cased/spaced variant ⇒ suppressed; list exposes hash not value; remove needs owner + approval; entries survive `dropTenant` (no FK — verify rows remain after org delete).

**Acceptance:** api tests green; `NOT_YET` shrinks by 4.

---

### T52 — Erasure

**Depends on:** T51. **Spec:** `docs/schema-engine.md` §4d; `docs/auth-and-tenancy.md` §5 (erasure beats history).

**Files:**
- Create `packages/schema-engine/src/compliance/erase.ts` — the five §4d steps in one transaction (suppress-first, scrub data/keys/search/grants/links, null historical `old_value`/`new_value`/`snapshot` in place, tombstone, audit); direct reads of an erased record ⇒ `ERASED`; retention job (edit `worker/src/jobs/retention.ts`) skips tombstones.
- Tool `crm_record_erase` (owner + approval) in `tools/compliance.ts`.
- Tests (DB): erase a person ⇒ data gone, history values nulled but rows/seqs intact (feed cursor unaffected), suppression entries exist for its emails, `crm_record_get` ⇒ `ERASED`, unmerge/restore refuse, audit chain still verifies (`scripts/verify-audit-chain.mjs`).

**Acceptance:** api + worker tests green; `NOT_YET` shrinks by 1.

---

### T53 — Webhook subscribing principal + per-app provenance

**Depends on:** T52. **Spec:** `docs/spec/events.md` §1 (webhook principal, value-free push); `docs/auth-and-tenancy.md` §1 (`DEEPCRM_APPS` registry, `X-App-Context` alias, `act` chain).

**Files:**
- Edit `packages/db/prisma/schema.prisma` — `Webhook.subscribingUoaUserId` (migration `webhook_principal`).
- Edit `worker/src/jobs/change-deliver.ts` — events visibility-filtered as the subscribing principal; `confidential`/`restricted` values always omitted from push payloads (slug named, value absent).
- Edit `packages/mcp-inbound` — `X-App-Context` with `X-Nessie-Context` alias over the (already-present) `DEEPCRM_APPS` registry; the `DEEPCRM_DIRECT_CLIENTS` strategy: UOA public-profile tokens (`/oauth/*`, same JWKS, `principal.app = 'direct'`, no app key/context) per `docs/spec/uoa-integration.md` §5.2.
- Tests: webhook to a member-subscribed endpoint omits a private record's events and all restricted values; a second registered app authenticates with its own JWKS and its context token is rejected under the first app's name; `act` chain lands in the audit row; a direct public-profile token authenticates when `DEEPCRM_DIRECT_CLIENTS=true` and is refused otherwise.
- Edit `api/test/mcp/surface.test.ts` — `NOT_YET = []` again.

**Acceptance:** `pnpm verify` green; `pnpm docs:mcp && git diff --exit-code docs/mcp-surface.md`. **Docs:** architecture §6 (`DEEPCRM_APPS`).

---

### T54 — DeepSignal binding note (cross-repo, after T44)

**Depends on:** T53, T44. Written in the **deepsignal.live checkout** (worktree rule exempt): a short reply doc `docs/plans/deepcrm-policy-asks-response.md` recording what shipped for each ask (§1 visibility, §2 webhook principal + value-free push, §3 suppression/erasure, §4 Q5 decided org+team — org scope explicitly not available, §5 origin guard, §6 per-app registry + act chain) with links to the DeepCRM docs, so DeepSignal's integration plans build on the actual contract.

**Acceptance:** the file exists in deepsignal.live and links resolve.
