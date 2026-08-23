# Deployment

Self-hosted on the shared Hetzner host (`178.105.82.46`) as Docker containers behind the shared Caddy edge, exactly like nessie and deepsignal. One public host: **`https://api.deepcrm.live`**. No web/admin container.

## Stack

| Container | Image | Command | Networks |
|---|---|---|---|
| `deepcrm-api` | `deepcrm-app:latest` (`Dockerfile.app`) | `node api/dist/index.js` with `DEEPCRM_PROCESS_MODE=api` | `edge`, `db` |
| `deepcrm-worker` | same image | `DEEPCRM_PROCESS_MODE=worker` | `db` |
| `deepcrm-postgres` | `pgvector/pgvector:pg16` | — | `db` |

Dedicated Postgres because the shared instance lacks `vector` (same reason nessie has its own). Volume `deepcrm-pgdata`.

## Files

- `infrastructure/compose/docker-compose.prod.yml` — the three services, `env_file: /srv/deepcrm/.env`, healthcheck `wget -qO- http://localhost:5656/health`.
- `infrastructure/compose/redeploy.sh` — `docker compose build && docker compose run --rm api pnpm --filter @deepcrm/db prisma migrate deploy && docker compose up -d`.
- `Dockerfile.app` — multi-stage: `pnpm install --frozen-lockfile` → `pnpm build` (lint-gated) → runtime image with `api/dist`, `worker/dist`, `packages/*/dist`, generated Prisma client. Copies `eslint.config.js`, `tsconfig.base.json`, `turbo.json`, `scripts/` into the build stage (the build invokes them).

## Caddy

Add to the shared Caddyfile on the host:

```
api.deepcrm.live {
  reverse_proxy deepcrm-api:5656
}
```

DNS: Cloudflare, DNS-only `A api.deepcrm.live → 178.105.82.46`. TLS automatic.

## Environment (`/srv/deepcrm/.env`, never synced)

All variables in [architecture.md](architecture.md) §6, plus `DEEPCRM_TRUSTED_PROXY_HOPS=1`, `REQUIRE_AUTH=true`, `DEEPCRM_API_PUBLIC_URL=https://api.deepcrm.live`, `DEEPCRM_API_PORT=5656`, `DATABASE_URL=postgresql://deepcrm:…@deepcrm-postgres:5432/deepcrm`.

App keys: generate with `node scripts/generate-app-key.mjs nessie` → prints the key once and the `name:sha256hex` line to put in `DEEPCRM_APP_KEYS`. Hand the key to the Nessie deployment as its DeepCRM product credential (mirrors `DEEPSIGNAL_MCP_APP_KEY`).

## First deploy

1. `rsync -a --exclude node_modules --exclude .git ./ root@178.105.82.46:/srv/deepcrm/`
2. Create `/srv/deepcrm/.env`.
3. `docker network inspect edge db` (must exist).
4. `cd /srv/deepcrm && infrastructure/compose/redeploy.sh`
5. Verify: `curl -s https://api.deepcrm.live/health` → `{"ok":true,"version":"…","db":"ok"}`; `curl -s https://api.deepcrm.live/.well-known/oauth-protected-resource`.

## Migrations

`packages/db/prisma/migrations/*` are immutable. `redeploy.sh` runs `prisma migrate deploy` before starting containers. Index creation on `records`, `record_changes`, `record_search` must be `CONCURRENTLY` in raw SQL (lint enforced).

## Backups

`deepcrm-postgres` is included in the host's nightly `pg_dumpall` job (same as nessie/deepsignal). Audit rows are the compliance record; never truncate `audit_logs`.
