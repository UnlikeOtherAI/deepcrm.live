# Security red-team review — DeepCRM design docs

Scope: `docs/auth-and-tenancy.md` (A&T), `docs/spec/contracts.md` (CT), `docs/spec/events.md` (EV), `docs/spec/nessie-integration.md` (NI), `docs/spec/protocol-flows.md` (PF), `docs/spec/policy-defaults.json` (PD), `docs/architecture.md` (AR), `docs/schema-engine.md` (SE), `docs/mcp-surface.md` (MS). Docs only, no code. Findings ordered by area; each has severity, location, scenario, fix.

---

## 1. Cross-tenant isolation

### S1.1 — HIGH — `tasks/get` has no specified tenant check; export URLs readable cross-tenant
- **Where:** MS §0.5 (Tasks extension), CT `tools.ts` (`tasks/get { taskId }` maps to `queue_jobs.{status,progress,result}`), SE §2 (`QueueJob.organizationId/teamId` are **nullable**).
- **Attack:** Any authenticated principal from tenant B who learns or guesses a `task_id` (uuid v4 — but task ids leak via logs, Nessie run state, `X-DeepCRM-Delivery`-style breadcrumbs, or a compromised agent in tenant A) calls `tasks/get` and reads `result`, which for `crm_export` is `{ url, rows, expires_at }` — a bearer signed URL to a full data export of tenant A. Nullability of `QueueJob.organizationId/teamId` signals the authors already anticipate jobs without tenant rows, which makes a tenant check easy to "forget" for exactly those rows.
- **Fix:** Make `organizationId`/`teamId` non-nullable on `queue_jobs`; state normatively that `tasks/get`/`tasks/cancel` reject with `NOT_FOUND` (not `POLICY_DENIED` — no existence oracle) when `job.(organizationId,teamId) ≠ ctx.tenant`. Add it to the acceptance tests.

### S1.2 — HIGH — Org/team pairing in `resolveTenant` is not verified on the hit path
- **Where:** A&T §3, PF F10. `teams.external_team_id` is globally `@unique`; upsert inserts org then team. Nothing specifies behaviour when a delegation arrives claiming `(org=B, team=T)` where team T already exists under org A.
- **Attack:** UOA team ids and org ids are separate claims. If UOA ever re-parents a team, or a delegation is minted with a mismatched pair (UOA bug, token-exchange confusion, future non-Nessie client per A&T §1 "Future"), `resolveTenant` finds team T by `external_team_id` and returns `tenant = { organizationId: <A's local id>, teamId: T }` while the principal says org B — or worse, silently returns team T under org A to a caller whose only valid credential is for org B. All subsequent queries scope to the wrong org context. The doc never states a consistency check.
- **Fix:** Specify: on resolve, if the team row exists, its `organization_id` MUST equal the resolved org's id, else 401 (`TENANT_MISMATCH`). Never re-parent implicitly; re-parenting is an operator migration.

### S1.3 — MEDIUM — Unbounded tenant auto-provisioning
- **Where:** PF F10, NI §2.3. First call from an unknown team inserts org + team + policy seed + system template + audit, with no authorization decision beyond "the three headers verified".
- **Attack:** Any holder of a valid UOA delegation with `scope: ai.invoke` for *any* org/team causes DeepCRM to provision a tenant. If UOA lets users create teams cheaply, an attacker mints thousands of teams → thousands of provisioned tenants (policy rows, template rows, advisory-lock domains, seq ranges). Also squatting: provision `external_org_id` of a victim org before the victim's real first call, pre-seeding attacker-influenced placeholder state (names are non-authoritative, but policy rows are editable per tenant — see S3.6 — and the seeding path is the trust root).
- **Fix:** Gate provisioning: require the delegation's `role` claim to be `owner` for the F10 path, or an explicit per-deployment allow-list of `external_org_id` values in env. Rate-limit tenant creation per `principal.app`.

### S1.4 — MEDIUM — Worker jobs trust tenant ids carried in payloads
- **Where:** AR §5 ("Queue jobs carry `{organizationId, teamId}`"), SE §4.12. The worker reindex/dedup/bulk/export/deliver jobs act on the tenant named in the payload; no doc states the worker re-derives or validates tenancy against anything authoritative.
- **Attack:** Defence-in-depth gap rather than a direct exploit from the MCP surface: any bug that lets a caller influence a job payload (e.g. bulk-assert rows containing record ids, or a future enqueue path) crosses tenants inside the worker, where the `lint-tenant-where` rule (A&T §3) does not apply. `pg_advisory_xact_lock(hashtext(recordId))` (SE §4.4) also shares a global lock namespace across tenants — a tenant can stall another tenant's writes by hammering a known victim record id (record ids are uuids but leak via redirect/error paths, see S4.4).
- **Fix:** State that job handlers re-resolve the tenant from the payload ids and abort if the referenced rows don't match; namespace advisory locks per tenant (`hashtext(tenantId || recordId)`).

### S1.5 — LOW — Lint rule is the only stated enforcement of tenant filtering
- **Where:** A&T §3 (`scripts/lint-tenant-where.mjs`).
- **Attack:** A lint rule is bypassable (`eslint-disable`, a raw-SQL path, a Prisma `$queryRaw`, worker code not covered by the glob). One miss = silent cross-tenant read.
- **Fix:** Add a runtime backstop: wrap the Prisma client so every query against a CRM table without `organization_id`/`team_id` in `where` throws in non-test environments, or use Postgres RLS with a per-transaction `SET app.tenant` as the floor and the lint rule as ergonomics.

---

## 2. Three-header auth model

### S2.1 — HIGH — `X-Nessie-Context` JWT has no `aud`/`iss` binding — cross-service token confusion
- **Where:** A&T §1 table (context verification: "RS256 via `NESSIE_CONTEXT_JWKS_URL`; max TTL 300 s, 30 s skew; claims …"), NI §1 ("same key set it uses for DeepWater/DeepSignal"). No `aud`, `iss`, or token-use claim is checked for the context token.
- **Attack:** Nessie signs context tokens for DeepWater and DeepSignal with the *same key set*. A context JWT minted for DeepSignal (different audience, possibly different `agentId` semantics and different TTL discipline) is replayed against DeepCRM and verifies. The delegation token gates data access, so this is not direct data theft — but it lets an attacker who holds any DeepSignal-bound context token forge `agentId`/`runId`/`toolCallId` provenance on DeepCRM writes, poisoning the audit trail and shifting policy evaluation onto a different `agent:<id>` binding (PD `agent_inheritance`: an `agent:<id>` binding can *grant* rights — see S3.4 — so choosing your agent id matters).
- **Fix:** Require `aud = <DEEPCRM_API_PUBLIC_URL>` (or a dedicated `deepcrm` audience) and a fixed `iss` on the context token; reject otherwise. Document the claim set as normative.

### S2.2 — HIGH — No replay / jti binding for `X-Nessie-Context`; provenance is spoofable within the 300 s TTL
- **Where:** A&T §1, PF F1. The context carries `toolCallId` and `requestId` but nothing binds those to the actual JSON-RPC request, and there is no jti/nonce store.
- **Attack:** Within 300 s, anyone holding a context token (logs at Nessie, a compromised tool proxy, another tool call in the same run) can replay it with *arbitrary* tool calls under the same delegation, attributing them to the original `agentId`/`runId`/`toolCallId`. Audit rows (A&T §6) and `record_changes` provenance will confidently name the wrong tool call. Since provenance is the only agent-attribution DeepCRM has, this undermines both audit and per-agent policy bindings.
- **Fix:** Bind the context token to the request: require `toolCallId` to equal the JSON-RPC `id` (or a hash of method+arguments) and reject mismatch. For high-value actions (merge/export/delete/webhook admin), require single-use: record `requestId` in a short-lived seen-set (300 s TTL) and reject replays.

### S2.3 — HIGH — `REQUIRE_AUTH=false` dev principal can reach production data by misconfiguration
- **Where:** A&T §1, AR §6 (`REQUIRE_AUTH` default `true` (prod) / `false` (dev)). The server happily serves a fixed omnipotent principal (`org=org_dev`, `team=team_dev`) when the flag is off.
- **Attack:** One env-var mistake (a compose file carried from local to prod, a redeploy script that doesn't set it) and the entire CRM is unauthenticated. Worse, the dev principal uses *fixed, well-known ids*: if prod ever runs with `REQUIRE_AUTH=false` even briefly, an attacker who knows this (it's in the public docs) provisions/uses `org_dev`/`team_dev` tenant data that later becomes reachable again on any recurrence. Nothing states the server refuses to boot in this configuration when `DEEPCRM_API_PUBLIC_URL` is non-localhost.
- **Fix:** Fail closed: refuse to start when `REQUIRE_AUTH=false` AND (`DEEPCRM_API_PUBLIC_URL` is not localhost OR `NODE_ENV=production`). Make the dev principal ids configurable per checkout so prod data can never share them.

### S2.4 — MEDIUM — `tv` (credential epoch) is verified but never enforced
- **Where:** A&T §1 (delegation claims include `tv`), §2 (`credentialEpoch` carried on the Principal). No doc describes an epoch store or a comparison.
- **Attack:** UOA's epoch exists to kill a user's tokens on credential rotation. If DeepCRM only *checks signature/iss/aud/exp* (as the table states) and never compares `tv` against a current epoch, a stolen delegation is good until `exp` regardless of revocation. The claim is dead weight — a verification gap that looks like a control.
- **Fix:** Either specify the enforcement (UOA introspection endpoint or a pushed epoch cache; reject `tv < current`) or remove the claim from the docs. Silence here will be implemented as "no check".

### S2.5 — MEDIUM — Delegation token has no maximum lifetime and no `iat`/`nbf` discipline
- **Where:** A&T §1 (checks `exp` only), NI §1 ("short-lived" — aspirational, not enforced).
- **Attack:** A misconfigured or compromised token-exchange path mints a 30-day delegation; DeepCRM accepts it because only `exp` validity is checked. Combined with S2.4, revocation is impossible.
- **Fix:** Enforce `exp - iat ≤ 15 min` (configurable), require `iat`, reject `nbf` in the future beyond skew. State it in A&T §1.

### S2.6 — MEDIUM — App key is a global, unscoped bearer; no binding to issuer, orgs, or rotation
- **Where:** A&T §1 (`DEEPCRM_APP_KEYS` name:sha256 list; name becomes `principal.app`), NI §7 (rotation story = "401, owner re-enters key").
- **Attack:** The app key proves "the calling product" but is not bound to anything: any valid delegation for any tenant composes with it. If the single Nessie app key leaks, every Nessie-connected tenant is exposed to anyone who can also obtain *any* UOA delegation (a much lower bar — delegations flow through every worker). There is no per-app policy surface (e.g. allowed `iss`, allowed org set, separate read-only keys), no dual-key rotation window, and no statement that the same key name can have two active hashes during rotation.
- **Fix:** Support multiple active hashes per app name (rotation window); document per-app constraints (allowed issuers, optional org allow-list) as a designed seam even if v1 ships unconstrained; log and alert on 401 bursts per key hash prefix.

### S2.7 — LOW — Claim shape validation unspecified
- **Where:** A&T §1 lists claims but never says they are schema-validated (types, non-empty, `sub`/`org`/`team` format).
- **Attack:** A JWT with `team: ""`, `org: null` coerced to string, or `sub` type-confused (number vs string) reaches `resolveTenant`, creating garbage tenants (`external_team_id = ""`) or crashing the upsert — and on the `sub`-mismatch check, type confusion between delegation `sub` and context `sub` (`"123"` vs `123`) could either fail open (if compared loosely) or be an availability bug.
- **Fix:** Specify a zod schema for each token's claims; strict `===` on strings for the sub-match; reject empty/absent claims.

---

## 3. Approval flow (MRTR F6)

### S3.1 — HIGH — `arguments_hash` canonicalisation is unspecified
- **Where:** PF F6 ("arguments_hash stored"), SE §2 (`ApprovalRequest.argumentsHash` + `argumentsSnapshot`), CT `mrtr.ts`. No canonicalisation rules: key order, array order, unicode normalisation, number formatting, treatment of `reason`, `idempotency_key`, `expected_version`, `field_choices` ordering.
- **Attack:** Two directions. (a) Fail-open wobble: if the hash is computed over a serialisation that treats `{a:1,b:2}` and `{b:2,a:1}` as equal but the *executor* applies them differently somewhere (e.g. `field_choices` iteration order, `merged_ids` order affecting `field_choices` precedence), the approver approves one semantic and the executor applies another. (b) Fail-open by omission: if `reason` or other "cosmetic" fields are excluded from the hash, an attacker re-issues with identical operational args but a falsified audit `reason`; if `idempotency_key` is included, the approved re-issue may instead hit `IDEMPOTENCY_MISMATCH` (availability). You cannot audit "approver approved exactly this" without a defined canonical form.
- **Fix:** Define canonical JSON (sorted keys, NFC, explicit treatment of floats) over the *complete* tool arguments minus `inputResponses`, and state that the stored `argumentsSnapshot` — not the re-issued args — is what gets executed (execute from snapshot, not from the second request body).

### S3.2 — HIGH — Approval token consumption is not stated to be tenant- and tool-bound
- **Where:** PF F6, MS §0.4, SE §2 (`ApprovalRequest.continuationToken @unique`). The consumption path ("re-issue the same call with `inputResponses.approval`") never states that token lookup is scoped by `(organization_id, team_id, action, arguments_hash, status=pending, expires_at)`.
- **Attack:** `continuationToken` is globally unique and (entropy unspecified, see S3.5) possibly guessable or leakable — it appears in agent-visible tool results and flows through Nessie's `ApprovalRequest.context`. If lookup is by token alone, a token from tenant A presented by an admin of tenant B (or against a different tool's call in tenant A) could be consumed against the wrong request. Even same-tenant, nothing states the token is bound to the *requester* or the *tool name*; a token minted for `crm_merge_records` could be replayed on a concurrent `crm_export` call if only token+role are checked.
- **Fix:** Normative consumption predicate: token must match a `pending`, unexpired row in the caller's tenant whose `action` equals the tool name and whose `argumentsHash` equals the canonical hash of the re-issued arguments; single-use transition `pending → consumed` in the same transaction as the mutation; audit `approval.consumed` with both requester and resolver.

### S3.3 — MEDIUM — Approver role read solely from the delegation `role` claim; `required_role` degraded
- **Where:** A&T §4 ("from UOA team role claim `role` if present, else member"), PF F6 ("DeepCRM checks the approver's role from the delegation's team role claim"), CT `mrtr.ts` (`required_role: admin|owner`), NI §4.3.
- **Attack:** The role that authorises destructive actions is a *claim in a token DeepCRM does not issue*. If UOA's exchange ever emits a stale role (demoted admin keeps a cached delegation for its lifetime — compounded by S2.4/S2.5), DeepCRM honours it. Separately, `required_role: "owner"` in the MRTR shape is not honoured by the documented check ("principal whose role is admin/owner") — an owner-only approval silently degrades to admin.
- **Fix:** Enforce `required_role` exactly (owner ≠ admin). Document the maximum acceptable role staleness and tie it to the delegation max-lifetime fix (S2.5). Consider requiring the approval consumption call to carry a *fresh* context token (S2.2) so provenance records the actual approver's run.

### S3.4 — MEDIUM — Pending-approval spam / unbounded growth
- **Where:** A&T §4 ("an `approval_requests` row is created"), PF F6 (24 h expiry, rows kept for audit), SE §2 (no cap, `@@index([org,team,status])`).
- **Attack:** Any member agent can loop approval-gated calls (merge/export/delete/define) and mint unlimited `approval_requests` rows with full `argumentsSnapshot` payloads (snapshots can be large — merge snapshots include record data). Storage DoS plus a denial-of-attention flood on admins (every row surfaces in Nessie as an approval ask).
- **Fix:** Cap concurrent pending approvals per team (e.g. 100) and per requester (e.g. 10); dedupe identical `(action, argumentsHash)` pending rows; hard-delete expired rows after audit copy (or fold the fact into `audit_logs` and drop the snapshot).

### S3.5 — LOW — Token entropy and format unspecified
- **Where:** PF F6 (`approval_token: "apr_…"`), SE §2 (`continuationToken`).
- **Attack:** If implemented as a short random or sequential id, S3.2 becomes practical. 
- **Fix:** Specify ≥ 128-bit CSPRNG, prefixed (`apr_`), stored hashed (sha256) at rest — the DB needn't hold the bearer value.

### S3.6 — INFO — No policy-management surface exists, yet policies are "editable per tenant"
- **Where:** A&T §4 ("Defaults seeded per team … as rows, so they are editable"), MS §2–§8 (47 tools, none touch `policy_rules`/`policy_bindings`), PD (`approval.admin` allow rule with no tool that could exercise it).
- **Attack:** Not directly exploitable via MCP — but it means every policy change is a raw DB write by an operator, with no MRTR, no audit-chain integration guarantee, no validation that a tenant doesn't delete its own deny rules. The first operator script that edits policies becomes an unaudited privilege-escalation path, and the `approval.admin` rule guards a resource nothing can reach.
- **Fix:** Either ship a policy admin tool (admin-only, approval-gated, audited) or state explicitly that policies are immutable post-seed in v1 and edits require a migration. Remove or wire the dead `approval.admin` rule.

---

## 4. Policy engine

### S4.1 — HIGH — `restore` and `unlink` actions fall through the default table; delete-gate is bypassable via restore ambiguity
- **Where:** A&T §4 default table and PD rules cover `view|create|edit|link|delete|merge|export|define|admin` — there is **no `restore` action** in `PolicyAction` (SE §2 enum confirms) and no rule for it. `crm_record_restore` (MS §3) exists. `unlink` maps to `link.link`? Unstated.
- **Attack:** A member soft-delete is approval-gated, but if restore evaluates as (a) `record.edit` (allowed for members) the member can restore anything an admin deleted — including records deleted *for cause* (GDPR erasure, abusive data); if (b) hardcoded-deny, legitimate restores break and someone "fixes" it with a permissive rule. Ambiguity in a security default is a vulnerability on a schedule. Same for `unlink`: if it isn't explicitly `link.link`, a member unable to `link` may still be able to `unlink` (or vice versa) depending on implementer reading.
- **Fix:** Add `restore` to `PolicyAction` with a seeded rule mirroring `delete` (deny+approval for members). State normatively that `unlink` evaluates `link.link` (or add `link.unlink`). Add a policy-coverage test: every tool maps to exactly one (resourceType, action) pair, enforced by a registry test.

### S4.2 — MEDIUM — Deny-overrides semantics allow a high-priority `allow` to defeat lower `deny`; scope-chain ordering amplifies it
- **Where:** A&T §4 step 3 ("first matching rule's effect wins except any matching deny at equal-or-higher priority wins"), scope chain `[record?, object_type?, team, organization]`.
- **Attack:** The rule as written permits `allow(priority=10, scope=record)` to beat `deny(priority=0, scope=team)`. That is deliberate granularity — but combined with editable policies (S3.6) and free-form `conditions` (S4.3), an admin (or operator script) can punch a per-record hole in a team-wide deny and nothing in the model flags it. There is also no stated ceiling/floor on `priority` (arbitrary ints → precedence wars between rules).
- **Fix:** Document deny-overrides as absolute for v1 (any matching deny at any priority denies; priority orders allows only), or ship a `policy_simulate`-style evaluation trace in admin tooling so holes are visible. Bound priority to a small enum (e.g. 0/10/100).

### S4.3 — MEDIUM — `conditions` are unbounded JSON evaluated against record data — policy oracle
- **Where:** A&T §4 (only seeded condition is `sensitivity`), SE §2 (`PolicyRule.conditions Json?`). The evaluation semantics (which fields may be referenced, how values compare) are undefined.
- **Attack:** Once conditions can reference arbitrary record attributes, policy decisions become an oracle: a member probes `crm_record_update` outcomes or `POLICY_DENIED` vs success to infer values of attributes they cannot read (including `restricted` ones — the deny/allow distinction leaks a bit per call). Error payloads (`POLICY_DENIED { resource, action }`) are stable enough to automate this.
- **Fix:** Restrict v1 conditions to a closed set (`sensitivity`, `object_type`); state that condition evaluation never reads `records.data`; document that deny and approval-required are indistinguishable in error shape to non-admin callers if an oracle is unacceptable.

### S4.4 — MEDIUM — Duplicate/merge candidate evidence leaks values across policy boundaries
- **Where:** CT `records.ts` (`Candidate.evidence[].value: z.unknown()`), SE §6 (matching evidence includes `{attribute, value}`), PF F3 (candidates returned on `DUPLICATE_FOUND` and on `warn`).
- **Attack:** A member creates a record with a guessed restricted value (e.g. a private phone number). A `normalized`/`exact` rule on that attribute returns `evidence: [{kind:"exact", attribute:"private_phone", value:"+44…"}]` plus the **record_id** of the restricted record — confirming existence, confirming the guessed value, and handing over a target id for merge/link probing. `display_name` of the candidate (a `RecordSummary`) rides along too (see S5.1). Redaction is documented for record *rendering* (A&T §5) but never for candidate evidence.
- **Fix:** Apply `redactForActor` to candidate records and strip/withhold `evidence[].value` for attributes the caller may not view (return `{kind, attribute, matched: true}` instead). Consider suppressing `record_id` for blocked candidates the caller cannot view.

### S4.5 — LOW — Agent identity in bindings is not namespaced by app or deployment
- **Where:** PD `agent_inheritance`, A&T §4 (`agent:<agentId>` bindings), NI §1 (app key names the product; agentId comes from Nessie's context token).
- **Attack:** Two Nessie deployments (or Nessie + a future second product) share a UOA org/team. `agentId` strings are assigned by the caller's product; if deployment B mints `agentId = "assistant"` and tenant policy grants `agent:assistant` (intended for deployment A's agent), B's agent inherits the grant. `principal.app` is recorded but never part of binding identity.
- **Fix:** Make bindings `agent:<app>:<agentId>` (or document that agentIds must be deployment-unique and UOA enforces it).

---

## 5. Attribute-level redaction leaks

### S5.1 — HIGH — `display_name` is built from the primary attribute regardless of sensitivity, and leaks everywhere
- **Where:** SE §4.8 ("`display_name` from the primary attribute (`toSearchText`)"), SE §8 (search doc starts with `display_name`), CT (`RecordSummary.display_name` returned by search hits, timeline `about[]`, links `related`, duplicate candidates, change rows' embedded `record`).
- **Attack:** Tenant marks the `name` attribute of `person` `restricted` (sensible: a witness list, a VIP pipeline). `display_name` still contains the name and is returned to every member in every `RecordSummary` across search, timeline, links, duplicate candidates, change feed, and webhook envelopes. The redaction model (`redactForActor` removes *attributes*) structurally cannot catch this because the leak is a *denormalised column*, not an attribute in `data`.
- **Fix:** Forbid `sensitivity > internal` on `primary_attribute` (validate at define/update and when sensitivity is raised), and/or redact `display_name` to `null`/`"(restricted <type>)"` in `RecordSummary` when the caller may not view the primary attribute. State which.

### S5.2 — HIGH — `_n.<slug>` normalised shadow keys live inside `data` and are not covered by documented redaction
- **Where:** SE §6 ("normalised values stored in a per-attribute normalised shadow key `_n.<slug>` inside `data`"), A&T §5 (`redactForActor` removes "attributes the actor may not view" — attributes are addressed by slug).
- **Attack:** A member may not view restricted attribute `private_email`, but `RecordOut.data` includes `_n.private_email` unless redaction explicitly strips `_n.*` keys — the docs never say it does. The normalised form often *is* the sensitive fact (lower-cased email, E.164 phone, registrable domain). Also, `data` is returned wholesale in query/get/export paths, so one missed strip leaks in bulk.
- **Fix:** Specify that `redactForActor` strips all keys matching `_n.*` for redacted attributes (and that `_n.*` is never writable via `RecordData` — Slug regex already blocks it client-side, say so as an invariant). Add a contract test: redacted output never contains the restricted value in any form, including `_n.*`.

### S5.3 — HIGH — Merge/delete `snapshot` carries full pre-images (including restricted values) into `record_changes`; feed/webhook redaction only covers `old_value`/`new_value`
- **Where:** SE §4 delete ("writes a `delete` change with `snapshot`"), SE §7.6 (merge snapshot = `{survivorBefore, losers: [...full pre-images including links]}`), A&T §5 + EV §1 (redaction language covers only `old_value`/`new_value`), SE §2 (`RecordChange.snapshot Json?`).
- **Attack:** The change feed (`crm_changes_since`), `crm_record_history`, and webhook envelopes are built from `record_changes`. A merge or delete of a record with restricted attributes writes the *entire record* into `snapshot`. Unless consumers strip it, any member (pull) or any webhook endpoint (push, see S6.2) receives the full restricted content at the moment of merge/delete — precisely the moment a cover-up merge would happen.
- **Fix:** Extend the redaction clause to `snapshot`: either omit snapshots from all consumer-facing shapes (they're an engine-internal unmerge artefact) or run the same attribute redaction over them. State that `snapshot` never leaves the service except in `crm_unmerge` execution.

### S5.4 — HIGH — `crm_record_at` and `crm_record_history` redaction semantics undefined; sensitivity downgrade attack
- **Where:** MS §3 (`crm_record_at`, `crm_record_history`), CT `records.ts` (`Change.old_value/new_value`), A&T §5 (read path redaction described only for record reads).
- **Attack:** (a) History read applies no redaction → member reads restricted old/new values directly. (b) Even if current sensitivity is applied: an admin briefly lowers `salary` to `public`, a member snapshots history, sensitivity raised again — but worse and simpler: values set *while* an attribute was public remain visible in history forever after it becomes restricted. (c) `crm_record_at` reconstructs `data` — if it redacts by *current* sensitivity, fine for confidentiality but it also means restricted-at-read-time is the rule; the docs say nothing, so any of the three behaviours can ship.
- **Fix:** Normative: history/at/change-feed apply the *current* sensitivity of the attribute to *all* historical values (most conservative, simplest), and state that raising sensitivity is the remediation path and is retroactive.

### S5.5 — MEDIUM — Timeline and search-hit shapes embed `RecordOut`/`RecordSummary` without a stated redaction pass; `hops: 1` widens it
- **Where:** CT `records.ts` (`TimelineItem` carries full `RecordOut`), MS §6 (`hops: 1` includes linked records' items), MS §7 (search hits are `RecordSummary` only — good, but display_name caveat S5.1), SE §8 (search doc excludes confidential/restricted — but the *hit's* summary fields aren't covered).
- **Attack:** Timeline items for activity/note/task records carry full `RecordOut` of the activity plus `about[]` summaries of the linked records. If `redactForActor` is only applied on the primary record-read path (as A&T §5 reads), embedded records escape redaction. `hops: 1` turns one permitted read into a fan-out over linked records the caller has never been policy-checked against (record-level `view` is all-or-nothing by default, but attribute redaction per object type still applies — an activity about a person with restricted attributes embeds that person's summary).
- **Fix:** State that every serialisation of a record — primary or embedded, in any tool result — passes through `redactForActor` with the caller's ctx; one code path, tested per tool.

### S5.6 — LOW — `redacted_attributes` is an existence oracle; schema resource exposes restricted attribute metadata
- **Where:** CT `records.ts` (`redacted_attributes: [slug…]`), MS §1 (`crm://schema/{type}` returns attributes with sensitivity and descriptions to all callers).
- **Attack:** Members enumerate the exact slugs, names and 500-char descriptions of restricted attributes ("ceo_personal_phone", description "direct line, do not share"), and per-record learn which ones are *populated*. Low severity but unnecessary.
- **Fix:** Return `redacted_attributes: string[]` as count or omit for non-privileged callers; consider hiding restricted attribute *descriptions* from `crm://schema` for members (keep slug+type so tools still validate).

---

## 6. SSRF and export/URL signing

### S6.1 — MEDIUM — Webhook SSRF guard is registration-time prose; delivery-time DNS rebinding/redirect behaviour unspecified
- **Where:** CT `tools.ts` (`url: "https only, public host"`), EV §3 ("public host (SSRF guard)"), AR §4 (`safeFetch`, "IP-pinned").
- **Attack:** The URL is validated at `crm_webhook_set` time but *fetched later by the worker*. Classic TOCTOU: register `https://attacker.example` while it resolves to a public IP, flip DNS to `169.254.169.254` / `10.x` afterwards. Nothing states the worker re-resolves and re-pins through `safeFetch` on every delivery, that redirects are refused (a 302 to an internal address defeats registration-time checks entirely), or that non-443 ports / userinfo / IP-literal hosts are rejected. The worker signs and POSTs change batches — a successful pivot turns DeepCRM into an authenticated internal-port scanner (response codes/timing distinguishable via `last_error` in `crm_webhook_list`).
- **Fix:** Normative: delivery always goes through `safeFetch` (fresh resolution, IP pinned for the connection, private/loopback/link-local ranges refused at connect time), redirects not followed, port 443 only, no userinfo; re-validate on every attempt, not just registration.

### S6.2 — HIGH — Webhook registration is an un-gated bulk-exfiltration channel that bypasses export approval; new/re-enabled webhooks replay full history
- **Where:** MS §8 (`crm_webhook_set` "Admin only" — *not* approval-gated), PD (`webhook.admin` deny/allow — no `requires_approval`, unlike export), EV §2 ("`record_changes` are never deleted"), EV §3 (re-enable "resumes from `last_delivered_seq`", new webhook defaults `last_delivered_seq = 0`), EV §1 ("webhooks are evaluated as `role:admin`" — admins *can* view restricted, so restricted values flow, S5.3/S5.4 compound this).
- **Attack:** One compromised admin delegation (or a confused deputy: Nessie's integration code runs `crm_webhook_set` under an owner delegation — NI §5) registers a webhook to an attacker URL. First delivery replays the *entire retained change history* (seq > 0, history never deleted), including restricted attribute values (evaluated as admin), merge/delete snapshots (S5.3), and full actor/provenance metadata. This is `crm_export` with no MRTR approval, no audit-visible export event distinct from normal ops, and an ongoing tap. Approval-gating export but not this is an inconsistent security boundary.
- **Fix:** (a) New webhooks start at the *current* max seq; history replay requires a separate approval-gated action. (b) Make `webhook.admin` `requires_approval` for members *and* admins (owner-only, per S3.3 fix) for URL create/change. (c) Re-state webhook payload redaction: strip restricted values and snapshots from push payloads regardless of the "evaluated as admin" shortcut — the consumer is a network endpoint, not a principal.

### S6.3 — HIGH — Export pipeline: signed URL scheme, redaction, and task-result access all unspecified
- **Where:** MS §8 ("signed download URL valid for 1 h"), CT (`ExportResult { url, rows, expires_at }`, `crm_export` takes `attributes?: [slug]` — caller-selected projection), S1.1 (task result readable via `tasks/get`).
- **Attack:** Compounding gaps: (a) Does export apply `redactForActor`/attribute policy to the exported rows? An admin-approved export requested *with* `attributes: ["salary", "private_phone"]` — approval message says "Export person" while args carry the restricted projection (S3.1 decides whether the approver even sees that). (b) The signed URL is a bearer token good for 1 h, readable by anyone who can `tasks/get` the job (S1.1) or see Nessie run state; no statement of single-use, IP-binding, or where it's served from. (c) No row cap on export.
- **Fix:** Specify: export honours attribute-level policy for the *approver's* role (the approval must display the exact attribute list); URL is single-purpose, expiry ≤ 1 h, served from a dedicated host with its own signing key; document the signing scheme (HMAC of path+expiry, key in keyring). Cap rows per export.

---

## 7. Secrets handling

### S7.1 — MEDIUM — Webhook secret is returned in an agent-visible tool result
- **Where:** MS §8 (`secret: string (shown once)`), NI §5 (Nessie then stores it via a separate API).
- **Attack:** The "shown once" value is shown *to the calling agent* — it lands in model context, tool-result logs, and Nessie run transcripts, all of which are exactly the places secrets are not supposed to persist. Any later prompt-injection against that agent (or log reader) recovers the HMAC secret and can forge `deepcrm.webhook.v1` deliveries to Nessie's ingestion endpoint (which trusts the signature, EV §5).
- **Fix:** Return the secret only when the call is made under a *human-direct* principal (the future non-agent path), or better: never return it via MCP — deliver it through the same out-of-band channel Nessie uses to store it (`PUT …/webhook-secret` flow inverted: DeepCRM posts the secret to a pre-registered Nessie endpoint, or Nessie generates the secret and DeepCRM stores it). At minimum, document that the tool result must be treated as secret material by the client (Nessie must strip it from model context).

### S7.2 — LOW — Keyring is a single env var with no rotation story; app-key storage mixes with it operationally
- **Where:** AR §6 (`DEEPCRM_SECRET_KEYRING_B64`), EV §3 (AES-256-GCM keyring), A&T §1 (app keys hashed — good).
- **Attack:** Key rotation requires re-encrypting every `webhooks.secret_ciphertext` or all signatures break; no doc names a rotation procedure or key versioning (ciphertexts carry no key id). An operator forced to rotate under incident pressure will either break all webhooks or postpone indefinitely.
- **Fix:** Version the keyring (`kid` prefix on ciphertexts, env carries `kid:b64` pairs, decrypt falls back across kids, encrypt uses latest). One sentence each in EV §3 and AR §6.

### S7.3 — LOW — Replay window on the *receiver* side is DeepCRM's recommended 300 s with per-event dedupe optional
- **Where:** EV §3 (receiver verification: 300 s window; Nessie "dedupes on seq" — NI §5 says "may", dedupe described as rendering concern).
- **Attack:** An attacker who captures one signed batch (webhook payloads traverse whichever infrastructure terminates TLS for the receiver) can replay it inside 300 s; if the receiver treats batches as commands rather than awareness (the `matrix_room` future target posts structured content *agents in the room read and act on* — EV §4), replayed seq values could trigger duplicate downstream actions where consumers skip dedupe.
- **Fix:** State that receivers MUST dedupe on `(webhook_id, until_seq)` and reject `until_seq ≤ last seen`; keep 300 s.

---

## 8. Audit chain

### S8.1 — MEDIUM — Hash chain has a concurrency fork and no anchoring; denial auditing unspecified
- **Where:** A&T §6 (`entry_hash = sha256(prev_hash ∥ canonical JSON)` per organisation), SE §2 (`AuditLog`, no lock described), SE §4.11 (writeAudit inside the mutation tx).
- **Attack:** Two concurrent transactions in one org both read the same tail `prev_hash` → two valid children of one parent → the chain forks and `verify-audit-chain.mjs` either fails spuriously or (worse) the verifier is written to tolerate forks and loses its meaning. Serialization (an advisory lock per org on audit write) is never mentioned. Also: chain integrity only detects tampering if an external anchor exists — anyone with DB write can recompute the whole chain from any point. And "written inside the same transaction as the mutation" means *denied* attempts (no mutation, no transaction) have no stated audit — a policy-probing campaign (S4.3) leaves no trace.
- **Fix:** Take `pg_advisory_xact_lock(hashtext(org || ':audit'))` in `writeAudit`; periodically anchor the tail hash externally (even a signed log line to Ledger); specify that denials and authentication failures are audited (outcome `denied` exists in the enum — wire it) with metadata limited to ids/codes per the logging rules.

### S8.2 — LOW — Audit rows survive tenant deletion with UOA ids intact, forever
- **Where:** A&T §3 (`audit_logs` no FK, survives), SE §2 (stores `actor_id`, `on_behalf_of`, `ip_address`, `user_agent`).
- **Attack:** Post-deletion retention of per-user identifiers and IPs with no stated retention or erasure path conflicts with the deletion promise a tenant thinks it got ("Tenant deletion cascades CRM data") and with GDPR erasure. An org that leaves leaves its users' activity metadata behind indefinitely.
- **Fix:** Define audit retention (e.g. N years then crypto-shred or hash-truncate personal fields); document it next to the "survives deletion" note.

---

## 9. DoS vectors

### S9.1 — HIGH — `Filter` grammar has no depth/size bound
- **Where:** CT `filter.ts` (`z.lazy` recursive union, no max depth, no max nodes), SE §5.
- **Attack:** A single `crm_records_query` (member-allowed by default) with a 10,000-node nested `and/or/not` tree — zod parse cost, query-compiler cost, and a generated SQL with thousands of JSONB predicates. Repeated in parallel, this is CPU exhaustion with one tool call. `z.lazy` recursion also risks stack depth on pathological nesting before any DB work.
- **Fix:** Cap filter depth (≤ 8), total nodes (≤ 100), and serialized size (≤ 16 KiB) in the schema; reject with `VALIDATION_FAILED`.

### S9.2 — HIGH — Unbounded request bodies and record sizes
- **Where:** CT (`CrmRecordsBulkAssert.rows` has `.min(1)` and **no `.max()`** — cap is env-only `DEEPCRM_MAX_BULK_ROWS` at 10,000; each row allows 20 links and unbounded `data`), CT (`json` attribute ≤ 64 KiB, `rich_text` ≤ 100k, up to 100 attributes/type ⇒ single record ≈ 6–10 MB), AR §6 (no HTTP body limit listed), MS §0.5.
- **Attack:** One `tools/call` can POST hundreds of MB (10k rows × multi-MB `data`) — memory pressure in the API before zod even finishes. Record fetch paths return up to 200 such records per page (`Limit` max 200) ⇒ multi-GB responses. `crm_activity_log` body 100k × `about: 20` fans out `last_activity_at` updates and reindex jobs per call (embedding calls downstream, S9.4).
- **Fix:** Enforce a hard HTTP body cap (e.g. 10 MB) at the Fastify level and state it; add `.max()` to `rows` in the zod (mirror the env cap); cap total `data` size per record (e.g. 512 KiB serialized) in `validateRecordData`; consider a lower page cap for attribute-heavy types or response-size guard.

### S9.3 — MEDIUM — Fuzzy trigram matching and dedup scans are quadratic amplifiers on the write path
- **Where:** SE §6 (`similarity(display_name, candidate) >= threshold` on every create/assert with a fuzzy rule), CT (`threshold` min 0.3 — low thresholds ⇒ huge candidate sets), SE §2 (trgm GIN index on `display_name` exists — good), `crm_find_duplicates` (full-type scan + semantic, unbounded per-team concurrency).
- **Attack:** At 0.3 threshold, adversarial display names ("aaaa…common tokens") match a large fraction of the table; every create/assert in a bulk job (10k rows) runs this ⇒ O(n·m) trigram evaluations inside write transactions holding advisory locks (SE §4.4) — lock convoy plus CPU burn from a single bulk assert. `crm_find_duplicates` can be enqueued repeatedly; nothing caps concurrent jobs per team.
- **Fix:** Require the trgm index to serve the query (raise min threshold to ~0.5, use `word_similarity` with `%` operator or explicit `SET pg_trgm.similarity_threshold`), cap candidate evaluation per write (e.g. top 20), bound matching work per bulk row, and add per-team job concurrency limits (one dedup scan at a time, N bulk jobs max).

### S9.4 — MEDIUM — Embedding calls are a per-write, unbatched external dependency with no stated backpressure
- **Where:** SE §8 (embed via Ledger `/v1/jina` per reindex), SE §4.12 (`record.reindex` enqueued per write), AR §6 (`LEDGER_PROXY_TOKEN`).
- **Attack:** A bulk assert of 10k rows enqueues 10k reindex jobs ⇒ 10k embedding requests to Ledger (cost amplification billed to the deployment; rate-limit cascading failures into the queue with retries). Ledger outage ⇒ reindex jobs retry and the queue backs up, delaying `change.deliver` (shared worker).
- **Fix:** Batch embeddings (up to N records per Ledger call), circuit-breaker + dead-letter on embedding failure (record searchable by keyword meanwhile), per-team embedding rate limit, separate queue lanes so reindex backlog cannot starve webhook delivery.

### S9.5 — MEDIUM — Idempotency replay returns stored results without stated policy re-check; keys are agent-chosen and predictable
- **Where:** SE §4.13 ("hit with same `arguments_hash` ⇒ return stored result"), CT (`IdempotencyKey` min 8 chars, example `"gmail:msg:18f2…"` — structured, guessable), SE §2 (`IdempotencyReplay.result Json` — full result incl. redacted-shaped record for the *original* caller).
- **Attack:** Results are shaped for the original caller's redaction context. If a second principal in the same team presents the same key + identical args (keys are predictable in sync workloads: source-system ids), they receive the stored result computed for the original caller — if the original was an admin and the replayer a member, restricted fields leak via the cached `result`. No statement binds replays to the principal or re-runs redaction.
- **Fix:** Include the principal identity (app, uoaUserId) in the replay uniqueness check, or re-run `redactForActor` on the stored result at replay time. Also state a 24 h purge job for `idempotency_replays` (currently unstated — the `retention.ts` job's scope covers soft-delete/merge snapshots only).

### S9.6 — LOW — Full-history pulls and unbounded `include_total`
- **Where:** EV §2 (`crm_changes_since` with omitted cursor starts at the oldest retained row; history never deleted), CT (`include_total` forces COUNT over arbitrary filters).
- **Attack:** Any member can paginate the entire team history (200 rows/call, unlimited calls) — a sanctioned exfiltration walk and a seq-scan generator; `include_total` over a `contains` filter on an unindexed attribute forces full scans. Both are policy-allowed today; the issue is absence of rate limiting anywhere in the docs.
- **Fix:** Add a global per-principal rate limit (state it in AR §4/env) and per-team concurrency cap on expensive tools; consider charging `include_total` and history walks against a stricter bucket. Document expected abuse handling even if v1 defers implementation.

---

## 10. Misc boundary gaps

### S10.1 — MEDIUM — MRTR confirmations are not bound to arguments or principal
- **Where:** MS §0.4, PF F5, CT `mrtr.ts` (`confirm: { confirmed: boolean }` — no token, no hash).
- **Attack:** The confirmation flow has no `arguments_hash`. An agent requests `crm_attribute_archive { attribute: "fax" }`, gets the confirmation prompt, then re-issues with `{ attribute: "ssn" , confirm: { confirmed: true } }`. Nothing in the documented shape prevents the confirmation for X from satisfying the re-issue for Y — unless the server implicitly re-derives the MRTR requirement per call and merely checks `confirmed === true` on the *current* args (safe), but that is never stated. Same-session confusion (parallel confirmations) similarly ambiguous.
- **Fix:** Give confirmations the same treatment as approvals: a `confirmation_token` bound to (tenant, tool, canonical args hash, principal, short TTL), or state explicitly that confirmation is stateless and the server re-evaluates the MRTR condition on the re-issued args (and that `confirmed:true` never carries across different args).

### S10.2 — MEDIUM — Caller-supplied `owner`, `assignee`, `participants` (`Actor`) accept arbitrary ids with no validation or policy
- **Where:** CT (`CrmRecordCreate/Update.owner`, `CrmTaskCreate.assignee`, `CrmActivityLog.participants` — `Actor = { type, id: string }`).
- **Attack:** Any member sets `owner`/`assignee` to an arbitrary UOA user or agent id — including ids of users in *other* teams (no cross-tenant check is possible against UOA from DeepCRM, but nothing states even format/existence validation). Consequences: notification/routing confusion downstream (Nessie renders owner), audit pollution, and `actor_reference` filter/sort poisoning. Low data-confidentiality impact, real integrity nuisance.
- **Fix:** Validate `Actor.id` shape; document that ownership reassignment requires `record.edit` on the record (already implied) plus, for setting owner to another human, nothing more — but say so; reject empty/whitespace ids.

### S10.3 — LOW — Org-scope policy rules vs per-team rows model is incoherent
- **Where:** A&T §4 (`PolicyScope organization`, scope chain includes organization), SE §2 (`PolicyRule` rows carry `team_id`; seeded per team).
- **Attack:** An org-scope rule must live in some team's rows to be evaluated — which team owns it, and does it affect sibling teams? As written, an operator adding an org-wide deny would insert it per team; drift between teams creates inconsistent enforcement that looks org-wide but isn't. Not directly exploitable via MCP (no policy surface, S3.6) but a design trap for the first admin tooling.
- **Fix:** Either drop `organization` scope in v1 or make org-scope rows first-class (`team_id` nullable + evaluation union across org rows).

### S10.4 — LOW — Error payload echoes can leak schema internals; `INTERNAL` handling unstated
- **Where:** CT `errors.ts` (`issues[].path/message`, `DUPLICATE_FOUND.record_id`, `MERGED.redirect_to`), MS §0.3.
- **Attack:** `VALIDATION_FAILED.issues` from zod can echo rejected *values* in messages (zod default messages include received values for some types); `MERGED.redirect_to`/`DUPLICATE_FOUND.record_id` disclose record ids of records the caller may not be able to view (existence + targeting, compounds S4.4). `INTERNAL` mapping (does it leak stack/SQL?) unspecified.
- **Fix:** Specify issue messages are templates without values; gate `record_id`/`redirect_to` behind view permission (else return generic `DUPLICATE_FOUND`); `INTERNAL` returns only a correlation id.

---

## Priority summary

| # | Finding | Severity |
|---|---|---|
| S5.1 | display_name built from restricted primary attribute | HIGH |
| S5.3 | merge/delete snapshots bypass feed/webhook redaction | HIGH |
| S6.2 | webhook registration = unapproved full-history exfil channel | HIGH |
| S1.1 | tasks/get tenant check unspecified (export URL exposure) | HIGH |
| S2.1 | context JWT lacks aud/iss binding (cross-service confusion) | HIGH |
| S2.3 | REQUIRE_AUTH=false dev principal in prod | HIGH |
| S5.2 | `_n.*` shadow keys not covered by redaction | HIGH |
| S5.4 | record_at/history redaction undefined | HIGH |
| S3.1 | approval arguments_hash canonicalisation undefined | HIGH |
| S3.2 | approval token consumption not stated tenant/tool-bound | HIGH |
| S6.3 | export redaction/signing/task-access unspecified | HIGH |
| S9.1 | filter grammar unbounded | HIGH |
| S9.2 | request/record size unbounded | HIGH |
| S4.1 | restore/unlink missing from policy defaults | HIGH |
| S2.2 | context token replay within TTL (provenance forgery) | MEDIUM→(HIGH if per-agent bindings used) |
| S1.2 | org/team pairing not verified on resolve | HIGH |
| S6.1 | webhook SSRF TOCTOU at delivery | MEDIUM |
| S3.3 | approver role solely from delegation claim; required_role degraded | MEDIUM |
| S2.4/S2.5 | tv unenforced; delegation TTL uncapped | MEDIUM |
| S8.1 | audit chain fork / no denial audit / no anchor | MEDIUM |
| S9.3/S9.4/S9.5 | trigram, embedding, idempotency-replay DoS/leak | MEDIUM |
| S4.2/S4.3/S4.4/S4.5 | policy ordering/conditions/evidence/agent-namespace | MEDIUM |
| S5.5/S5.6 | embedded-record redaction / metadata oracle | MEDIUM/LOW |
| S1.3/S1.4/S1.5 | provisioning flood, worker trust, lint-only tenancy | MEDIUM/LOW |
| S2.6/S2.7 | app key scoping; claim validation | MEDIUM/LOW |
| S3.4/S3.5/S3.6 | approval spam; token entropy; no policy surface | MEDIUM/LOW |
| S7.1/S7.2/S7.3 | secret in tool result; keyring rotation; receiver dedupe | MEDIUM/LOW |
| S8.2 | audit retention post-deletion | LOW |
| S10.1–S10.4 | confirmation binding; Actor validation; org-scope incoherence; error echoes | MEDIUM/LOW |

**Systemic themes:** (1) the redaction model is defined only for the primary record-read path while at least five other serialisation paths (display_name, `_n.*`, snapshots, history, embedded records, candidate evidence) are unspecified — every one leaks; (2) the export approval gate is undermined by two parallel un-gated channels (webhook replay, task results); (3) the context token and approval token designs lack binding clauses (aud, jti, canonical hash, tenant scope) that must be written into the docs now, because implementers will not invent them; (4) nothing anywhere states rate limits, body caps, or job quotas.
