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

### T72 — Intake follow-ups: members act on contact points; bounded proposal queues

**Depends on:** T71. **Spec:** `docs/schema-engine.md` §4d″ (Proposals, `crm_proposals_list`, `crm_proposal_decide`) and §4d‴ (who may act on a contact point); `docs/auth-and-tenancy.md` §4 (`contact_point.edit`); `docs/spec/policy-defaults.json`; `docs/spec/nessie-integration.md` §9; `docs/spec/contracts.md` (`ProposalItem`, `CrmProposalsList`, `CrmProposalDecide`). Contract source: the owner's decisions on PR #5 (2026-10-19) — any team member may replace and restore contact points; a flood of public submissions must never block a person's real changes.

**Files:** `packages/db/prisma/schema.prisma` (`PolicyResourceType.contact_point`, `ProposalStatus`, the `record_proposals` queue columns); `packages/db/prisma/migrations/20261019150000_contact_point_policy_resource`, `20261019150100_contact_point_policy_rules`, `20261019160000_proposal_queue`; `packages/db/src/policy-defaults.json` and `docs/spec/policy-defaults.json`; `packages/schemas/src/tools-intake.ts`; `api/src/services/policy.ts`, `contact-points.ts`, `proposal-store.ts`, `proposal-decide.ts`, `proposals.ts`, `intake.ts`, `intake-write.ts`; `api/src/mcp/tools/intake.ts`, `contact-points.ts`; `worker/src/jobs/retention.ts`.

**Ops:** none beyond the deploy's `prisma migrate deploy`: the policy migration gives every seeded team the two `contact_point.edit` rules (one `policy_version` bump), and the queue migration backfills existing proposals and applies the windows.

**Acceptance:** with `DATABASE_URL` exported on a fresh database:

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm exec turbo run test --concurrency=1
node scripts/verify-audit-chain.mjs
pnpm docs:mcp && git diff --exit-code docs/mcp-surface.md
```

Every command exits 0.
