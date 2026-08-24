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
◀── 200 { "result": { "resultType": "complete",
                      "content":[{"type":"text","text":"{\"record\":{\"id\":\"…\",…}}"}],
                      "structuredContent": { "record": { … } },
                      "_meta": { "io.modelcontextprotocol/serverInfo": { "name":"deepcrm", … } } } }
```
Failure: any header invalid ⇒ `401` + `WWW-Authenticate: Bearer resource_metadata="https://api.deepcrm.live/.well-known/oauth-protected-resource"`; no JSON-RPC body.

## F2 — Session start (schema discovery)

```
tools/list            ← top-level ttlMs: 300000, cacheScope: "private"; _meta["live.deepcrm/etag"] = server build
resources/read crm://schema   → SchemaSnapshot (object types, relations, rules, views); ttlMs + _meta etag = schema_version
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
case C  unique domain collision / block rule (block = DB-enforced match key, race-proof)
                          → isError { code:"DUPLICATE_FOUND", next:"fetch_and_retry", attribute:"domains",
                                record_id:"…", candidates:[…] }
```
Agent's follow-ups for C: `crm_record_assert` (update the existing), or `crm_merge_records` if two already exist.

## F4 — Sync-safe upsert (assert)

```
crm_record_assert { object_type:"person", match_attribute:"emails",
                    data:{ emails:["anna@asahi.eu"], name:{full:"Anna Novak"}, company:"<companyId>" },
                    idempotency_key:"gmail:msg:18f2…" }
→ { record, created:true }            first time
→ { record, created:false }           later sync, same email: patch applied, version+1 (a no-op patch writes nothing and keeps the version)
→ same idempotency_key + same args    → identical stored result, no write
→ same key + different args           → isError IDEMPOTENCY_MISMATCH
```

## F5 — Confirmation (MRTR) on a destructive schema change

```
tools/call crm_attribute_archive { object_type:"person", attribute:"fax" }
← { "resultType":"input_required",
    "inputRequests": { "confirm": { "method":"elicitation/create", "params": {
        "mode":"form",
        "message":"Archiving 'fax' hides 12 existing values (kept in history). Proceed?",
        "requestedSchema": { "type":"object", "properties": { "confirmed": {"type":"boolean"} },
                             "required":["confirmed"] } } } },
    "requestState": "<AEAD: principal + tool + args-hash + impact + TTL>" }

tools/call, params: { name:"crm_attribute_archive",
                      arguments:{ object_type:"person", attribute:"fax" },
                      inputResponses:{ confirm:{ action:"accept", content:{ confirmed:true } } },
                      requestState:"<echoed verbatim>" }
← { resultType:"complete", … { archived:true, records_with_values:12 } }   + schema.changed event

requestState is what binds the confirmation to THESE arguments and THIS principal: a stale or
re-targeted state fails verification and the server simply re-issues the elicitation.
```

## F6 — Approval (MRTR + human in Nessie)

```
agent (member) → tools/call crm_merge_records { survivor_id:A, merged_ids:[B], reason:"same person, two emails" }
← { resultType:"input_required",
    inputRequests: { approval: { method:"elicitation/create", params: {
        mode:"form",
        message:"Approve merging 'Anna Novak' (B) into 'Anna Nováková' (A)? Requires admin.",
        requestedSchema:{ type:"object", properties:{ approved:{type:"boolean"}, note:{type:"string"} },
                          required:["approved"] } } } },
    requestState:"<AEAD: principal + tool + args-hash + approvalId + TTL 24h>" }
    (server: approval_requests row pending — argumentsSnapshot + canonical arguments_hash stored)

agent → surfaces the question in the Nessie channel; an admin decides
retry (delegation now the ADMIN's — role claim admin/owner; X-Nessie-Context sub matches the admin):
  tools/call, params: { name:"crm_merge_records", arguments:{ …same… },
                        inputResponses:{ approval:{ action:"accept", content:{ approved:true } } },
                        requestState:"<echoed>" }
← { resultType:"complete", … { record:A, merge_change_id:"…", repointed_links:3, ended_links:[] } }

server on the retry: verify requestState (AEAD, TTL, args hash) → consume the approval row
  atomically in the mutation's transaction (pending→consumed, tenant + tool + hash + role checked;
  approver's uoaUserId must differ from the requester's on_behalf_of) → EXECUTE FROM THE STORED
  argumentsSnapshot, not the retry body. The write's actor stays agent:<id>; on_behalf_of records
  the approving admin for this one write.

rejections: approved:false ⇒ row rejected; isError POLICY_DENIED { next:"fatal", detail:"approval rejected" }
            args changed    ⇒ requestState verification fails; a fresh input_required is issued
            member retries  ⇒ APPROVAL_REQUIRED { next:"retry_with_approval", detail:"approver must be admin or owner" }
            second consume  ⇒ zero-row UPDATE ⇒ APPROVAL_REQUIRED (single-use, review C8)
```

## F7 — Long-running work (Tasks extension)

```
crm_records_bulk_assert { object_type:"person", match_attribute:"emails", rows:[…2,000…] }
← { task:{ taskId:"job_…", status:"working", ttl:604800000, createdAt:"…",
           lastUpdatedAt:"…", pollInterval:1000 } }  — SDK CreateTaskResult
tasks/get { taskId:"job_…" }  → full Task with statusMessage:"Processed 600 of 2000 rows"
tasks/get                     → full Task with status:"completed"; another tenant answers NOT_FOUND
tasks/result { taskId }       → original tools/call result with structuredContent:
  { created:1800, updated:190, failed:[{index:77,code:"VALIDATION_FAILED",message:"invalid row"}] }
tasks/cancel { taskId }       → full cancelled Task; running work stops at the next batch boundary
tasks/update                  → JSON-RPC −32601
```

## F8 — Reacting to changes (scheduled agent)

```
trigger fires (Nessie schedule, state.cursor = "1040"; the very first run called with no cursor
and stored the fresh "now" cursor the tool returned)
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
  pg_advisory_xact_lock(namespace 3, hashtext(externalTeamId))          [serialises double first-contact]
  INSERT organizations (external_org_id) ON CONFLICT DO NOTHING [if absent]
  INSERT teams (external_team_id, schema_version 0) — pairing check: an existing team row under a
    different organization ⇒ 401 TENANT_MISMATCH
  seedDefaultPolicies(team)                         (docs/spec/policy-defaults.json)
  applyTemplate(team, "system")                    (activity, note, task)
  audit: tenant.provisioned
→ the original tool call proceeds. `standard_crm` is NOT auto-applied; the agent calls crm_template_apply.
```

## F11 — Webhook delivery

See `events.md` §3. Sequence: write commits → `enqueue change.deliver (visible +30 s)` → worker locks webhook → selects `seq > last_delivered_seq` → POST with signature → 2xx advances cursor → else backoff.
