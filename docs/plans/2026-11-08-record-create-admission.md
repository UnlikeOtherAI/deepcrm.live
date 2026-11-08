# Current record creation admission

Nessie must show its existing customer-creation form only after the native CRM reports whether this caller may start creation for the exact object type. Schema read access, writable-looking attributes and tool discovery do not establish that permission.

## Contract

crm_record_create_admission is a read-only Records tool. It accepts only object_type and returns object_type_id, schema_version, create (allowed, approval_required or denied), and observed_at. It reuses the same team/object record:create policy request as createRecord. Schema view is required before lookup and rechecked from the same fresh policy snapshot used for the final creation decision. No policy rule/binding, personal identifier, commercial value or reusable write grant is returned.

The result decides whether to start the form, not whether every submitted value is valid or permitted. Attribute, link, origin, visibility, duplicate and actual current write checks remain on createRecord. Schema version is not a policy version. Consumers must bind the response to the original caller/team/object, use a bounded request-start lease, and revalidate after principal/team or visibility changes. Actual mutation always reauthorizes. No role or default grant changes.

## Acceptance

- [ ] The real supported MCP interface advertises and calls the typed tool with described strict arguments.
- [ ] A permitted human gets the current object ID, schema observation and allowed state without records, changes, audit, replay or schema mutation.
- [ ] Exact object/team/principal deny and deny-overrides return denied without widening another object or caller.
- [ ] Approval-required stays distinct from both direct allowance and hard denial.
- [ ] Schema denial, unknown/foreign type and archived type refuse with the canonical error semantics.
- [ ] Agent calls require the same human and app/agent policy combination as writes; discovery is not a grant.
- [ ] A changed policy is observed on the next read; prior allowance cannot bypass actual writer policy or protected fields.
- [ ] Schema/API lint, semantic types and focused service/MCP suites run through Turbo with an exported isolated DATABASE_URL; skipped DB cases do not count.
- [ ] pnpm docs:mcp regenerates the tool table/summary; CLAUDE.md and the records contract describe the new read.

## Execution

Source base7ab7ca7809fa13bff921edb739bbe0480c9219be equals live origin/main on8November2026. This work is in the coordinator-owned nested worktree on t3/record-create-admission; the dirty primary checkout remains untouched. No migration, new identity store, external writer or Finance grant is introduced. Package/DB/MCP/production-provider evidence remains pending until recorded here. This branch is an upstream prerequisite of the Nessie Clients/Finance build and requires its own reviewed green PR before use against the deployed provider.

Source checkpoint on Minis/Windows: exact owned ESLint configuration passed all5changed TypeScript files; native TypeScript syntax parsing and Git whitespace checks passed. Eight real-database/MCP SDK cases are authored and remain unexecuted. No dependency install, semantic typecheck, package suite, database, server or provider verification has run for this upstream branch. The MCP table slot is authored; its generated summary/catalog regeneration is still pending the reserved native workspace toolchain. No acceptance box is checked.

Self-review corrected the DB fixture to pass only local tenant IDs into scoped rows and to seed the canonical policy defaults explicitly. This changes test setup only; the production policy evaluator and default grants are unchanged. Focused exact-config ESLint and whitespace checks pass. Real database execution remains pending.
