# Auth, tenancy and policy

## 1. Inbound MCP authentication

Every `/mcp` request is authenticated independently (the protocol is stateless; there is no session). Three headers, three independent proofs — the DeepSignal `auth/mcp-inbound.ts` model:

| Header | Proves | Verification |
|---|---|---|
| `Authorization: Bearer <app key>` | the calling **product** (Nessie deployment) | SHA-256 of the key compared (timing-safe) against `DEEPCRM_APP_KEYS` (`name:sha256hex,…`). The name becomes `principal.app`. |
| `X-UOA-Delegation: <JWT>` | the **human** and **workspace** the call acts for | RS256 via `UOA_JWKS_URL`; `iss = UOA_ISSUER`, `aud = UOA_AUDIENCE` (= `DEEPCRM_API_PUBLIC_URL`), `exp`; claims `sub` (UOA user id), `org` (UOA organisation id), `team` (UOA team id), `tv` (credential epoch), `scope` contains `ai.invoke`. |
| `X-Nessie-Context: <JWT>` | **agent/run provenance** | RS256 via `NESSIE_CONTEXT_JWKS_URL`; max TTL 300 s, 30 s skew; claims `agentId`, `runId`, `toolCallId`, `requestId`, `sub` = same UOA user as the delegation (mismatch ⇒ 401). |

Rules:
- All three required when `REQUIRE_AUTH=true`. Missing/invalid ⇒ HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="<DEEPCRM_API_PUBLIC_URL>/.well-known/oauth-protected-resource"` (RFC 9728).
- With `REQUIRE_AUTH=false` (local dev only) the server serves the **dev principal**: `app=dev`, `user=usr_dev`, `org=org_dev`, `team=team_dev`, `agent=agent_dev`.
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
  credentialEpoch: number        // tv
  agentId: string | null         // null when a human calls directly (future)
  provenance: { runId: string; toolCallId: string; requestId: string } | null
}

type ActorContext = {
  tenant: { organizationId: string; teamId: string }   // local ids, resolved 1:1 from UOA ids
  actor: { type: 'human' | 'agent' | 'system'; id: string }  // agent when agentId present, else human
  onBehalfOf: { uoaUserId: string }                     // always the human
  provenance: Principal['provenance']
  requestId: string
  now: Date
}
```

`actor` is the agent when `agentId` is present (the agent did the write, for the human). Policy is evaluated for **both**: the agent binding and the human's role — a deny on either denies.

## 3. Tenancy

- `organizations.external_org_id` ⇔ UOA organisation id (unique). `teams.external_team_id` ⇔ UOA team id (unique), `teams.organization_id` FK.
- `resolveTenant(principal)` upserts both rows (name placeholders `Organisation <id8>`, `Team <id8>`; names are non-authoritative mirrors — DeepCRM stores no other UOA data) and returns local ids. Runs once per request, cached in-process by UOA ids for 60 s.
- Every CRM table carries `organization_id` **and** `team_id`; every query filters on both. `tenant_scope.ts` exports `tenantWhere(ctx)` and there is a lint rule: any `prisma.<crmTable>.find*` call without `...tenantWhere(ctx)` fails (`scripts/lint-tenant-where.mjs`).
- Tenant deletion cascades CRM data; `audit_logs` has no FK and survives.

## 4. Policy

Tables `policy_rules` and `policy_bindings` as in nessie (`docs/schema-engine.md` §2.10).

```
PolicyScope        organization | team | object_type | record | list
PolicyResourceType schema | object_type | attribute | record | link | list | view | merge | export | webhook | approval
PolicyAction       view | create | edit | delete | link | merge | export | define | admin
PolicyEffect       allow | deny
actorType          human | agent | role        (role ∈ owner | admin | member — from UOA team role claim `role` if present, else member)
```

`checkPolicy(ctx, resourceType, action, scopeChain)`:
1. Collect rules for the tenant where `(resourceType, action)` match and `scope/scopeId` is in the chain `[record?, object_type?, team, organization]`.
2. Bindings matching the actor: `agent:<agentId>`, `human:<uoaUserId>`, `role:<role>`.
3. Order by `priority` desc; first matching rule's effect wins **except** any matching `deny` at equal-or-higher priority wins (deny-overrides).
4. No matching rule ⇒ the **default table** below.

Defaults seeded per team on first resolve (as rows, so they are editable):

| resource.action | member | admin/owner |
|---|---|---|
| record.view/create/edit/link | allow | allow |
| record.delete | deny | allow |
| schema.define, object_type.*, attribute.*, relation_type.* | deny | allow |
| merge.merge | deny (approval) | allow |
| export.export | deny (approval) | allow |
| webhook.admin | deny | allow |
| attribute.view where sensitivity=restricted | deny | allow |
| attribute.edit where sensitivity=confidential | deny | allow |

"deny (approval)" means the tool returns MRTR `input_required` with an approval token instead of a hard denial; an `approval_requests` row is created; re-issuing the call with `inputResponses.approval = { token, approved: true, approverUoaUserId }` from a principal whose role is admin/owner completes it (see `mcp-surface.md` §0.4).

## 5. Attribute sensitivity

`attributes.sensitivity ∈ public | internal | confidential | restricted`. Read path: after policy, `redactForActor(record, schema, ctx)` removes attributes the actor may not view and returns `redacted_attributes: [slug…]`. Search documents exclude `confidential` and `restricted` values. Change-feed rows for restricted attributes carry no values (`old_value`/`new_value` omitted) unless the reader may view them.

## 6. Audit

`audit_logs` — nessie's hash-chained table, verbatim: `actor_type, actor_id, action, resource_type, resource_id, outcome, reason, metadata, request_id, ip_address, user_agent, prev_hash, entry_hash`. Written by `writeAudit(tx, …)` inside the same transaction as the mutation; `entry_hash = sha256(prev_hash ∥ canonical JSON of the row)` per organisation. `scripts/verify-audit-chain.mjs` recomputes the chain.
