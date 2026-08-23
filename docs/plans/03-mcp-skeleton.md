# Phase 3 — MCP skeleton

Outcome: `/mcp` answers MCP 2026-07-28 clients, authenticates per `docs/auth-and-tenancy.md`, and exposes the schema, record and link tools with a harness that pins the surface to the docs.

### T19 — Inbound auth package

**Depends on:** T18. **Spec:** `docs/auth-and-tenancy.md` §1–§2.

**Files (create) in `packages/mcp-inbound/src/`:**
- `headers.ts` — `readInboundHeaders(headers: Record<string, unknown>): InboundHeaders` (case-insensitive; bearer extraction).
- `app-key.ts` — `parseAppKeys(env: string): Map<sha256hex, name>`; `verifyAppKey(keys, bearer)` timing-safe on sha256 of the bearer.
- `uoa-delegation.ts` — `verifyUoaDelegation(jwt, { jwksUrl: `${UOA_BASE_URL}/oauth/jwks.json`, issuer, audience, now })` via `jose.jwtVerify` → `{ sub, org: { org_id, org_role, team_roles }, active: { orgId, teamId }, source_domain, azp, product, act, scope }` (claims zod-validated; `org` and `active` required, `active.orgId === org.org_id`); requires `scope` ∋ `ai.invoke`, `exp − iat ≤ 300 s`. `resolveRole(org, active)` per `docs/spec/uoa-integration.md` §3.2 (owner structural; exact admin/member; anything else ⇒ `null`, never member-floored).
- `nessie-context.ts` — `verifyNessieContext(jwt, { jwks, audience, issuer, now })` → provenance; enforces `aud`/`iss`, `exp - iat ≤ 300`, clock tolerance 30 s. `seen-set.ts` — in-process 300 s `requestId` single-use set consulted by destructive tools (auth §1).
- `authenticate.ts` — `authenticate(headers, opts)`; cross-checks: context `sub` = delegation `sub`, delegation `source_domain`/`product` = the app key's `DEEPCRM_APPS` entry; `act` chain copied into the principal; `REQUIRE_AUTH=false` ⇒ `devPrincipal()`. (The `DEEPCRM_DIRECT_CLIENTS` strategy — public-profile token, no app key — is a stub returning `unsupported` until Phase 7's T53.)
- Tests with a generated RSA key pair and a local JWKS resolver: happy path (org/active/roles resolved; act chain through); expired; wrong audience on either token; identity-only delegation (no `active`) rejected; `active.orgId` ≠ `org.org_id` rejected; product/app-key mismatch rejected; unknown role ⇒ `role: null`; sub mismatch; missing bearer; dev mode.

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/mcp-inbound` green.

---

### T20 — `/mcp` transport plugin and OAuth metadata route

**Depends on:** T19. **Spec:** `docs/mcp-surface.md` §0.1; `docs/auth-and-tenancy.md` §1; deepsignal `api/src/mcp-http.ts` (pattern).

**Files:**
- Create `api/src/routes/oauth-metadata.ts` — `GET /.well-known/oauth-protected-resource` → `{ resource, authorization_servers: [UOA_ISSUER], bearer_methods_supported: ['header'] }`; when `UOA_ISSUER` is unset (dev) the route answers 404 (documented in the file).
- Create `api/src/mcp/server.ts` — `buildMcpServer(ctx, deps): McpServer`; registers tool groups (empty until T22+) and implements `server/discover` (mcp-surface §0.1) plus `resultType: "complete"` on ordinary results and top-level `ttlMs`/`cacheScope: "private"` on list/read results (document in a comment where SDK 1.30 exposes each seam; a thin result-wrapper is acceptable).
- Create `api/src/plugins/mcp-http.ts` — Fastify route `POST /mcp`: `authenticate` → 401 with `WWW-Authenticate` on failure; `resolveTenant` + `buildActorContext`; `const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` (stateless); `await server.connect(transport)`; `await transport.handleRequest(req.raw, reply.raw, req.body)`; `reply.hijack()`. `GET`/`DELETE /mcp` ⇒ 405. Add `_meta` cache hints to list results through a `server.server.setRequestHandler` wrapper or the SDK's list options — whichever the SDK 1.30 API offers; document the choice in a comment.
- Edit `api/src/app.ts` — register both.
- Create `api/test/mcp/harness.ts` — `startTestServer(opts)` returns `{ client: Client, close }` using `StreamableHTTPClientTransport(new URL('http://127.0.0.1:<port>/mcp'), { requestInit: { headers } })`.
- Create `api/test/mcp/transport.test.ts` — dev mode: `client.listTools()` **succeeds and returns an array** (do not assert emptiness — later tasks add tools); `server/discover` answers; with `REQUIRE_AUTH=true` and no headers: HTTP 401 with `WWW-Authenticate`.

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/api` green; `curl -s http://localhost:5656/.well-known/oauth-protected-resource` (dev server) prints JSON with `resource`.

---

### T21 — Tool error mapping and result helpers

**Depends on:** T20. **Spec:** `docs/mcp-surface.md` §0.2–§0.4; `docs/spec/contracts.md` (`errors.ts`, `mrtr.ts` — copy verbatim).

**Files:**
- Create `api/src/mcp/tools/result.ts` — `ok(structured, summary: string)` → `{ content: [{ type:'text', text: summary }], structuredContent }`; `toolError(err)` → `{ isError: true, content: [{type:'text', text: code+': '+message}], structuredContent: { code, message, ...details } }` mapping `ServiceError`; unknown errors ⇒ `INTERNAL` (logged with requestId, message not leaked).
- Create `api/src/mcp/tools/input-required.ts` — `inputRequired(elicitations, requestStatePayload)` building the spec MRTR shape from §0.4 (elicitation map + AEAD `requestState`, keyring kid `mrtr`); `readMrtr(params)` unwrapping `inputResponses`/`requestState` from `tools/call` params before zod validation; `verifyRequestState(state, ctx, tool, argsHash)`.
- Create `api/src/mcp/tools/common-args.ts` — zod fragments `reason`, `idempotency_key`, `expected_version`, `cursor`, `limit` with `.describe()` text copied from §0.2.
- Create `api/src/mcp/tools/register.ts` — `defineTool(server, { name, description, input: zodShape, handler })` wrapper that: validates, calls handler, catches → `toolError`, records duration in logs by tool name.
- Unit tests for mapping.

**Acceptance:** api tests green.

---

### T22 — Schema tools

**Depends on:** T21. **Spec:** `docs/mcp-surface.md` §1, §2; `docs/spec/contracts.md` (`tools.ts` schema section — copy the Crm* pairs into `packages/schemas/src/tools.ts` as they land).

**Files:**
- Create `api/src/mcp/tools/schema.ts` — register the 11 schema tools with the exact names/descriptions/inputs from §2, calling `services/schema.ts` and `templates/apply.ts`. Archive tools: when values/records exist, return `inputRequired([{ id:'confirm', kind:'confirmation', message, schema }])` unless `inputResponses.confirm.confirmed === true`.
- Create `api/src/mcp/resources.ts` — `crm://schema`, `crm://schema/{object_type}` (resource template), `crm://templates`.
- Create `api/test/mcp/schema.test.ts` — via harness: `crm_template_apply standard_crm` → `crm_schema_get` lists person/company/deal; unknown template ⇒ `UNKNOWN_TEMPLATE {available}`; `crm_object_type_define subscription` with a `record_reference` to company; `crm_attribute_archive` returns spec-shaped `input_required` (elicitation + `requestState`), succeeds on the retry with `inputResponses` + echoed state, and a tampered state is re-challenged; `resources/read crm://schema` returns `schema_version` and `resources/templates/list` lists the two URI templates.

**Acceptance:** api tests green.

---

### T23 — Record tools

**Depends on:** T22. **Spec:** `docs/mcp-surface.md` §3; `docs/spec/contracts.md` (`records.ts`, `tools.ts` record section); flows F3/F4 in `docs/spec/protocol-flows.md` are the acceptance narrative.

**Files:**
- Create `api/src/mcp/tools/records.ts` — register `crm_record_create/update/assert/get/delete/restore/at/history`, `crm_records_query`. `crm_record_get` by `(object_type, match_attribute, value)` uses unique keys. `include_links` groups active links by relation slug with `RecordSummary`s.
- Create `api/test/mcp/records.test.ts` — full happy path through the client: create person with `links: [{relation_type:'person_works_at', to_record_id: companyId}]`; `DUPLICATE_FOUND` error shape on duplicate email; `expected_version` conflict; query with filter from schema-engine §5 example; `crm_record_at`.

**Acceptance:** api tests green.

---

### T24 — Link tools

**Depends on:** T23. **Spec:** `docs/mcp-surface.md` §4.

**Files:** create `api/src/mcp/tools/links.ts` (3 tools) + `api/test/mcp/links.test.ts` (link with edge `data.role`, list both directions, unlink keeps history with `include_history`).

**Acceptance:** api tests green.

---

### T25 — Surface pin test and tool description lint

**Depends on:** T24. **Spec:** `docs/mcp-surface.md` §10; `AGENTS.md` rule zero.

**Files:**
- Create `api/test/mcp/surface.test.ts` — parse `docs/mcp-surface.md` tables for `` `crm_*` `` names in §2–§8; assert `listTools()` names ⊆ documented and every documented tool that is **implemented so far** is present (maintain an explicit `NOT_YET: string[]` list in the test that shrinks as phases land — the list must be empty by T42).
- Add to `register.ts`: throw at registration if `description.length > 300` or any input field lacks `.describe()`.

**Acceptance:** api tests green; `NOT_YET` contains exactly the tools from §5–§8 plus `crm_records_bulk_assert`, `crm_records_count`, `crm_records_get_many` (the §3 additions land in T23's file but count/get_many ship with T31's query work — keep them in `NOT_YET` until then).

---

### T26 — MCP docs generator

**Depends on:** T25. **Spec:** `AGENTS.md` Documentation; `docs/mcp-surface.md`.

**Files:**
- Create `api/src/mcp/catalog.ts` — `describeTools(): ToolDoc[]` building `buildMcpServer` with a dev context and a stub deps object, reading registered tools (name, description, JSON schema) — the SDK exposes them via `server.server` request handler for `tools/list`; call it in-process.
- Replace `scripts/generate-mcp-docs.mjs` — runs `tsx api/src/mcp/print-catalog.ts` (create; prints JSON), then rewrites only the tables in §2–§8 of `docs/mcp-surface.md` between markers `<!-- tools:start:<section> -->` / `<!-- tools:end -->` (add those markers to the doc now, around each table). Columns: Tool, Description, Input (JSON schema property list `name: type`), Output (kept from the existing table cell — the generator preserves the 4th column by tool name).
- CI: add `pnpm docs:mcp && git diff --exit-code docs/mcp-surface.md` to the `lint` job.

**Acceptance:** `pnpm docs:mcp && git diff --exit-code docs/mcp-surface.md` exits 0 after committing the regenerated doc.
