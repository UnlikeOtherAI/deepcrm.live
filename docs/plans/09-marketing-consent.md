# Phase 9 — Marketing consent and the data subject's own act

Outcome: marketing consent is a state of the person — three system attributes on the person-kind type, `declined` mirrored as an opt-out suppression — read and written through `crm_consent_get` / `crm_consent_set`, by a colleague as themselves, by an agent (decline only), and by the data subject's own act through a subject-attested call that needs no signed-in person. Contract source: the Nessie plan `docs/plans/2026-10-16-newsletter-signup-forms.md`, "Revision 2 — DeepCRM Tranche D". Runs after Phase 8.

### T69 — Marketing consent

**Depends on:** T53, T67. **Spec:** `docs/schema-engine.md` §4d′; `docs/auth-and-tenancy.md` §1–§3 (subject-attested calls, nullable `onBehalfOf`, existing-tenant resolution); `docs/spec/nessie-integration.md` §8; `docs/spec/contracts.md` (`CrmConsentSet`, `CrmConsentGet`, `TENANT_NOT_FOUND`).

**Files:**
- `docs/spec/templates/standard_crm.json` (and its copy in `packages/schema-engine/src/templates/`) — `marketing_consent`, `marketing_consent_at`, `marketing_consent_source` on `person`.
- `packages/schema-engine/src/compliance/consent.ts` — `ensureConsentAttributes` (missing attributes from the template, one version bump, one audit).
- `packages/schemas/src/tools-consent.ts`; `packages/schemas/src/context.ts` — `Principal` = delegated | subject, `ActorContext.onBehalfOf` nullable, `requireOnBehalfOf`/`onBehalfOfUserId`/`isSubjectActor`; `errors.ts` — `TENANT_NOT_FOUND`.
- `packages/mcp-inbound` — `subjectTools` registry field (default `[]`), `actor: "subject"` context claims, subject authentication and refusals `subject_not_allowed`, `subject_tool_mismatch`, `ambiguous_context`.
- `api/src/services/consent*.ts`, `api/src/mcp/tools/consent.ts`; `api/src/plugins/mcp-http.ts` + `mcp-refusal.ts` (subject flow, typed tenant refusals); `api/src/services/tenancy.ts` (existing-tenant lookup), `context.ts`, `principals.ts` (replay seen-set for `crm_consent_set`); `api/src/mcp/server.ts` + `tools/register.ts` (a subject server runs only its attested tool); every `onBehalfOf` consumer.
- Tests: `packages/mcp-inbound/src/subject-context.test.ts`; `api/test/db/consent.test.ts`; `api/test/mcp/consent.test.ts`; `api/test/mcp/consent-subject.test.ts`; `api/test/mcp/surface.test.ts` (77 tools, compliance 8).

**Ops:** add `"subjectTools": ["crm_consent_set", "crm_consent_get"]` to the `nessie` entry of `DEEPCRM_APPS` and restart the API. No migration.

**Acceptance:** with `DATABASE_URL` exported (docs/testing.md):

```bash
pnpm lint
pnpm typecheck
pnpm --filter @deepcrm/mcp-inbound exec vitest run src/subject-context.test.ts src/authenticate.test.ts
pnpm --filter @deepcrm/api exec vitest run test/db/consent.test.ts test/mcp/consent.test.ts test/mcp/consent-subject.test.ts test/mcp/surface.test.ts --no-file-parallelism
pnpm --filter @deepcrm/schema-engine exec vitest run test/db/templates.test.ts test/db/records-write.test.ts --testTimeout=60000
pnpm docs:mcp && git diff --exit-code docs/mcp-surface.md
```

Every command exits 0.
