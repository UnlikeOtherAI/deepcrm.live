# Nessie integration protocol

How a Nessie deployment connects its agents to DeepCRM. Written from DeepCRM's side; the Nessie-side plan (T46) restates it in Nessie vocabulary. Precedents: Nessie's DeepWater (team-scoped tool projection, explicit grants) and DeepSignal (app key + delegation + provenance, product webhook → digest).

## 1. Identity & credentials (three proofs, as DeepSignal)

| Proof | Issued by | Carried as | DeepCRM checks |
|---|---|---|---|
| Product app key `dck_…` | DeepCRM operator (`scripts/generate-app-key.mjs nessie`) | `Authorization: Bearer` | SHA-256 in the `DEEPCRM_APPS` registry; names the calling product |
| UOA delegation | UOA **confidential assertion exchange** (guide §4.6a): Nessie signs a ≤60 s subject assertion with its config key (`sub` = the user, `active` = the workspace) and exchanges it under its own domain-hash credential and the superuser-created `(api.nessie.works, nessie)` → `https://api.deepcrm.live` mapping | `X-UOA-Delegation` | RS256 via UOA `/oauth/jwks.json`; `iss`, exact `aud`, `exp ≤ 300 s`, `sub`, `org`, `active`, `source_domain`/`product` = nessie, `scope ∋ ai.invoke`. Contract: [uoa-integration.md](uoa-integration.md) §3 |
| App context | Nessie's RS256 signer, **registered per app** in DeepCRM's `DEEPCRM_APPS` registry (`X-Nessie-Context` is the accepted alias of `X-App-Context` for the `nessie` app) | `X-Nessie-Context` | signature via the app's registered JWKS + issuer, `aud` = DeepCRM, ttl ≤ 300 s, `sub` equals delegation `sub`. An agent call names `agentId`/`runId`/`toolCallId`; a person using Nessie's own screens (Clients' customer directory) is attested with `actor: "human"` and no agent claims, and acts with exactly that human's rights. Every tool call's context is bound to the delegation `jti`, the tool name and the canonical-JSON `args_sha256`. Chained callers (a product calling through another) are preserved via the delegation's `act` chain — every hop stays attributable (auth-and-tenancy §1). |

Nessie stores the app key as deployment env `DEEPCRM_MCP_APP_KEY` (never per user), pinned to the canonical catalog entry whose URL is exactly `https://api.deepcrm.live/mcp`. DeepCRM never receives Nessie's UOA refresh credentials; the delegation token is short-lived (300 s) and resource-bound, and UOA re-reads live membership at every exchange — a removed member stops minting immediately. Users never log into DeepCRM; the ids arrive in the token.

## 2. Enablement

1. Owner toggles **DeepCRM** for a team in Nessie Integrations.
2. Nessie provisions a **team-scoped, tool-projecting** `McpServerInstance` from the `deep-crm` catalog entry, probes `tools/list` as the person who chose DeepCRM as the team's CRM, and projects every tool as `mcp_crm_<name-without-prefix>` (e.g. `crm_record_assert` → `mcp_crm_record_assert`) with the group and access class it carries (§3). Nessie re-reads the list as that person on a schedule; an unchanged `_meta["live.deepcrm/etag"]` (the server build) means nothing changed.
3. DeepCRM provisions the tenant on that first call (flow F10) — no separate "create workspace" API.
4. Disable: Nessie removes the instance; DeepCRM data stays (the tenant persists; re-enable reconnects). Deleting a UOA team ⇒ UOA-driven cleanup (out of scope for v1; tracked as an open question).

## 3. Grants (what agents see by default)

Every tool carries its group and access class in `_meta`; the registration is the list, Nessie stores what the wire says, and a tool without a class is explicit on Nessie's side.

- `_meta["live.deepcrm/group"]` = `{ id, label, order }` — one of the eight groups of `mcp-surface.md` §10 (`schema`, `records`, `links`, `lists-views`, `activity`, `search-quality`, `compliance`, `io`). Ids are stable; Nessie orders groups by `order` and labels them by `label`.
- `_meta["live.deepcrm/access"]` = `standard` (**ON** by default for team agents: reads, record create/update/assert/restore, links, activities, notes, tasks, lists, views, pipeline stage moves, event ingest, file registration, search, quality reads, suppression add/check/list, change feed, webhook list) or `explicit` (`requiresExplicitGrant` — **OFF** until an owner grants it per agent: merge and unmerge, record delete and erase, suppression removal, `crm_write_guard_set`, export, webhook set/delete, every schema-group tool except `crm_schema_get` and `crm_derived_refresh_status`, and the structural `crm_pipeline_define`, `crm_pipeline_update`, `crm_event_type_define`).

Every tool also carries `Tool.title`, a unique sentence-case action of at most 40 characters ("Create record", "Query records", "Read workspace model"); Nessie shows it to people ("Using DeepCRM: Create record") and keeps the tool name for the model.

`mcp-surface.md` §10 lists the explicit set and the per-group counts, regenerated from the registrations. The class is defence in depth: DeepCRM still enforces policy and approval on every call. Every granted mutator's resolving read is standard — `crm_schema_get`, `crm_record_get`, `crm_records_query`, `crm_links_list`, `crm_list_entries`, `crm_view_run`, `crm_tasks_list`, `crm_suppression_list`, `crm_webhook_list`, `crm_file_list`, `crm_pipeline_stages_list`, `crm_derived_refresh_status` — so Nessie's "tool that takes an id ships with the read that resolves it" rule holds, and `api/test/mcp/surface.test.ts` pins it.

**What a Nessie agent may do.** Every team is seeded with an `agent:nessie:*` allow for every policy pair the code requests (`policy-defaults.json`, auth-and-tenancy §4), and an agent is evaluated against both that wildcard and the human it acts for, with the human's own no-rule fallback. A Nessie agent may therefore do exactly what the person it acts for may do — the person's role rules (member deny-with-approval on delete, merge, export and schema; owner-only erase and suppression removal; attribute sensitivity) are the whole gate — and which tools the agent holds at all is Nessie's grant. A per-agent `agent:nessie:<agentId>` deny still beats the wildcard.

## 4. Approvals (MRTR ↔ Nessie)

When DeepCRM returns `resultType: "input_required"` with an approval elicitation + `requestState` (spec MRTR — mcp-surface §0.4, flow F6):

The approval elicitation's `params._meta["live.deepcrm/required_role"]` names the least role that may answer it — `owner` for `crm_record_erase` and `crm_suppression_remove`, `admin` otherwise (an owner satisfies admin) — so Nessie offers the decision only to people DeepCRM will accept it from, rather than parsing the message text.
1. The Nessie worker surfaces the elicitation to the model as the tool result (a normal result, not an error) and preserves `requestState` in run state.
2. The agent asks in-channel; Nessie's existing `ApprovalRequest` may mirror it (`action = "deepcrm:<tool>"`) so the admin can click Approve.
3. On approval, Nessie re-issues the **same** `tools/call` with `inputResponses` (the `ElicitResult` with `{ approved: true }`) and the **echoed `requestState`**, under a delegation for the **approving admin** (a different human than the requester) — DeepCRM verifies the state, checks that the approver's `role` satisfies the required role (an owner satisfies `admin`; an admin never satisfies `owner`), and executes from the stored arguments snapshot. The continuation may arrive through a `nessie` **agent** context whose `sub` is the approving admin: the approver is the context's human, and the write's actor stays the agent.
4. Expired approvals (24 h) require a fresh call; DeepCRM keeps the `approval_requests` row for audit.

## 5. Events into Nessie

- Nessie registers one webhook per enabled team via `crm_webhook_set` (run by Nessie's integration code under an owner delegation), URL `https://api.nessie.works/api/integrations/deepcrm/events`, secret stored encrypted per org in Nessie (`PUT /api/integrations/products/deepcrm/webhook-secret`, as for DeepSignal).
- Envelope: `events.md` §3 (`deepcrm.webhook.v1`). Nessie verifies timestamp + HMAC, dedupes on `seq`, and renders a **rolling digest** message in the team's DeepCRM-bound channel (`"7 CRM changes · 3 deals moved · 2 people added"`, updated in place within a window), never one message per event.
- Agent automation uses `crm_changes_since` on a schedule with the cursor persisted in trigger state (flow F8).

## 6. Prompts

Nessie may surface DeepCRM prompts (`crm/qualify-lead`, …) as agent skills; they reference `mcp_crm_*` names after projection. Nessie's projector rewrites the `crm_` prefix in prompt text to the projected names at install time.

## 7. Failure modes

| Situation | DeepCRM | Nessie |
|---|---|---|
| App key rotated | 401 | instance health `unauthorized`; owner re-enters key |
| Delegation for a user no longer in the team | 401 (UOA refuses exchange; or DeepCRM `aud`/`team` mismatch) | run fails closed; no fallback identity |
| DeepCRM down | — | tool error surfaced to the model; retries are the model's choice, never silent |
| Policy deny | `POLICY_DENIED { resource, action }` | agent says who can do it (nessie's "refuse in words" convention) |
| Schema drift mid-run | `UNKNOWN_ATTRIBUTE` / `SCHEMA_CONFLICT` | agent re-reads `crm://schema` and retries once |
