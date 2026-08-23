# Review decisions — 2026-08-23

Four independent kimix reviews ran over the complete doc set (adversarial architecture, security red team, agent-consumer/MCP conformance, plans dry-run; raw reports in the untracked `reviews/` directory). The reviews are input, not authority: every finding below was re-checked against the docs — and for protocol claims against the MCP 2026-07-28 spec pages directly — before a verdict. This file records what was **accepted** (and the decided fix, now folded into the docs), what was **accepted in modified form**, and what was **rejected** with reasons. Finding ids reference the reports (R1 = architecture, R2 = security, R3 = MCP/agent, R4 = plans).

## Verdict summary

The design held up structurally (headless MCP surface, metadata engine, tenancy, plan decomposition) but the reviews found real defects in four clusters, all fixed at doc level before any code exists:

1. **Ordering & atomicity** (R1 C1–C9): the change-feed cursor was not commit-ordered, idempotency and assert were check-then-act, `block` rules and approvals were not transactional, the audit chain forked under concurrency, merge/unmerge had unspecified inverses.
2. **Redaction completeness** (R2 §5): sensitivity was enforced on the primary read path only; `display_name`, normalised shadow keys, merge snapshots, history, embedded records and candidate evidence all leaked around it.
3. **MCP conformance** (R3 A1–A12, verified first-hand): the documented MRTR shape was bespoke and non-interoperable; `resultType`, `server/discover`, top-level `ttlMs`/`cacheScope`, and required `_meta` were missing.
4. **Un-gated side channels** (R2 S6.2, S1.1): webhook registration and task results bypassed the export approval gate.

## Accepted — architecture (R1)

| id | Decision |
|---|---|
| C1 | **Per-team commit-ordered feed sequence.** `RecordChange.seq` is no longer a global autoincrement; it is allocated from `teams.feed_seq` via `UPDATE … RETURNING` as the last statement before commit, so the row lock makes seq order = commit order per tenant. Brief's stale `(occurred_at, id)` cursor language deleted. |
| C2 | **Idempotency key reserved in-transaction** (step 0 insert with null result under an advisory lock; result filled in the same commit; tool name part of the identity). Loser waits and replays, or gets `IDEMPOTENCY_IN_PROGRESS`. |
| C3 | **Assert is create-with-savepoint, retry-as-update on unique violation**, with an advisory lock on the normalized key hash. |
| C4 | **`block` matching rules must be enforceable by the database**: allowed only with `method: normalized`/`exact`, materialised into a `record_match_keys` table with a unique index written in the write transaction. `fuzzy` rules may only `warn` (validated at `crm_matching_rule_set`). This also removes the `_n.*` shadow keys from `records.data` entirely (fixes R2 S5.2 structurally). |
| C5+M5 | **Merge snapshots record provenance** (which keys/links/entries were re-pointed vs native); keys follow data (a kept key requires the value in the survivor's `data`); `crm_unmerge` returns `conflicts[]` for post-merge collisions. |
| C6+M15 | **`record_reference` projections are computed at read, never stored.** `data[slug]` for reference attributes is assembled from `record_links` at serialisation; merge re-points one edge row; no third-party record writes, no drift. Filtering on a reference attribute compiles to an `EXISTS` over links. Relation-type archive becomes metadata-only. |
| C7 | **Soft delete releases unique keys** (recorded in the delete snapshot); restore re-claims and fails with new `RESTORE_CONFLICT` + MRTR offer when a key was taken meanwhile. |
| C8 | **Approval consumed atomically** (`UPDATE … WHERE status='pending' … RETURNING` in the same transaction as the mutation). |
| C9 | **Audit chain extension serialised** by a namespaced advisory lock taken immediately before the audit insert, with the rule that no further locks may be taken after it (made possible by C6). Per-org write serialisation documented as the accepted cost. |
| M1 | Retention contradiction resolved: `record_changes` are immutable **except** cascade on hard-delete of a record by retention; merge snapshots are never purged independently; `crm_record_at` documented as correct within retained history. |
| M2+M3 | **Link changes write one row per endpoint** (shared `group_id`); `RecordChange.recordId` nullable with `kind: schema` for schema-change feed rows; `Change.record` nullable in the contract. |
| M4 | **Transitive redirect maintenance**: merging B→C re-points every `merged_into_id = B` to C, so reads stay one hop. |
| M6 | Lock-then-validate: existence/deleted/restrict checks and dependent discovery run **after** advisory locks. |
| M7+S9.4 | Queue: lease + reaper (`locked_at` timeout), `priority` lanes (delivery/reindex never starved by bulk), per-row idempotency in bulk payloads, embedding calls batched with a circuit breaker. |
| M8 | pgvector: tenant-filtered iterative scan (`hnsw.iterative_scan`), `ef_search` setting, periodic rebuild policy, `embed.model_migrate` job; per-tenant partitioning deferred with a written trigger condition. |
| M9+m10 | Neighbour reindex fan-out job on `display_name` change (batched, `content_hash` skips no-op embeds); staleness documented in the search tool description. |
| M10 | Expression indexes named by attribute id, INVALID-index cleanup on job start, `DROP INDEX CONCURRENTLY` on unset/archive, per-tenant cap. |
| M11 | `schema_version` read in the same query as tenant resolution; caches keyed by version (self-invalidating, no TTL); `policy_version` added the same way. The 60 s tenant cache holds id resolution only. |
| M12+S4.2 | **Deny is absolute in v1** (any matching deny denies regardless of priority; priority orders allows). `conditions` restricted to a closed set (`sensitivity`). Documented with worked examples. |
| M13 | Provisioning serialised by advisory lock + idempotent seeding; `crm_changes_since` with no cursor now starts **at now** (returns a fresh cursor), full-history replay is an explicit opt-in. |
| M14 | `record_unique_keys`/`record_match_keys` index on a sha-256 of the normalized value; raw value kept unindexed for evidence. |
| M16 | Multi-value assert rule: match key = first element; any other element resolving to a different record ⇒ `DUPLICATE_FOUND` with all candidates. |
| minors | All accepted: single 30 s debounce constant; no-op writes don't bump `version`; tool-list etag = server build; replay purge in retention; **two-int advisory locks with per-concern namespaces and tenant in the key** (also R2 S1.4); approver must differ from the requesting `on_behalf_of`; cascade deletes share a `group_id` that restore follows; `crm_record_at` includes links; hop-1 timeline post-filtered by policy; worker job list completed; `rotate_secret` on webhooks; webhook catch-up rate cap; cursor encoding stated per tool family. |

## Accepted — security (R2)

| id | Decision |
|---|---|
| S1.1 | `tasks/get`/`tasks/cancel` are tenant-scoped, `NOT_FOUND` on mismatch; client-visible jobs always carry tenant ids; system jobs (null tenant) are never client-addressable. |
| S1.2 | Team row's `organization_id` must equal the delegation's resolved org, else 401 `TENANT_MISMATCH`; re-parenting is an operator migration only. |
| S2.1 | `X-Nessie-Context` must carry `aud` (DeepCRM's public URL) and a fixed `iss`; rejected otherwise. |
| S2.2 | Single-use `requestId` seen-set (300 s) required for destructive calls (merge/delete/export/webhook admin/approval consume). Full jti binding for every call rejected as disproportionate — provenance forgery within 5 min on non-destructive writes is accepted risk, documented. |
| S2.3 | Boot fails closed: `REQUIRE_AUTH=false` refuses to start when the public URL is non-localhost or `NODE_ENV=production`. |
| S2.5 | Delegation must carry `iat`; `exp − iat ≤ 15 min` enforced. `tv` (S2.4) is recorded for audit and the 15-minute window is the documented revocation bound — online UOA introspection rejected for v1 (latency + coupling), revisit if UOA ships a revocation push. |
| S2.6 | Multiple active hashes per app-key name (rotation window); 401-burst logging. |
| S2.7 | Claims schema-validated (zod), strict string equality on `sub` match, empty claims rejected. |
| S3.1 | Canonical JSON (sorted keys, NFC) over complete arguments minus `inputResponses`; **the approved execution runs from the stored `argumentsSnapshot`**, not the retry body. |
| S3.2 | Normative consumption predicate: tenant + tool name + arguments hash + pending + unexpired + role, single-use in-tx (with R1 C8). |
| S3.3 | `required_role` enforced exactly (owner ≠ admin). |
| S3.4 | Caps: 100 pending approvals per team, 10 per requester; identical `(action, hash)` deduped. |
| S3.5 | Tokens ≥128-bit CSPRNG, stored hashed. |
| S3.6 | v1 policies are **immutable post-seed** except by operator migration; stated in the docs; policy-admin tools are an open question. |
| S4.1 | `restore` added to `PolicyAction`, seeded mirroring `delete`; `unlink` normatively evaluates `link`. |
| S4.3 | `conditions` closed set; condition evaluation never reads record data. |
| S4.4 | Candidate evidence redacted: value withheld (`matched: true`) for attributes the caller may not view. `record_id` still returned — needed for assert/merge flows; accepted as a deliberate trade-off, documented. |
| S4.5 | Agent bindings namespaced `agent:<app>:<agentId>`. |
| S5.1 | `sensitivity > internal` forbidden on a primary attribute (validated at define/update/sensitivity change). |
| S5.3 | `snapshot` never leaves the service; feed/history/webhook shapes exclude it. |
| S5.4 | History, `record_at` and the feed apply the **current** sensitivity retroactively. |
| S5.5 | Every record serialisation — embedded, timeline, candidate, feed — passes `redactForActor`; one code path. |
| S6.1 | Delivery always via `safeFetch` (fresh resolve, pinned, redirects refused, port 443 only), every attempt. |
| S6.2 | **Webhooks start at the current seq**; history replay is a separate approval-gated action; webhook create/update is owner-only + approval; push payloads are redacted (no restricted values, no snapshots) regardless of the admin evaluation shortcut, which is removed. |
| S6.3 | Export honours attribute policy for the approver's role; approval message lists the exact attributes; signed URL single-use, ≤1 h; row cap. |
| S7.1 | Webhook secret still returned once via MCP (the caller is Nessie's integration code, not a chat agent — stated in the tool description), flagged sensitive; Nessie must strip it from model context (added to the integration doc). |
| S7.2 | Keyring versioned (`kid` on ciphertexts). |
| S7.3 | Receivers MUST dedupe on `(webhook_id, until_seq)`. |
| S8.1 | Denials and auth failures are audited (`outcome: denied`); chain lock per C9; external anchoring noted as an ops option. |
| S8.2 | Audit retention policy documented (crypto-shred of personal fields after a configured horizon). |
| S9.1–S9.3 | Filter caps (depth 8, 100 nodes, 16 KiB); HTTP body cap 10 MB; `rows` max in the schema; per-record `data` cap 256 KiB; fuzzy threshold ≥ 0.5 with top-20 candidate evaluation; per-team job concurrency caps. |
| S9.5 | Idempotency replay bound to the principal (`uoaUserId` in the key identity). |
| S9.6 | Per-principal rate limits stated as a deployment requirement (edge, keyed on `Mcp-Name`). |
| S10.1 | Solved by the MRTR redesign: `requestState` carries principal, tool, args hash, TTL (below). |
| S10.2–S10.4 | Actor id format validation + description warning; `organization` dropped from `PolicyScope` in v1; error messages are templates without echoed values, `INTERNAL` returns a correlation id only. |

**Rejected (R2):** S1.3's role-gated provisioning — first contact is legitimately a member's agent; rate-limiting + an optional org allow-list env accepted instead. S5.6's hiding of restricted-attribute metadata — slugs/types must stay discoverable or agents can't avoid writing to them; documented as a trade-off. S1.5's RLS — noted for v2; the Prisma-extension runtime assertion accepted now.

## Accepted — MCP conformance & ergonomics (R3)

Spec claims verified directly against modelcontextprotocol.io (MRTR pattern page + 2026-07-28 changelog) before acceptance.

| id | Decision |
|---|---|
| A1+A2+A3 | **MRTR rewritten to the spec shape.** `inputRequests` is a map whose values are standard `elicitation/create` requests (form mode, `requestedSchema`); every `InputRequiredResult` carries an integrity-protected (AEAD) `requestState` encoding principal, tool, canonical args hash, impact summary, TTL — and for approvals the approval id. The retry carries `inputResponses` (map of `ElicitResult`) and echoed `requestState` at **params level, sibling to `arguments`**. The bespoke `kind: confirmation/approval` union is gone; approval identity moves into `requestState` + the server-side row. |
| A4 | Every result carries `resultType: "complete"` (or `"input_required"`); shown in the flows. |
| A5 | Tasks aligned with the extension: task-shaped results per the extension schema, `tasks/get` + `tasks/cancel`, `tasks/update` explicitly unsupported in v1, wire casing `taskId`. Reviewer's claim that task results require per-request client opt-in **rejected** — the changelog states the redesigned extension "allows servers to return task handles unsolicited without per-request opt-in"; behaviour for non-tasks clients still documented (poll guidance in the text summary). |
| A6 | `ttlMs`/`cacheScope` are top-level result fields; `cacheScope: "private"` (never `"tenant"`, never `"public"`); etag moved to a vendor `_meta` key. |
| A7+A8 | `server/discover` implemented (MUST); required inbound `_meta` (`protocolVersion`, `clientCapabilities`) and `Mcp-Method`/`Mcp-Name` headers stated normatively with rejection behaviour; `serverInfo` in result `_meta`. |
| A9 | `subscriptions/listen` explicitly not implemented (−32601); staleness signalled by errors + `ttlMs`. |
| A10 | `resources/templates/list` registered for `crm://schema/{object_type}` and `crm://views/{slug}`; brief's `{id}` drift fixed. |
| A11 | `content[0].text` = serialized JSON of `structuredContent` (spec guidance), not a prose summary. |
| A12+A13 | Deterministic tool order stated; ≤300-char description cap enforced at registration (already was) and long guidance moved in-band to `crm://help/*` resources. |
| B1 | Multi-value `match_attribute` semantics defined (= R1 M16), including `crm_record_get.value`. |
| B2 | `crm://help/filtering` resource (op-by-type table + worked examples); `VALIDATION_FAILED` messages name the allowed ops for the attribute's type. |
| B3 | `null` = unset (rejected on required), `[]` = empty list, distinct; redacted attributes are absent-not-null and echo-back patches that touch them fail with a naming error. |
| B4+B5 | Cross-referencing "use X instead" clauses added to create/assert/bulk and get/query/search; `LIMIT_EXCEEDED` carries the numeric limit; caps exposed via `server/discover` metadata. The `{ text }` filter node **kept** (composable narrowing inside `and`) but documented against `crm_search`. |
| B6 | Inline `links[]` on create/assert is atomic all-or-nothing; `crm_link` returns `ended_links` when cardinality replaced an edge. |
| B7 | `ErrorPayload.next` machine hint (`retry_with_approval`, `fetch_and_retry`, `use_redirect`, `fix_input`, `fatal`) + code-specific ids (`link_id`, `limit`); `issues[].path` is RFC 6901 JSON Pointer. |
| B8 | Cursors bound to (tool, tenant, argument set); mismatch is a typed error; feed cursors are a distinct named kind. |
| B9 | Two tools added: `crm_records_count` and `crm_records_get_many`; `include_total` drift fixed. |
| B11 | `crm_unlink` returns the ended `link_id`; ambiguity behaviour defined (deterministic newest, >1 active is a data-quality item). |
| B12 | F6 documents exactly which headers change on the approval retry and that `actor` stays the agent while `on_behalf_of` records the approver on that one write. |
| B13 | `owner` attribute removed from the templates — the record-level system `owner` is the one owner; filter grammar's `system: owner` covers querying. |
| B14 | Views added to `SchemaSnapshot`; `crm_view_delete` added; `crm://views` index resource. |
| B15 | `crm_export` takes `reason`/`idempotency_key`; webhook identity = upsert-by-URL, secret rotates only with `rotate_secret: true`. |
| B16–B20 | Prompt notes (server-enforced gates), hop-1 timeline caps + `relation_types` filter, `crm_template_apply` takes a `Slug` validated at runtime (`UNKNOWN_TEMPLATE { available }`) instead of a hard-coded enum, quality buckets return a `query_filter` the agent can paginate with `crm_records_query`, search documented single-page. |
| B10 | **Deferred**: `crm_change_revert` and schema-diff — manual recovery recipe documented in `crm_record_history`'s description; both added to brief §9 open questions. |

Tool count after B9/B14: **50**.

## Accepted — plans dry-run (R4)

All 16 blockers verified real and fixed; the majors and minors accepted except where noted. Highlights:

| id | Decision |
|---|---|
| A1 | 500-line cap exempts verbatim-copied files (Prisma schema, contracts, templates) and pre-authorises tool-file splits — stated in the execution guide. |
| A2/A3 | One `tenantWhere` definition (`packages/db/src/tenant-where.ts`); auth doc aligned; lint regex extended to every tenant-scoped model and `findUnique`/`aggregate`; a runtime Prisma-extension guard added as the backstop. |
| A4–A7 | Per-worktree dev ports + PID kill (no `pkill -f`); standing-Postgres assumption stated; "Replace" defined; task-introduced env vars must update architecture §6 + `.env.example` in the same commit; T01 ships a placeholder `schema.prisma` so `prisma generate` works before T03. |
| B1/B5 | `ErrorCode` is an as-const map (zod enum derived) — contracts updated to match; `Principal`/`PrincipalSchema` owned solely by `@deepcrm/schemas`. |
| B6/B7 | `verify-audit-chain.mjs` semantics defined (all orgs, vacuous 0); the audit hash formula written out exactly with a shared `canonicalJson`, killing the `??`-precedence trap. |
| B8 | `JobStatus` gains `cancelled`; the claim SQL now spells out its SET list and lease reclaim. |
| B10/B21/B42 | The missing **`role` claim** added end-to-end: delegation table → `Principal` → `ActorContext.onBehalfOf.role` → policy/approvals. |
| B12/B13 | Policy defaults and templates are **imported** JSON (inlined into `dist`), living in the package that owns their tables; snake→camel mapping stated. |
| B14/B19/B31 | Dissolved structurally by the R1 decisions: no `_n` shadow keys (match-key table), no stored projections (computed at read), link ops bump both versions and reindex idempotency keys on the feed seq. |
| B15/B35 | Idempotency reserved in-tx (= R1 C2); T13 explicitly owns §4 steps 0–14 including **both** enqueues. |
| B16 | `LinkWriter` is a required parameter with a throwing test stub — no sentinel no-op. |
| B23/B25 | T20's transport test asserts success, not emptiness; the `NOT_YET` end-state grep made annotation-tolerant and the declaration line pinned. |
| B27/B28/B30 | `last_activity_at` uses `greatest()`; object-valued filters use canonicalised JSONB equality; list-attribute mutations bump `schema_version`. |
| B33/B43 | `undici` pinned in T01; `prisma` moved to runtime deps (+ `postinstall: prisma generate`) so the production migrate command works. |
| B34/B37/B38/B39/B40/B41 | Spec pointer fixed (events §3); merged-read semantics unified (T13 throws until T38 replaces with redirect — stated in both tasks); the merge snapshot shape is defined by its producer in §7.7; orphans = many-side of `restrict` relations only; the `/exports` route is a blessed, documented exception with its own keyring kid; the retention/feed contradiction resolved in events §2 (cascade bound, documented). |
| B44/B45/E2/E3 | T46 runs in the nessie checkout (exempt from the worktree rule); prompts registration listed as an Edit; `mcp/tasks.ts` added to the architecture layout; T44/T47 both flagged human-gated with evidence transcripts in `docs/done/`. |
| C1–C8 | Prisma-schema audit notes accepted: intent comments on FK-less columns, the attribute check constraint, `cancelled`, identifier-length-safe index naming; `View`/`primaryAttributeId` remain relation-less by intent, now commented. |

**Rejected (R4):** B20's soft time-gate for the property tests (kept as a local guideline, CI asserts success only — folded into the task wording); B26 stub-deps concern demoted to a comment requirement, as the reviewer itself concluded.

## DeepSignal policy asks (2026-08-23)

DeepSignal filed six pre-binding asks against this design ([deepsignal.live/docs/plans/deepcrm-policy-asks.md](../../deepsignal.live/docs/plans/deepcrm-policy-asks.md)). Triage — all six accepted, one already fixed:

| Ask | Verdict | Where it landed |
|---|---|---|
| §1 Per-record visibility (private/users records inexpressible in policy) | **Accepted as designed by the ask** — visibility is record *data* (`team\|users\|private` + human grants), evaluated before policy, admins not exempt; compatible with policy immutability by construction. | schema-engine §2/§4/§4c′, auth §4a, contracts, plan T48–T49 |
| §2 Webhooks evaluate as admin | **Partly stale** (the admin shortcut was already removed in the review pass), the real gap accepted: webhooks now carry a subscribing principal, are visibility-filtered as that principal, and push payloads are value-free for confidential/restricted — a webhook is a nudge, values come via pull. | events §1/§3, plan T53 |
| §3 No suppression/consent/erasure | **Accepted — the most substantial addition.** Hash-keyed `suppression_entries` with no FKs (survive tenant deletion and erasure, the audit-log precedent); `crm_suppression_add/check/list/remove`; `crm_record_erase` that suppresses first, scrubs data + historical values in place, and leaves a permanent tombstone. Six new tools (surface now 56). | schema-engine §2/§4d, mcp-surface §7a, policy-defaults, plan T50–T52 |
| §4 Org scope deferred vs DeepSignal's `org` ShareScope | **Q5 decided rather than left open:** tenant stays org+team for v1; org-wide records explicitly do not exist and `org`-scoped shares stay on the product's side. Recorded before any binding, which was the ask's actual point. New open question (Q13) on org-wide suppression. | brief §9 Q5/Q13, auth §4a |
| §5 Origin class as policy condition | **Confirmed by design** (conditions stay closed; the gateway keeps enforcement) and the suggested defence-in-depth accepted: `Team.rejectedOrigins` + set-once `Record.origin` + `crm_origin_guard_set`, refusing tainted writes with `ORIGIN_REJECTED`. | schema-engine §2/§4 step 3, plan T50 |
| §6 Provenance hardcoded to Nessie | **Accepted:** `DEEPCRM_APPS` per-app registry (key hashes + context JWKS/issuer), `X-App-Context` with the Nessie alias, delegation `act` chain recorded so multi-hop calls stay attributable per hop; `agent:<app>:<agentId>` keys on the immediate caller. | auth §1, nessie-integration §1, plan T53 |

## DeepSignal policy asks — round two (2026-08-23, against `31c90ce`)

DeepSignal's second review ([deepcrm-policy-asks.md](../../deepsignal.live/docs/plans/deepcrm-policy-asks.md), R1–R27) confirmed the round-one fixes hold and raised a fresh list. Triage — again re-verified against the docs, not taken on authority:

**Accepted as asked:** R1+R16 (write guard: `team_visibility_only_apps` + `require_origin`, folded into one `crm_write_guard_set`), R2 (multi-value order normative: submitted order, first-occurrence dedup), R4 (`contains` on multi actor/record references), R5a/b (sensitivity-raise/archive ⇒ bulk reindex Task; erase enqueues neighbour reindex), R6 (one audited `searchQuery()` chokepoint composing tenant+visibility into all raw SQL + cross-tenant adversarial test), R7 (suppression channels, `expires_at` — refused on objection/erasure, `postal` kind, `sub_reason`, byte-pinned normalizers: E.164-only phone, registry-id company numbers, caller-pre-normalized postal), R8 (`ORIGIN_REJECTED`/`ERASED` + `VISIBILITY_REJECTED`/`TENANT_REPARENTING` into contracts `ErrorCode`, declared append-only), R9 (schema-evolution §3a: normalize-config backfills, options archivable-never-deletable, bounds grandfathered), R10 (Webhook column into the normative schema; events.md declared the envelope authority), R12+R26 (erase reach: edge/entry data scrubbed in-tx; retention bounds for jobs/replays/approvals/exports; typed `record.erased` recall event with a stated consumer obligation; erase `reason` a closed enum; unreachable copies stated honestly), R13 (semantic queries filter `embedding_model = current`; model index; dim-change = column migration), R14 (`toSearchText` incl. capped `rich_text`; assembly order), R15 (aggregates/counts/exports/entries computed over the visibility-filtered set; ANN pre-filter normative), R17 (`crm_search.similar_to`), R18 (evidence-bearing-fact idiom blessed in §9), R21 (context JWT binds `delegation_jti` + `tool` + `args_sha256`), R23 (`ActorContext.app`/`actChain` carried into services and audit), R27 (`act` = RFC 8693 nested object, flattened to `actChain`), R19 smalls (currency `fixedCurrency` + comparison note; `json` opaque-to-filters note; PG-backed replay seen-set; new `registry_id` attribute type; `is_multi` immutable; unique/match availability noted).

**Accepted modified:**
- **R3** — went further than asked: the *default* multi merge is survivor-order-first with losers' unseen values appended (their (b)) — no config flag needed — and `field_choices` overrides wholesale (their (a)).
- **R20** — direct clients get a concrete posture rather than an interactivity oracle: `app:direct` is denied the destructive set by seeded default until an owner grants it (intersection, not union; a missing context proof is never proof of a human).
- **R11** — the cheap tie: deliveries pause when the subscriber hasn't been seen in `DEEPCRM_WEBHOOK_PRINCIPAL_STALE_DAYS`, resuming on their next authenticated call; the residual window is stated and owned. Backed by a new `principal_last_seen` table — operational liveness evidence, not an identity store.
- **R24** — UOA is the arbiter, but reconciliation is automatic-heavy, not instant: a verified token naming a new parent org enqueues `tenant.reparent` (batched rewrite, audited) and calls answer retryable `TENANT_REPARENTING` meanwhile. No operator ratification of what UOA already decided.
- **R25** — DeepCRM cannot query UOA's directory (doctrine), so actor references are validated against *membership evidence*: ids must be the caller or seen in `principal_last_seen` for the team; departures surface via a new `stale_actors` data-quality bucket rather than pretending an observation channel exists.
- **R22** — **cannot be implemented as asked**: `tv` is absent from UOA's token-exchange contract and DeepCRM does not mint these tokens. Filed as an upstream UOA ask; DeepCRM's verifier enforces per-subject epoch monotonicity the day the claim appears. Until then the bound is the 300 s life + UOA's live membership re-read at exchange, stated plainly.

**DeepSignal-side notes taken:** §2's no-private-data decision (their writes stay `visibility: team`; R1's guard turns that into a server property); their lifecycle plan's custom suppression object type must be revised to `crm_suppression_*` (their A5) — the T54 reply doc will say so.

New/changed work is Phase 7: T48 (schema), T50 (write guard + ordering), T51 (suppression channels/expiry/normalizers), T52 (erase reach), T53 (binding claims, direct posture, staleness), **T55** (schema evolution), **T56** (search chokepoint, model filter, similar_to, membership filters).

## Process note

Every accepted decision is applied to the affected doc in the same commit series as this file; the plans were updated where a decision changes an implementation task. Rejected findings are recorded above so they are not re-litigated at implementation time.
