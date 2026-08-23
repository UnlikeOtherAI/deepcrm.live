# Phase 3 — MCP skeleton

Outcome: `/mcp` answers MCP 2026-07-28 clients, authenticates per `docs/auth-and-tenancy.md`, and exposes the schema, record and link tools with a harness that pins the surface to the docs.

### T19 — Inbound auth package

**Depends on:** T18. **Spec:** `docs/auth-and-tenancy.md` §1–§2.

**Files (create) in `packages/mcp-inbound/src/`:**
- `headers.ts` — `readInboundHeaders(headers: Record<string, unknown>): InboundHeaders` (case-insensitive; bearer extraction).
- `app-key.ts` — `parseAppKeys(env: string): Map<sha256hex, name>`; `verifyAppKey(keys, bearer)` timing-safe on sha256 of the bearer.
- `uoa-delegation.ts` — `verifyUoaDelegation(jwt, { jwks, issuer, audience, now })` via `jose.jwtVerify` → `{ sub, org, team, tv, scope }`; requires `scope` to include `ai.invoke`.
- `nessie-context.ts` — `verifyNessieContext(jwt, { jwks, now })` → provenance; enforces `exp - iat ≤ 300`, clock tolerance 30 s.
- `authenticate.ts` — `authenticate(headers, opts): Promise<{ ok: true; principal } | { ok: false; reason }>`; `sub` mismatch between delegation and context ⇒ fail; `REQUIRE_AUTH=false` ⇒ `devPrincipal()` regardless of headers.
- Tests with a generated RSA key pair (`jose.generateKeyPair`) and a local JWKS resolver: happy path; expired; wrong audience; sub mismatch; missing bearer; dev mode.

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/mcp-inbound` green.

---

### T20 — `/mcp` transport plugin and OAuth metadata route

**Depends on:** T19. **Spec:** `docs/mcp-surface.md` §0.1; `docs/auth-and-tenancy.md` §1; deepsignal `api/src/mcp-http.ts` (pattern).

**Files:**
- Create `api/src/routes/oauth-metadata.ts` — `GET /.well-known/oauth-protected-resource` → `{ resource: DEEPCRM_API_PUBLIC_URL, authorization_servers: [UOA_ISSUER], bearer_methods_supported: ['header'] }`.
- Create `api/src/mcp/server.ts` — `buildMcpServer(ctx: ActorContext, deps: AppDeps): McpServer` with `new McpServer({ name: 'deepcrm', version })`; registers tool groups (empty until T22+) via `registerSchemaTools(server, ctx, deps)` etc.
- Create `api/src/plugins/mcp-http.ts` — Fastify route `POST /mcp`: `authenticate` → 401 with `WWW-Authenticate` on failure; `resolveTenant` + `buildActorContext`; `const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` (stateless); `await server.connect(transport)`; `await transport.handleRequest(req.raw, reply.raw, req.body)`; `reply.hijack()`. `GET`/`DELETE /mcp` ⇒ 405. Add `_meta` cache hints to list results through a `server.server.setRequestHandler` wrapper or the SDK's list options — whichever the SDK 1.30 API offers; document the choice in a comment.
- Edit `api/src/app.ts` — register both.
- Create `api/test/mcp/harness.ts` — `startTestServer(opts)` returns `{ client: Client, close }` using `StreamableHTTPClientTransport(new URL('http://127.0.0.1:<port>/mcp'), { requestInit: { headers } })`.
- Create `api/test/mcp/transport.test.ts` — dev mode: `client.listTools()` returns `[]`; with `REQUIRE_AUTH=true` and no headers: HTTP 401 and `WWW-Authenticate` present.

**Acceptance:** `pnpm exec turbo run test --filter=@deepcrm/api` green; `curl -s http://localhost:5656/.well-known/oauth-protected-resource` (dev server) prints JSON with `resource`.

---

### T21 — Tool error mapping and result helpers

**Depends on:** T20. **Spec:** `docs/mcp-surface.md` §0.2–§0.4; `docs/spec/contracts.md` (`errors.ts`, `mrtr.ts` — copy verbatim).

**Files:**
- Create `api/src/mcp/tools/result.ts` — `ok(structured, summary: string)` → `{ content: [{ type:'text', text: summary }], structuredContent }`; `toolError(err)` → `{ isError: true, content: [{type:'text', text: code+': '+message}], structuredContent: { code, message, ...details } }` mapping `ServiceError`; unknown errors ⇒ `INTERNAL` (logged with requestId, message not leaked).
- Create `api/src/mcp/tools/input-required.ts` — `inputRequired(requests: InputRequest[])` building the MRTR result shape from §0.4; `readInputResponses(extra)` reading `inputResponses` from the call's params/`_meta` per SDK 1.30 (document where the SDK exposes it).
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
- Create `api/test/mcp/schema.test.ts` — via harness: `crm_template_apply standard_crm` → `crm_schema_get` lists person/company/deal; `crm_object_type_define subscription` with a `record_reference` to company; `crm_attribute_archive` returns `input_required` first, succeeds with confirmation; `resources/read crm://schema` returns `schema_version`.

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

**Acceptance:** api tests green; `NOT_YET` contains exactly the tools from §5–§8 plus `crm_records_bulk_assert`.

---

### T26 — MCP docs generator

**Depends on:** T25. **Spec:** `AGENTS.md` Documentation; `docs/mcp-surface.md`.

**Files:**
- Create `api/src/mcp/catalog.ts` — `describeTools(): ToolDoc[]` building `buildMcpServer` with a dev context and a stub deps object, reading registered tools (name, description, JSON schema) — the SDK exposes them via `server.server` request handler for `tools/list`; call it in-process.
- Replace `scripts/generate-mcp-docs.mjs` — runs `tsx api/src/mcp/print-catalog.ts` (create; prints JSON), then rewrites only the tables in §2–§8 of `docs/mcp-surface.md` between markers `<!-- tools:start:<section> -->` / `<!-- tools:end -->` (add those markers to the doc now, around each table). Columns: Tool, Description, Input (JSON schema property list `name: type`), Output (kept from the existing table cell — the generator preserves the 4th column by tool name).
- CI: add `pnpm docs:mcp && git diff --exit-code docs/mcp-surface.md` to the `lint` job.

**Acceptance:** `pnpm docs:mcp && git diff --exit-code docs/mcp-surface.md` exits 0 after committing the regenerated doc.
