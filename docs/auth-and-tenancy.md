# Auth, tenancy and policy

## 1. Inbound MCP authentication

Every `/mcp` request is authenticated independently (the protocol is stateless; there is no session). Three headers, three independent proofs — the DeepSignal `auth/mcp-inbound.ts` model:

| Header | Proves | Verification |
|---|---|---|
| `Authorization: Bearer <app key>` | the calling **product** (Nessie deployment) | SHA-256 of the key compared (timing-safe) against `DEEPCRM_APP_KEYS` (`name:sha256hex,…`). The name becomes `principal.app`. |
| `X-UOA-Delegation: <JWT>` | the **human** and **workspace** the call acts for | RS256 via `UOA_JWKS_URL`; `iss = UOA_ISSUER`, `aud = UOA_AUDIENCE` (= `DEEPCRM_API_PUBLIC_URL`), `exp` **and** `iat` with `exp − iat ≤ 15 min` (the delegation is the revocation bound; `tv` is recorded for audit but not introspected online in v1); claims `sub` (UOA user id), `org` (UOA organisation id), `team` (UOA team id), `role` (`owner\|admin\|member` — the caller's role in that team; absent ⇒ `member`), `tv` (credential epoch), `scope` contains `ai.invoke`. |
| `X-Nessie-Context: <JWT>` | **agent/run provenance** | RS256 via `NESSIE_CONTEXT_JWKS_URL`; **`aud = DEEPCRM_API_PUBLIC_URL` and a fixed `iss` required** (the signer serves several products; an un-audienced token from a sibling product must not verify here — review S2.1); max TTL 300 s, 30 s skew; claims `agentId`, `runId`, `toolCallId`, `requestId`, `sub` = same UOA user as the delegation (strict string equality; mismatch ⇒ 401). |

Rules:
- Every token's claims are schema-validated (zod): required, non-empty, correct types; garbage claims are a 401, never a coerced value.
- **Destructive calls are replay-bounded:** `crm_merge_records`, `crm_record_delete`, `crm_export`, `crm_webhook_*`, `crm_unmerge` and approval consumption record the context token's `requestId` in a 300 s seen-set and reject replays. Other calls accept the residual 5-minute provenance-replay risk, documented (review S2.2).
- All three required when `REQUIRE_AUTH=true`. Missing/invalid ⇒ HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="<DEEPCRM_API_PUBLIC_URL>/.well-known/oauth-protected-resource"` (RFC 9728).
- With `REQUIRE_AUTH=false` the server serves the **dev principal** (`app=dev`, `user=usr_dev`, `org=org_dev`, `team=team_dev`, `agent=agent_dev`, role `owner`). **Boot fails closed:** the process refuses to start with `REQUIRE_AUTH=false` when `DEEPCRM_API_PUBLIC_URL` is not a localhost origin or `NODE_ENV=production` (review S2.3).
- Headers are read case-insensitively; a request carrying *both* a valid delegation and a different `sub` in the context is rejected.
- The principal is bound into the per-request `McpServer`; tool handlers receive `ctx` and **never** accept `organizationId`/`teamId`/`userId` arguments.

Future (brief §9 Q3): a non-Nessie client presenting only a UOA OAuth token (CIMD per MCP 2026-07-28). The seam is `packages/mcp-inbound/src/authenticate.ts` returning `Principal`; adding a second strategy does not touch tools.

## 2. Principal and ActorContext

```ts
type Principal = {
  app: string                    // app key name
  uoaUserId: string
  uoaOrgId: string
  uoaTeamId: string
  role: 'owner' | 'admin' | 'member'   // from the delegation's role claim; absent ⇒ member
  credentialEpoch: number        // tv (recorded, not introspected in v1)
  agentId: string | null         // null when a human calls directly (future)
  provenance: { runId: string; toolCallId: string; requestId: string } | null
}

type ActorContext = {
  tenant: { organizationId: string; teamId: string }   // local ids, resolved 1:1 from UOA ids
  actor: { type: 'human' | 'agent' | 'system'; id: string }  // agent when agentId present, else human
  onBehalfOf: { uoaUserId: string; role: 'owner' | 'admin' | 'member' }  // always the human, with their team role
  provenance: Principal['provenance']
  requestId: string
  now: Date
}
```

`actor` is the agent when `agentId` is present (the agent did the write, for the human). Policy is evaluated for **both**: the agent binding and the human's role — a deny on either denies.

## 3. Tenancy

- `organizations.external_org_id` ⇔ UOA organisation id (unique). `teams.external_team_id` ⇔ UOA team id (unique), `teams.organization_id` FK.
- `resolveTenant(principal)` upserts both rows (name placeholders `Organisation <id8>`, `Team <id8>`; names are non-authoritative mirrors — DeepCRM stores no other UOA data) and returns local ids **plus the current `schema_version` and `policy_version` in the same query** (the cache keys, §4 of schema-engine). Runs once per request; the in-process 60 s cache holds **id resolution only**, never schema or policy state.
- **Pairing check:** if the team row exists, its `organization_id` must equal the resolved organisation's id — else 401 `TENANT_MISMATCH`. Re-parenting a team is an operator migration, never implicit (review S1.2).
- **First-contact provisioning** (flow F10) is serialised by an advisory lock on the external team id, seeds idempotently (`ON CONFLICT DO NOTHING`), is rate-limited per app key, and honours an optional `DEEPCRM_ORG_ALLOWLIST` env (comma-separated UOA org ids) for closed deployments.
- Every CRM table carries `organization_id` **and** `team_id`; every query filters on both. **The one definition** is `packages/db/src/tenant-where.ts` — `tenantWhere(tenant: { organizationId, teamId })` returning the spreadable where-fragment. Enforcement is layered: `scripts/lint-tenant-where.mjs` (covering every tenant-scoped model and all find/count/update/delete ops) plus a runtime Prisma extension that throws on a CRM-table query without both tenant columns in `where` outside tests (review S1.5). Worker job handlers re-resolve the tenant from payload ids and abort on mismatch (review S1.4).
- Tenant deletion cascades CRM data; `audit_logs` has no FK and survives.

## 4. Policy

Tables `policy_rules` and `policy_bindings` as in nessie (`docs/schema-engine.md` §2.10).

```
PolicyScope        team | object_type | record | list        (organization scope deferred — per-team rows cannot express it coherently; review S10.3)
PolicyResourceType schema | object_type | attribute | record | link | list | view | merge | export | webhook | approval
PolicyAction       view | create | edit | delete | restore | link | merge | export | define | admin
PolicyEffect       allow | deny
actorType          human | agent | role
  role   = owner | admin | member — from the delegation `role` claim (Principal.role)
  agent  = namespaced `agent:<app>:<agentId>` so two products' agent ids can never collide on a grant (review S4.5)
```

Rules of evaluation:
- `restore` is a first-class action seeded to mirror `delete`; `unlink` evaluates the `link` action (review S4.1).
- **Deny is absolute in v1**: any matching deny denies, regardless of priority; priority orders competing allows only (review M12/S4.2).
- `conditions` is a closed set — `{ sensitivity }` only; condition evaluation never reads record data (review S4.3).
- **Policies are immutable post-seed in v1** — no tool mutates `policy_rules`/`policy_bindings`; edits are operator migrations. A policy-admin tool surface is an open question (brief §9).
- An agent is evaluated against **both** its `agent:` bindings and the human's `role:` bindings; a deny from either denies. Agents hold no standing rights without an agent binding.

`checkPolicy(ctx, resourceType, action, scopeChain)`:
1. Collect rules for the tenant where `(resourceType, action)` match and `scope/scopeId` is in the chain `[record?, object_type?, list?, team]`.
2. Bindings matching the actor: `agent:<app>:<agentId>`, `human:<uoaUserId>`, `role:<ctx.onBehalfOf.role>`.
3. Any matching `deny` ⇒ deny. Otherwise the highest-priority matching `allow` wins.
4. No matching rule ⇒ deny for `define/merge/export/delete/restore/admin`, allow for `view/create/edit/link` (the seeded defaults in `docs/spec/policy-defaults.json` make this explicit per team).

Defaults seeded per team on first resolve, from `docs/spec/policy-defaults.json` (normative; rows are immutable post-seed in v1 — see above):

| resource.action | member | admin/owner |
|---|---|---|
| record.view/create/edit/link | allow | allow |
| record.delete / record.restore | deny (approval) | allow |
| schema.define, object_type.*, attribute.*, relation_type.* | deny (approval) | allow |
| merge.merge | deny (approval) | allow |
| export.export | deny (approval) | allow |
| webhook.admin | deny | allow (approval — registration replays data outward; review S6.2) |
| attribute.view where sensitivity=restricted | deny | allow |
| attribute.edit where sensitivity=confidential | deny | allow |

"deny (approval)" means the tool returns MRTR `input_required` (spec-shaped elicitation + `requestState`, see `mcp-surface.md` §0.4) instead of a hard denial, creating an `approval_requests` row. Approval mechanics (normative, reviews S3.1–S3.5, C8):

- `arguments_hash` = sha-256 of **canonical JSON** (recursively sorted keys, NFC strings, arrays in order, no whitespace) of the complete tool arguments minus MRTR fields; the same canonical form the audit chain uses.
- The approved execution runs **from the stored `argumentsSnapshot`**, never from the retry body.
- Consumption predicate: token (compared by sha-256 against `continuation_token_hash`) must match a `pending`, unexpired row in the **caller's tenant** whose `action` equals the tool name and whose `argumentsHash` equals the canonical hash; the consumer's `Principal.role` must satisfy `required_role` **exactly** (owner ≠ admin); the approver's `uoaUserId` must differ from the request's `on_behalf_of`. The `pending → consumed` transition is a conditional `UPDATE … RETURNING` **in the same transaction as the mutation** — zero rows ⇒ `APPROVAL_REQUIRED` with a structured reason.
- Caps: ≤ 100 pending per team, ≤ 10 per requester; identical `(action, argumentsHash)` pending rows dedupe. Tokens are ≥ 128-bit CSPRNG, returned once inside `requestState`, stored only hashed.
- The `schema.define` member default is deny-with-approval, matching `policy-defaults.json` (the table below is aligned with that file; the JSON is normative).

## 5. Attribute sensitivity

`attributes.sensitivity ∈ public | internal | confidential | restricted`.

**One rule: every serialisation of a record — primary, embedded (timeline items, link `related`, candidates, search hits, feed events, webhook payloads) — passes through `redactForActor(record, schema, ctx)`.** One code path, tested per tool (review S5.5). Specifics:

- Redacted attributes are **absent** from `data` (not null) and listed in `redacted_attributes: [slug…]`; an echo-back patch that writes one fails with an error naming it. Keeping the slugs visible is a deliberate trade-off (agents must know why data is missing) — review S5.6, accepted.
- `display_name` cannot leak: a primary attribute's sensitivity may not exceed `internal` (enforced at define/update/sensitivity change) — review S5.1.
- **History is redacted by the attribute's current sensitivity, retroactively**: `crm_record_history`, `crm_record_at` and the change feed apply today's sensitivity to all historical values, so raising sensitivity is a retroactive remediation (review S5.4).
- `snapshot` payloads (merge/delete pre-images) never leave the service in any shape (review S5.3).
- Search documents exclude `confidential` and `restricted` values; webhook payloads are redacted as above — the push consumer is a network endpoint, not a principal, so no admin shortcut applies.
- Idempotency replays are principal-bound (schema §2), so a cached result never crosses redaction contexts.

## 6. Audit

`audit_logs` — nessie's hash-chained table: `actor_type, actor_id, on_behalf_of, action, resource_type, resource_id, outcome, reason, metadata, request_id, ip_address, user_agent, prev_hash, entry_hash`.

- Written by `writeAudit(tx, …)` inside the same transaction as the mutation, under the audit advisory lock (namespace 5, per organisation) taken **immediately before the insert with no locks taken after it** — the serialisation is what prevents chain forks under concurrency, and its per-org write ceiling is accepted and documented (review C9).
- **Exact formula (both implementations must agree byte-for-byte):** `entry_hash = sha256hex( utf8( (prev_hash ?? "") + "\n" + canonicalJson(entry) ) )` where `canonicalJson` = recursively sorted keys, NFC strings, arrays in order, no whitespace, numbers via `JSON.stringify` — and `entry` is the row minus `id`, `prev_hash`, `entry_hash`.
- **Denied attempts are audited too** (`outcome: denied`, and auth failures with a null tenant column) — a policy-probing campaign leaves a trace (review S8.1).
- `scripts/verify-audit-chain.mjs` reads `DATABASE_URL`, verifies every organisation's chain, exits 0 when none exist, non-zero naming the first broken row.
- Retention: audit rows survive tenant deletion; after `DEEPCRM_AUDIT_RETENTION_YEARS` (default 7) personal fields (`actor_id`, `on_behalf_of`, `ip_address`, `user_agent`) are crypto-shredded while the chain stays verifiable (hash inputs retain the original values only in hashed form) — review S8.2.
