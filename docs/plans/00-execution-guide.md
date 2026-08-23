# Execution guide — how to run these plans

These plans are written so that an agent with **no memory of this repo and modest reasoning** can execute them one task at a time. Follow this guide literally.

## The loop (every task)

1. **Read** `CLAUDE.md`, `AGENTS.md`, and the plan file the task lives in. Read every doc the task's **Spec** line points at. Do not start until you have.
2. **Branch**: from the repo root, `git worktree add .worktrees/<task-id> -b task/<task-id> main` and work only inside that worktree.
3. **Do exactly the task's Steps.** Create only the files listed; if a step needs a file that does not exist, stop and check whether an earlier task should have created it — do not invent a different layout.
4. **Run the Acceptance block verbatim.** Every command must succeed with the stated output. If one fails, fix the cause inside the task's scope; do not disable a check, skip a test, or add `any`.
5. **Update docs** named in the task's **Docs** line (if any) in the same commit.
6. **Commit** with message `<task-id>: <task title>` and push. Merge into `main` (`git switch main && git merge --ff-only task/<task-id> && git push`), remove the worktree, delete the branch.
7. Mark the task done: change its heading `### T07 — …` to `### T07 ✅ — …` in the plan file (in a follow-up commit on `main`).

## Standing environment

The local Postgres from `docs/testing.md` runs for the whole session, and `DATABASE_URL` is exported in every shell — every acceptance block from T03 onward assumes both, whether or not it repeats them. Acceptance blocks that start a dev server must set a per-worktree port (`DEEPCRM_API_PORT=56xx`) and kill by captured PID, never `pkill -f`.

## Hard rules

- Do tasks **in order**. Each task lists **Depends on**; never start a task whose dependencies are not ✅.
- One task per branch. If a task feels too big, still do it — do not split it yourself; that is a plan-authoring decision.
- Do not add packages, tools, tables, or env vars the docs do not name. If the docs are wrong or missing something, write the gap under `docs/plans/gaps.md` (create it) with the task id and continue with the minimal interpretation consistent with the docs.
- Versions are pinned in T01. Do not upgrade.
- **Vocabulary:** "Create" = file must not exist; "Edit" = it must; "Replace" = Edit where the content is wholly rewritten. A task may introduce a new env var only if the same commit adds it to `docs/architecture.md` §6 and `.env.example`.
- Every file ≤ 500 lines — **except** files copied verbatim from `docs/` (the Prisma schema, contract files, templates) and MCP tool-registration files, which may split into sibling files named in their task. Every TS file strict, no `any`, `max-len` 120.
- Never commit secrets. `.env` is git-ignored; `.env.example` is committed.
- Never run anything against production from a plan task. Phase 6 has the only deploy task and says so.

## Conventions used in tasks

- **Files**: paths are repo-relative. "Create" means the file must not exist yet; "Edit" means it must.
- **Skeletons**: code blocks in tasks are the minimum required shape; you may add private helpers in the same file, never new modules unless listed.
- **Acceptance** commands run from the repo root inside the worktree, with `DATABASE_URL` exported when the block says so (see `docs/testing.md` for the local Postgres).
- `pnpm verify` = `pnpm lint && pnpm typecheck && pnpm test` (defined in T01).

## Phases

| Phase | File | Outcome |
|---|---|---|
| 1 | [01-scaffold.md](01-scaffold.md) | monorepo boots, migrations apply, `/health` answers |
| 2 | [02-schema-engine.md](02-schema-engine.md) | metadata + records + links + history work through services, property tests green |
| 3 | [03-mcp-skeleton.md](03-mcp-skeleton.md) | `/mcp` with auth, schema/record/link tools, harness |
| 4 | [04-crm-completeness.md](04-crm-completeness.md) | activities, timeline, tasks, pipeline, lists/views, worker, change feed, webhooks |
| 5 | [05-quality.md](05-quality.md) | search, duplicates, merge/unmerge, data quality, export, approvals |
| 6 | [06-deploy-and-integrate.md](06-deploy-and-integrate.md) | Docker/Caddy deploy, Nessie integration, prompts |
| 7 | [07-visibility-and-compliance.md](07-visibility-and-compliance.md) | per-record visibility, suppression/erasure, origin guard, per-app provenance (the DeepSignal asks) |

When all tasks in a phase are ✅, move the phase file to `docs/done/`.
