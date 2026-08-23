# UOA integration — identity, ownership and no-relogin across the family

DeepCRM's identity and ownership structure is **UnlikeOtherAuthenticator** (`https://authentication.unlikeotherai.com`), the same SSO that owns identity for Nessie, DeepWater, DeepSignal and every sibling product. This document is grounded in UOA's own integration guide — the live `/llm` endpoint (served from `UnlikeOtherAuthenticator/API/src/routes/root/llm-*.ts`) — not in sibling products' paraphrases. Where DeepCRM's other docs describe the delegation header, **this document is the authority on its exact shape**.

## 1. The doctrine (identical to every sibling)

- **UOA is the sole authority and durable store** for human identity, authentication factors, profiles, organisation/team membership and invitations. DeepCRM keeps **no user table, no passwords, no profile mirrors** — only the stable UOA ids and CRM-specific data UOA does not own.
- **UOA's org structure maps 1:1**: one UOA organisation = one `Organization` row (`externalOrgId` = UOA `org_…` id, unique); one UOA team = one `Team` row (`externalTeamId` = UOA `tm_…` id, unique). The tenant is the compound (org, team). No flattening, no second copy of the hierarchy.
- **Users never re-login for DeepCRM.** A user authenticated in any family product reaches DeepCRM through that product's UOA **token exchange** — DeepCRM just gets passed the ids, cryptographically. There is no DeepCRM login screen because there is no DeepCRM UI at all.

## 2. UOA's two trust mechanisms, and which DeepCRM uses

UOA has two independent secrets per integrated product (its "two trust mechanisms"):

| Mechanism | What it is | DeepCRM's use |
|---|---|---|
| **RS256 config keypair + JWKS** | The product signs a config JWT served at its `config_url`; its public JWK is published at a `jwks_url` on the same host. Trust root for onboarding and for signing token-exchange subject assertions. | Needed when DeepCRM registers as a UOA product itself (§5) — for the chained Ledger hop and future direct flows. **Not needed to verify inbound calls.** |
| **Per-domain client secret** (`uoa_sec_…`; bearer = `SHA256(domain + clientSecret)`) | The shared-secret credential for backend-to-backend calls to UOA (`/auth/token`, `/org/*`, …). | Same — only for DeepCRM's own outbound UOA calls (§5). Inbound verification is public-key only. |

**Inbound, DeepCRM is a pure resource server**: it verifies RS256 tokens against UOA's **`GET /oauth/jwks.json`** (the access/resource-token JWKS — *not* the config JWKS at `/.well-known/jwks.json`) with issuer + audience checks. Stateless, no shared secret, no UOA round-trip per request.

## 3. How a family product reaches DeepCRM without re-login (the main path)

UOA's **per-product confidential assertion exchange** (guide §4.6a; RFC 8693 grant on `POST /auth/token`):

1. A UOA superuser creates a **confidential-delegation mapping** per calling product via `/internal/admin/confidential-delegations`: `(source domain, product)` → resource **exactly `https://api.deepcrm.live`** + scope allowlist containing `ai.invoke`. One mapping per product — `api.nessie.works/nessie`, `api.deepsignal.live/deepsignal`, … Source domain and product are immutable; resource/scopes/enabled are audited policy.
2. **First hop (e.g. Nessie):** Nessie's backend signs a ≤60 s RS256 subject assertion with its *own config key* (`iss`/`source_domain` = its domain, `aud` = UOA's `/auth/token`, `sub` = the stable UOA user id, `active: { orgId, teamId }` = the selected workspace, one-time `jti`), authenticates with its *own domain-hash bearer*, and exchanges it. **UOA re-reads the live user, domain role and ACTIVE org/team membership before every issue** — a removed or deactivated member is refused at mint time, which is DeepCRM's real revocation bound.
3. UOA returns a **5-minute RS256 resource token** with `aud = https://api.deepcrm.live`. That is what arrives at DeepCRM as `X-UOA-Delegation`.
4. **Chained hop (e.g. Nessie → DeepSignal → DeepCRM):** DeepSignal submits the UOA token *it* received (aud = DeepSignal's origin) as the subject token under its own credential and mapping. The result names DeepSignal as the immediate caller (`source_domain`, `azp`, `product`) and preserves Nessie in the **`act`** chain (`{"sub":"api.nessie.works","product":"nessie"}`). Scopes can only narrow; the chained token never outlives the inbound one.

### 3.1 Delegation claims DeepCRM verifies and consumes (normative)

Verified via `GET /oauth/jwks.json`; `iss` = the UOA host; **`aud` = exactly `https://api.deepcrm.live`** (an inexact audience — path, slash, different origin — is a 401):

| Claim | Use in DeepCRM |
|---|---|
| `sub` | The stable UOA user id — `ActorContext.onBehalfOf.uoaUserId`, visibility grants, suppression/audit attribution. Never `email` (advisory only). |
| `org` | The user's org context on the source domain: `{ org_id, tenant_slug, org_role, teams[], team_roles{}, … }`. **Required** for DeepCRM calls; `org.org_id` → `Organization.externalOrgId`. |
| `active` | `{ orgId, teamId }` — the selected workspace. **Required**; `active.teamId` → `Team.externalTeamId`; `active.orgId` must equal `org.org_id`. Identity-only tokens (no workspace) are rejected — every CRM call is tenant-scoped. |
| `source_domain`, `azp`, `product` | The **immediate** calling product. Must agree with the app key's registered `sourceDomain`/`product` in `DEEPCRM_APPS` — a delegation minted for one product presented under another product's app key is a 401. |
| `act` | Upstream product provenance. **Wire shape (R27): the RFC 8693 `act` claim — a single object `{ sub, product }` with optional nested `act` for deeper chains.** DeepCRM flattens the nesting into `Principal.actChain` (index 0 = the nearest upstream hop) and records the original claim verbatim in audit metadata. A strict verifier accepts the object form only; arrays are rejected. |
| `scope` | Must include `ai.invoke`. |
| `jti`, `iat`, `exp` | `exp − iat ≤ 300 s` (UOA issues 300 s). The first-hop *assertion* is one-time at UOA; the issued resource token is reusable until `exp` by design (concurrent tool calls in one run) — DeepCRM's destructive-call replay bound is the app-context `requestId` seen-set, not the delegation. |

There is **no** flat `team`, `role` or `tv` claim — earlier drafts of `auth-and-tenancy.md` inventing those are superseded by this table. The absence of `tv` means a revoked/downgraded user's outstanding token stays valid up to 300 s; **an upstream ask is filed with UOA** to carry `tv` in exchange-issued tokens, and DeepCRM's verifier enforces per-subject monotonicity the day the claim appears (R22).

### 3.2 Role resolution (UOA guide §4.4/§4.4a compliance)

Org and team role **vocabularies are per-domain configuration** — UOA's rule is: never compare hard-coded role strings, never coerce an unknown role to `member`. DeepCRM v1 resolves `Principal.role` as:

1. `owner` — iff `org.org_role === "owner"` (`"owner"` is the one name UOA requires in every vocabulary, and org ownership is structural).
2. `admin` / `member` — iff `org.team_roles[active.teamId]` (falling back to `org.org_role`) is *exactly* that string. The family's products all run the default `["owner","admin","member"]` vocabulary today.
3. **Any other or missing role resolves to no role**: the policy engine matches no `role:` binding, so the default-deny rows apply and the caller can read nothing gated. Never `member`-floored.

Evaluating a custom vocabulary through UOA's `role_grants` capability table (`members.manage`, `teams.manage`, `organisation.manage`, product-declared verbs) is the correct long-term shape and is an open question (brief §9) — it becomes necessary the day a non-default-vocabulary domain binds.

## 4. Where DeepCRM's own app keys fit (the second shared-secret layer)

The UOA delegation proves the **human + workspace**. DeepCRM's `DEEPCRM_APPS` registry (auth-and-tenancy §1) proves the **calling product** with a DeepCRM-issued `dck_` key and verifies the product's own `X-App-Context` provenance JWT — the same two-layer shape DeepSignal uses for Nessie (`dsk_` key + context + delegation). The registry entry pins each app's `sourceDomain`/`product`, cross-checked against the delegation's `source_domain`/`product`, so the three proofs must all name the same caller. This layer is DeepCRM-local; UOA neither issues nor sees `dck_` keys.

## 5. DeepCRM's own UOA registration (outbound + future direct clients)

For inbound verification alone (§2–§4), DeepCRM needs **no UOA registration** — mappings are created for the *calling* products. Registration of `api.deepcrm.live` as a UOA product (guide Phases 0–1: RS256 config keypair, `/.well-known/jwks.json` on `api.deepcrm.live`, signed config JWT at a `config_url`, auto-onboard `/auth` call, superuser approval, claim link, then a per-domain `uoa_sec_` client secret) is required for exactly two things:

1. **Delegated attribution on DeepCRM's own outbound calls** — the chained hop to Ledger for embeddings: DeepCRM exchanges the inbound delegation (subject token) under its own credential and a `(api.deepcrm.live, deepcrm)` → `https://ledger.unlikeotherai.com` mapping, so embedding usage is attributed to the real user. v1 may run on `LEDGER_PROXY_TOKEN` alone (Ledger decides per token whether signed provenance is additionally required — the Nessie doctrine); the registration unlocks the signed path.
2. **Direct MCP clients** (brief §9 Q3, now designed): UOA's **public-client / MCP OAuth profile** (`/oauth/*` — RFC 8414 metadata at `/.well-known/oauth-authorization-server`, RFC 7591 public registration, OAuth 2.1 + PKCE, `resource` parameter) issues resource-bound RS256 tokens with `aud` = the requested resource — **verified through the exact same `/oauth/jwks.json` + iss/aud path DeepCRM already runs**. A direct client authorizes once against UOA (no DeepCRM account, no re-login if the UOA session exists) and calls `/mcp` with that token and no app key. DeepCRM's RFC 9728 protected-resource metadata already names UOA as the authorization server. Gate: `DEEPCRM_DIRECT_CLIENTS=true`; direct tokens carry no product/app-context — `principal.app = "direct"`, `agentId = null`, actor = the human; a direct token without workspace claims is rejected like any identity-only token. Because no agent provenance exists on this path, the seeded policy denies `app:direct` callers the destructive set unless an owner explicitly grants it — absence of a context proof is never read as proof of a human (auth-and-tenancy §1; R20).

UOA **backend mode** (`/org/*` with the domain-hash bearer and no user token) is deliberately **not** used: DeepCRM never reads or mutates UOA's org/team directory — the doctrine forbids a second copy, and tenant rows are provisioned lazily from verified delegation claims (flow F10), never from directory sweeps.

## 6. Environment

| Var | Default | Purpose |
|---|---|---|
| `UOA_BASE_URL` | `https://authentication.unlikeotherai.com` | issuer; JWKS at `${UOA_BASE_URL}/oauth/jwks.json` |
| `DEEPCRM_APPS` | — | per-app registry: `{ "<name>": { "keyHashes": [...], "contextJwksUrl", "contextIssuer", "sourceDomain", "product" } }` |
| `DEEPCRM_DIRECT_CLIENTS` | `false` | accept UOA public-profile tokens with no app key (§5.2) |
| `DEEPCRM_UOA_CONFIG_PRIVATE_KEY_B64` | — | DeepCRM's own config-signing key (only for §5 outbound; unset ⇒ outbound signing disabled) |
| `DEEPCRM_UOA_CLIENT_SECRET` | — | DeepCRM's `uoa_sec_` per-domain secret (only for §5 outbound) |

## 7. Operator checklist (per calling product)

1. Product is UOA-registered (it already is, for the family).
2. UOA superuser creates the confidential-delegation mapping: product's domain + name → `https://api.deepcrm.live`, scope `ai.invoke`.
3. DeepCRM operator issues the product a `dck_` app key (`scripts/generate-app-key.mjs <name>`) and adds its `DEEPCRM_APPS` entry (key hash, context JWKS/issuer, sourceDomain, product).
4. The product mints delegations per §3 and calls `/mcp`. No user ever logs into DeepCRM.
