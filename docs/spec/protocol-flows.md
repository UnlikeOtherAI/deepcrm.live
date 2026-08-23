# Protocol flows

Wire-level sequences for the interactions that define the product. JSON-RPC bodies are abbreviated to the parts that matter; every `tools/call` carries MCP 2026-07-28 `_meta` (`io.modelcontextprotocol/protocolVersion`, `clientCapabilities`) and the HTTP headers `Mcp-Method: tools/call`, `Mcp-Name: <tool>`.

## F1 — Authenticated call

```
Nessie worker ──POST /mcp──────────────────────────────────────────────▶ deepcrm-api
  Authorization: Bearer dck_…            (app key, SHA-256 matched to DEEPCRM_APP_KEYS)
  X-UOA-Delegation: eyJ…                 (RS256; sub/org/team/tv/scope)
  X-Nessie-Context: eyJ…                 (RS256; agentId/runId/toolCallId/requestId; ttl ≤ 300s)
  { "jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"crm_record_get","arguments":{"id":"…"}} }

deepcrm-api: authenticate → Principal
             resolveTenant(org, team) → (organization_id, team_id)   [upsert 1:1 mirrors]
             buildActorContext → actor = agent:<agentId>, onBehalfOf = sub
             buildMcpServer(ctx) → transport.handleRequest
             tool → service(ctx, args) → policy → engine → redact
◀── 200 { "result": { "content":[{"type":"text","text":"Anna Novak (person)"}],
                      "structuredContent": { "record": { … } } } }
```
Failure: any header invalid ⇒ `401` + `WWW-Authenticate: Bearer resource_metadata="https://api.deepcrm.live/.well-known/oauth-protected-resource"`; no JSON-RPC body.

## F2 — Session start (schema discovery)

```
tools/list            ← _meta cache { ttlMs: 300000, cacheScope: "tenant" }, etag = schema_version
resources/read crm://schema   → SchemaSnapshot (object types, relations, rules)
resources/read crm://schema/deal → ObjectTypeDetail (attributes with descriptions)
```
The agent caches both by `schema_version`; a `schema.changed` event or a `SCHEMA_CONFLICT`/`UNKNOWN_ATTRIBUTE` error is the cue to re-read.

## F3 — Create with duplicate detection

```
tools/call crm_record_create { object_type:"company", data:{ name:"Asahi Europe", domains:["asahi.eu"] } }

case A  no match          → { record, version:1 }                       + record.created event
case B  warn rule (fuzzy name 0.6 vs "Asahi Europe Ltd")
                          → { record, duplicates:[{ record:{id,…}, rule_position:1,
                                evidence:[{kind:"fuzzy",attribute:"name",score:0.71}] }] }
case C  unique domain collision / block rule
                          → isError { code:"DUPLICATE_FOUND", attribute:"domains", record_id:"…",
                                candidates:[…] }
```
Agent's follow-ups for C: `crm_record_assert` (update the existing), or `crm_merge_records` if two already exist.

## F4 — Sync-safe upsert (assert)

```
crm_record_assert { object_type:"person", match_attribute:"emails",
                    data:{ emails:["anna@asahi.eu"], name:{full:"Anna Novak"}, company:"<companyId>" },
                    idempotency_key:"gmail:msg:18f2…" }
→ { record, created:true }            first time
→ { record, created:false }           later sync, same email: patch applied, version+1 (no-op patch ⇒ no change rows)
→ same idempotency_key + same args    → identical stored result, no write
→ same key + different args           → isError IDEMPOTENCY_MISMATCH
```

## F5 — Confirmation (MRTR) on a destructive schema change

```
crm_attribute_archive { object_type:"person", attribute:"fax" }
← { "resultType":"input_required",
    "inputRequests":[{ "id":"confirm","kind":"confirmation",
       "message":"Archiving 'fax' hides 12 existing values (kept in history). Proceed?",
       "schema":{…confirmed:boolean…} }] }

crm_attribute_archive { object_type:"person", attribute:"fax" }  + inputResponses:{ confirm:{ confirmed:true } }
← { archived:true, records_with_values:12 }                      + schema.changed event
```

## F6 — Approval (MRTR + human in Nessie)

```
agent (member) → crm_merge_records { survivor_id:A, merged_ids:[B], reason:"same person, two emails" }
← input_required [{ id:"approval", kind:"approval", approval_token:"apr_…", expires_at:+24h,
     required_role:"admin", message:"Merge 'Anna Novak' (B) into 'Anna Nováková' (A)?" }]
     (server: approval_requests row pending, arguments_hash stored)

agent → posts the question in the Nessie channel; an admin replies "yes"
agent (same run or later, principal now carries the admin's delegation) →
  crm_merge_records { …identical args… } + inputResponses:{ approval:{ approval_token:"apr_…", approved:true } }
← { record:A, merge_change_id:"…", repointed_links:3 }           approval row → consumed; audit: approval.consumed

rejections: approved:false ⇒ row rejected, tool returns isError POLICY_DENIED { detail:"approval rejected" }
            different args  ⇒ APPROVAL_REQUIRED { detail:"arguments changed since approval" }
            member re-issues ⇒ APPROVAL_REQUIRED { detail:"approver must be admin or owner" }
```

## F7 — Long-running work (Tasks extension)

```
crm_records_bulk_assert { object_type:"person", match_attribute:"emails", rows:[…2,000…] }
← { task_id:"job_…" }
tasks/get { taskId:"job_…" }  → { status:"working", progress:{ done:600, total:2000 } }
tasks/get                     → { status:"completed", result:{ created:1800, updated:190, failed:[{index:77,code:"VALIDATION_FAILED",message:"emails[0]: invalid"}] } }
tasks/cancel                  → only while queued; running jobs finish their current batch then stop, status "cancelled"
```

## F8 — Reacting to changes (scheduled agent)

```
trigger fires (Nessie schedule, state.cursor = "1040")
crm_changes_since { cursor:"1040", object_types:["deal"], kinds:["set"] }
← { changes:[{ seq:"1041", kind:"set", attribute:"stage", old_value:"proposal", new_value:"negotiation", record:{…} }, …],
    next_cursor:"1077", has_more:false }
agent acts (e.g. crm_task_create "Draft contract" about the deal), stores next_cursor in trigger state
```

## F9 — Timeline read for a human question

```
"What's going on with Asahi?" →
crm_record_get { object_type:"company", match_attribute:"domains", value:"asahi.eu", include_links:true }
crm_record_timeline { id:<companyId>, hops:1, limit:30 }
← items: [ activity(call, about:[Anna, deal]), change(deal.stage proposal→negotiation), task(open "Draft contract"), … ]
```

## F10 — Tenant provisioning (first call from a new team)

```
authenticate ok, team unknown →
  INSERT organizations (external_org_id)  [if absent]
  INSERT teams (external_team_id, schema_version 0)
  seedDefaultPolicies(team)                         (docs/spec/policy-defaults.json)
  applyTemplate(team, "system")                    (activity, note, task)
  audit: tenant.provisioned
→ the original tool call proceeds. `standard_crm` is NOT auto-applied; the agent calls crm_template_apply.
```

## F11 — Webhook delivery

See `events.md` §3. Sequence: write commits → `enqueue change.deliver (visible +30 s)` → worker locks webhook → selects `seq > last_delivered_seq` → POST with signature → 2xx advances cursor → else backoff.
