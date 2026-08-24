# Phase 6 — Deploy and integrate with Nessie

Outcome: `https://api.deepcrm.live/mcp` live on Hetzner; Nessie can enable DeepCRM per team and its agents see `crm_*` tools; prompts shipped.

### T43 ✅ — Dockerfile and compose

**Depends on:** T42. **Spec:** `docs/deployment.md`.

**Files:**
- Create `Dockerfile.app` — stage `build`: `node:24-alpine`, `corepack enable && corepack prepare pnpm@10.22.0 --activate`, copy lockfile + workspace manifests, `pnpm install --frozen-lockfile`, copy source **including** `eslint.config.js tsconfig.base.json turbo.json scripts/ docs/mcp-surface.md`, `pnpm build`; stage `runtime`: copy `node_modules` (pruned with `pnpm deploy --prod` per package or `pnpm install --prod --frozen-lockfile`), `api/dist`, `worker/dist`, `packages/*/dist`, `packages/db/prisma`, generated client; `USER node`; `CMD ["node","api/dist/index.js"]`.
- Create `infrastructure/compose/docker-compose.prod.yml` per deployment doc (api, worker, postgres; networks `edge`/`db` external; healthcheck; `env_file: ./.env`; postgres volume).
- Create `infrastructure/compose/redeploy.sh` (`set -euo pipefail`; build; migrate via `docker compose run --rm api node node_modules/prisma/build/index.js migrate deploy --schema packages/db/prisma/schema.prisma` — `prisma` is a **runtime dep** of `@deepcrm/db` since T01, so it survives pruning; document in `docs/deployment.md`); `up -d`; verify `curl -sf http://localhost:5656/health` inside the api container.
- Create `scripts/generate-app-key.mjs` — prints `key` and `name:sha256hex`.
- Edit `.github/workflows/ci.yml` — `build` job now unconditional.

**Acceptance:** `docker build -f Dockerfile.app -t deepcrm-app:test .` succeeds; `docker run --rm -e DATABASE_URL=postgresql://x -e REQUIRE_AUTH=true deepcrm-app:test node -e "console.log('ok')"` prints `ok`.

---

### T44 — First production deploy (HUMAN-GATED)

**Depends on:** T43. **Spec:** `docs/deployment.md` "First deploy".

**This task is executed by a human or with explicit human approval in the session. An agent must stop and ask before step 1.** (T47 is likewise human-gated; `docs/done/` also holds these tasks' evidence transcripts.)

Steps: DNS record; rsync; `/srv/deepcrm/.env` (generate `DEEPCRM_APP_KEYS` for `nessie`, `DEEPCRM_SECRET_KEYRING_B64`, DB password); Caddy block; `redeploy.sh`; verify `/health` and `/.well-known/oauth-protected-resource` over HTTPS; `curl -s -X POST https://api.deepcrm.live/mcp` without auth ⇒ 401 with `WWW-Authenticate`.

**Acceptance:** the three curls above; paste outputs into `docs/done/first-deploy.md`.

---

### T45 — Prompts

**Depends on:** T42. **Spec:** `docs/mcp-surface.md` §9.

**Files:** `api/src/mcp/prompts.ts` — three prompts (each noting that merge/delete/export gates are server-enforced) + **Edit `api/src/mcp/server.ts`** to register them; harness test `prompts/list` returns 3 with `ttlMs`, and `prompts/get crm/qualify-lead` substitutes `record_id`.

**Acceptance:** api tests green; `pnpm docs:mcp` unchanged.

---

### T46 — Nessie integration spec (written in the nessie repo)

**Depends on:** T44. **Spec:** `docs/spec/nessie-integration.md` (the protocol, from DeepCRM's side); nessie `CLAUDE.md` → "DeepWater as an agent tool" and "External-agent products".

**Deliverable** (authored in the **nessie repo checkout**, exempt from this repo's worktree rule): `nessie/docs/plans/<date>-deepcrm-integration.md` describing, in nessie's own vocabulary: an `IntegratedProduct` row `deepcrm` (category tool, auth mode `uoa_sso`), team enablement that provisions a **team-scoped, tool-projecting** `McpServerInstance` from a `deep-crm` catalog entry pointing at `https://api.deepcrm.live/mcp` with bearer `DEEPCRM_MCP_APP_KEY` (deployment env, like `DEEPSIGNAL_MCP_APP_KEY`), every call carrying `X-UOA-Delegation` + `X-Nessie-Context`; tools projected as `mcp_crm_*`, **default ON for team agents** (unlike DeepWater — CRM reads are cheap and unmetered) except `crm_merge_records`, `crm_record_delete`, `crm_export`, and schema `define` tools flagged `requiresExplicitGrant`; approvals: the agent surfaces MRTR `input_required` to the channel and re-issues on a human "yes" from an admin; DeepCRM webhook target = a new `POST /api/integrations/deepcrm/events` producing a rolling digest like DeepSignal's. No code in this task — the spec is reviewed by the owner first.

**Acceptance:** the file exists in nessie and links back to `deepcrm.live/docs/mcp-surface.md`.

---

### T47 — Nessie smoke through a real agent (HUMAN-GATED)

**Depends on:** T46 implemented in nessie (separate nessie tasks). A human asks a Nessie agent in a DeepCRM-enabled team: "Add Anna Novak, CTO at Asahi Europe (asahi.eu), and open a £40k deal in Proposal." Expect: company asserted by domain, person asserted by email/name, link `works_at`, deal created with stage `proposal`, all visible via `crm_record_timeline`. Record the transcript in `docs/done/nessie-smoke.md`.

**Acceptance:** transcript shows the four tool calls and `crm_record_timeline` output.
