# Phase 10 — Form and chat submissions, proposals, and contact points

Outcome: a Nessie contact form, newsletter signup or website chat submission is written as the data subject's own act, named after the form or widget it came through, paired with an existing person only on a structural 100% match, and never replaces what a person stored; what it may not decide alone waits as a proposal a person decides. Every email and phone carries its own provenance, confirmation, reached state and archive. Contract source: the owner's decisions relayed for the "named source" task (2026-10-19). Runs after Phase 9.

### T70 — Intake, sources and proposals

**Depends on:** T69. **Spec:** `docs/schema-engine.md` §4d″; `docs/auth-and-tenancy.md` §1 (the third subject tool); `docs/spec/nessie-integration.md` §9; `docs/spec/contracts.md` (`SourceRef`, `CrmIntakeSubmit`, `CrmProposalsList`, `CrmProposalDecide`, `CrmRecordCreate.source`).

**Files:** `docs/spec/templates/standard_crm.json` and `system.json` (and their copies) — `first_source_*` on `person`, `source_*` on `activity`; `packages/schema-engine/src/schema/system-attributes.ts`, `source-attributes.ts`, `compliance/consent.ts`, `compliance/erase.ts`; `packages/db/prisma/migrations/20261019120000_record_proposals`; `packages/schemas/src/source-ref.ts`, `tools-intake.ts`, `tools-records.ts`; `api/src/services/intake*.ts`, `proposal*.ts`, `consent-act.ts`, `record-source.ts`, `principals.ts`; `api/src/mcp/tools/intake.ts`.

**Ops:** add `crm_intake_submit` to the `nessie` entry's `subjectTools` in `DEEPCRM_APPS` and restart the API; the deploy's `prisma migrate deploy` creates `record_proposals`.

**Acceptance:** `pnpm --filter @deepcrm/api exec vitest run test/db/intake.test.ts test/db/proposals.test.ts test/mcp/intake-subject.test.ts test/mcp/surface.test.ts test/db/consent.test.ts --no-file-parallelism` and `pnpm --filter @deepcrm/schema-engine exec vitest run test/system-attributes.test.ts test/db/templates.test.ts` exit 0 with `DATABASE_URL` exported.

### T71 — Contact points

**Depends on:** T70. **Spec:** `docs/schema-engine.md` §4d‴; `docs/spec/nessie-integration.md` §9 (Records page); `docs/spec/contracts.md` (`CrmContactPointsGet`, `CrmContactPointSet`).

**Files:** `packages/db/prisma/migrations/20261019130000_record_contact_points`; `packages/schema-engine/src/contact-points/`; `packages/schemas/src/tools-contact-points.ts`; `api/src/services/contact-points.ts`, `contact-point-sync.ts`, `records.ts` (the write path keeps contact points in step), `intake-write.ts` (archived values match, never pair alone, never come back); `api/src/mcp/tools/contact-points.ts`.

**Ops:** none beyond the migration.

**Acceptance:** with `DATABASE_URL` exported:

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm docs:mcp && git diff --exit-code docs/mcp-surface.md
```

Every command exits 0.
