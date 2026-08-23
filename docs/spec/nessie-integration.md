# Nessie integration protocol

How a Nessie deployment connects its agents to DeepCRM. Written from DeepCRM's side; the Nessie-side plan (T46) restates it in Nessie vocabulary. Precedents: Nessie's DeepWater (team-scoped tool projection, explicit grants) and DeepSignal (app key + delegation + provenance, product webhook → digest).

## 1. Identity & credentials (three proofs, as DeepSignal)

| Proof | Issued by | Carried as | DeepCRM checks |
|---|---|---|---|
| Product app key `dck_…` | DeepCRM operator (`scripts/generate-app-key.mjs nessie`) | `Authorization: Bearer` | SHA-256 in the `DEEPCRM_APPS` registry; names the calling product |
| UOA delegation | UOA **confidential assertion exchange** (guide §4.6a): Nessie signs a ≤60 s subject assertion with its config key (`sub` = the user, `active` = the workspace) and exchanges it under its own domain-hash credential and the superuser-created `(api.nessie.works, nessie)` → `https://api.deepcrm.live` mapping | `X-UOA-Delegation` | RS256 via UOA `/oauth/jwks.json`; `iss`, exact `aud`, `exp ≤ 300 s`, `sub`, `org`, `active`, `source_domain`/`product` = nessie, `scope ∋ ai.invoke`. Contract: [uoa-integration.md](uoa-integration.md) §3 |
| App context | Nessie's RS256 signer, **registered per app** in DeepCRM's `DEEPCRM_APPS` registry (`X-Nessie-Context` is the accepted alias of `X-App-Context` for the `nessie` app) | `X-Nessie-Context` | signature via the app's registered JWKS + issuer, `aud` = DeepCRM, ttl ≤ 300 s, `sub` equals delegation `sub`. Chained callers (a product calling through another) are preserved via the delegation's `act` chain — every hop stays attributable (auth-and-tenancy §1). |

Nessie stores the app key as deployment env `DEEPCRM_MCP_APP_KEY` (never per user), pinned to the canonical catalog entry whose URL is exactly `https://api.deepcrm.live/mcp`. DeepCRM never receives Nessie's UOA refresh credentials; the delegation token is short-lived (300 s) and resource-bound, and UOA re-reads live membership at every exchange — a removed member stops minting immediately. Users never log into DeepCRM; the ids arrive in the token.

## 2. Enablement

1. Owner toggles **DeepCRM** for a team in Nessie Integrations.
2. Nessie provisions a **team-scoped, tool-projecting** `McpServerInstance` from the `deep-crm` catalog entry, probes `tools/list` with a delegation for the enabling owner, and projects every tool as `mcp_crm_<name-without-prefix>` (e.g. `crm_record_assert` → `mcp_crm_record_assert`).
3. DeepCRM provisions the tenant on that first call (flow F10) — no separate "create workspace" API.
4. Disable: Nessie removes the instance; DeepCRM data stays (the tenant persists; re-enable reconnects). Deleting a UOA team ⇒ UOA-driven cleanup (out of scope for v1; tracked as an open question).

## 3. Grants (what agents see by default)

| Tools | Default for team agents | Rationale |
|---|---|---|
| all read tools, `crm_record_create/update/assert`, `crm_link*`, `crm_activity_log`, `crm_note_add`, `crm_task_*`, `crm_list_*`, `crm_view_*`, `crm_search`, `crm_changes_since`, `crm_pipeline_summary`, `crm_data_quality`, `crm_find_duplicates`, `crm_suppression_add/check/list` | **ON** | cheap, unmetered, reversible, policy-checked server-side |
| `crm_merge_records`, `crm_unmerge`, `crm_record_delete`, `crm_record_erase`, `crm_suppression_remove`, `crm_origin_guard_set`, `crm_export`, all schema `define`/archive tools, `crm_matching_rule_set`, `crm_template_apply`, `crm_webhook_*` | `requiresExplicitGrant` — OFF until an owner grants per agent | destructive or structural; DeepCRM additionally enforces policy/approval, so the grant is defence in depth, not the only gate |

Nessie's "tool that takes an id ships with the read that resolves it" rule holds: every granted mutator has its read in the default-ON set.

## 4. Approvals (MRTR ↔ Nessie)

When DeepCRM returns `resultType: "input_required"` with an approval elicitation + `requestState` (spec MRTR — mcp-surface §0.4, flow F6):
1. The Nessie worker surfaces the elicitation to the model as the tool result (a normal result, not an error) and preserves `requestState` in run state.
2. The agent asks in-channel; Nessie's existing `ApprovalRequest` may mirror it (`action = "deepcrm:<tool>"`) so the admin can click Approve.
3. On approval, Nessie re-issues the **same** `tools/call` with `inputResponses` (the `ElicitResult` with `{ approved: true }`) and the **echoed `requestState`**, under a delegation for the **approving admin** (a different human than the requester) — DeepCRM verifies the state, checks the approver's `role` claim exactly, and executes from the stored arguments snapshot.
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
