# T44 first deploy evidence

Date: 2026-08-25

## Host deployment

- Synced the DeepCRM source to `/srv/deepcrm` on `178.105.82.46`.
- Created `/srv/deepcrm/.env` on the host with generated production database, keyring, and Nessie app-key material. The file is host-local and was not committed.
- Added the Caddy route:

```caddyfile
api.deepcrm.live {
	reverse_proxy deepcrm-api:5656
}
```

- `docker network inspect edge db` equivalent verified by deploy: both external networks exist and the API joins `edge` plus `db`.
- `infrastructure/compose/redeploy.sh` completed under explicit Compose project `deepcrm`.
- Nessie's `DEEPCRM_MCP_APP_KEY` deployment env was installed from the generated DeepCRM key and Nessie API/worker were restarted healthy.

## Successful host-local checks

```text
deepcrm-worker Up
deepcrm-api Up (healthy)
deepcrm-postgres Up (healthy)
nessie-api Up (healthy)
nessie-worker Up
```

```sh
docker exec deepcrm-api curl -sS http://localhost:5656/health
```

```json
{"ok":true,"version":"0.0.0","db":"ok"}
```

```sh
docker exec deepcrm-api curl -sS http://localhost:5656/.well-known/oauth-protected-resource
```

```json
{"resource":"https://api.deepcrm.live","authorization_servers":["https://authentication.unlikeotherai.com"],"bearer_methods_supported":["header"]}
```

```sh
docker exec deepcrm-api sh -lc "curl -sS -i -X POST http://localhost:5656/mcp | sed -n '1,12p'"
```

```http
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer resource_metadata="https://api.deepcrm.live/.well-known/oauth-protected-resource"
content-type: application/json; charset=utf-8

{"error":"unauthorized"}
```

## Public DNS gate

The exact public acceptance commands still fail because `api.deepcrm.live` is NXDOMAIN. The Cloudflare credentials available in the local environment are valid but do not include a `deepcrm.live` zone, so the DNS record cannot be created from this session.

```sh
dig +short api.deepcrm.live @1.1.1.1
```

```text

```

```sh
curl -sS -m 20 -D - https://api.deepcrm.live/health
```

```text
curl: (6) Could not resolve host: api.deepcrm.live
```

```sh
curl -sS -m 20 -D - https://api.deepcrm.live/.well-known/oauth-protected-resource
```

```text
curl: (6) Could not resolve host: api.deepcrm.live
```

```sh
curl -sS -m 20 -i -X POST https://api.deepcrm.live/mcp
```

```text
curl: (6) Could not resolve host: api.deepcrm.live
```

The Caddy ACME log reports `DNS problem: NXDOMAIN looking up A for api.deepcrm.live`; TLS issuance will complete automatically once the DNS `A` record exists.

## Required human action

Add or delegate DNS for `deepcrm.live`, then create a DNS-only `A` record:

```text
api.deepcrm.live -> 178.105.82.46
```

Then rerun the three public acceptance curls above.
