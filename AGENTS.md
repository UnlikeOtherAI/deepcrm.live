# DeepCRM Agent Standards

## Rule zero — a capability is not done until an agent can discover it

DeepCRM has no screens. The doorway to every capability is `tools/list` and the `crm://schema` resource. A change that adds or alters a capability must, in the same change:

1. **Ship the tool (or resource) with a description an agent can act on unprompted** — what it does, when to use it instead of its neighbours, what it returns, which errors it raises. Input schemas use `.describe()` on every field.
2. **Scope by entitlement, never by ambient context.** Reads return what the caller's policy allows inside its tenant; filters are explicit arguments, never silent defaults.
3. **Return only what drives a decision.** Tool outputs are compact typed JSON; no prose, no decoration, no redundant echo of the input.
4. **Reuse the service; never fork it.** A tool is a thin adapter over `packages/schema-engine` / `api/src/services`. Two tools that do the same thing with different words are a defect.

## Workflow

- Worktrees are mandatory: main checkout stays on `main`; every task works in `.worktrees/<task>` on its own branch; merge to `main` after lint + typecheck + tests pass; push every commit; delete merged branches.
- Package manager **pnpm**. Run tests through Turbo (`pnpm test` / `pnpm exec turbo run test --filter=<pkg>`); export `DATABASE_URL` or Postgres suites skip silently.
- Prisma migrations under `packages/db/prisma/migrations/` are immutable once committed.
- After every server start/restart, verify it: `curl -s http://localhost:5656/health`.
- One task from `docs/plans/` per branch. A task is done when its **Acceptance** block passes verbatim.

## Code quality

- Strict TypeScript, ESLint clean, builds lint-gated. No `any`. No `as unknown as`.
- 500 lines per file max. Split by responsibility, never into `-helpers`/`-utils` buckets.
- No fallbacks, no sentinel values, no backwards-compat shims. Fix the contract.
- Validate at every boundary: tool arguments (zod), stored JSON (`records.data` against attribute metadata), queue payloads, webhook bodies.
- Never log raw tool arguments or record data; log ids, counts, durations, error codes.
- Every mutating service takes an `ActorContext` and writes `record_changes` + `audit_logs` in the same transaction — never outside it.

## Natural-language judgement stays outside DeepCRM

DeepCRM never interprets content: no "looks like a duplicate" heuristics on names, no intent detection, no language branches. Deterministic matching acts only on **structural facts** (normalised email, E.164 phone, registrable domain, exact ids) and returns *candidates with evidence*. The calling agent judges. Semantic search and semantic duplicate candidates use embeddings, which is retrieval, not judgement.

## Documentation

- Specs live in `docs/`; finished plan files move to `docs/done/`.
- `docs/mcp-surface.md` is regenerated from tool definitions (`pnpm docs:mcp`) and committed; hand-edits are overwritten.
- Changes to ports, env vars, build steps, or the MCP surface update `CLAUDE.md`.
