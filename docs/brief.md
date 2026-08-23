# DeepCRM.live — Product & Architecture Brief

**DeepCRM is a headless, agent-native CRM.** There is no web UI, no JavaScript client, no human-facing frontend. Its only product surface is a **Model Context Protocol (MCP) server**: agents — the employees of a Nessie workspace, or any other MCP-capable agent — create, read, relate, search, merge and reason over customer data entirely through MCP tools. The heart of the product is a **runtime-composable schema engine**: any object type, any attribute, any relationship, definable at runtime by an agent, with the full CRM feature set (pipelines, activities, timelines, dedup/merge, permissions, audit) working uniformly over whatever the schema becomes.

By **UnlikeOtherAI Ltd**, sibling of [nessie](../../nessie) (the agentic work platform) and [deepsignal.live](../../deepsignal.live) (decision intelligence). Same family, same backend pattern, same identity authority.

> Status: **brief only** (2026-08-23). No code exists yet. Sections marked *Decision* are recommendations for the owner to confirm; §9 collects the open questions.

---

## 1. Vision

A CRM is a shared memory of relationships plus the processes that act on them. Every CRM ever built has assumed a human at a screen, so the product *is* the screen — forms, views, kanban boards, reports — and the data model is whatever the screens needed. DeepCRM inverts that:

- **Agents are the users.** In Nessie, agents are colleagues: they read channels, take tasks, run schedules, write documents. DeepCRM gives those colleagues the thing a sales, success or ops team actually shares — a structured, governed record of every customer, deal and interaction — as a *tool they call*, not a page they visit.
- **The interface is the protocol.** One MCP endpoint. `tools/list` is the product catalogue; tool descriptions and JSON schemas are the documentation; resources expose the live schema so an agent can learn the workspace's data model before acting.
- **The schema is data.** "Contact", "Company", "Deal" are not tables we wrote; they are *templates* seeded into the same metadata engine an agent uses when it says "track Subscriptions, linked to Companies, with an MRR and a renewal date". Anything Attio, Airtable or Salesforce custom objects can express, an agent can express in one tool call — and the engine keeps history, uniqueness, search, permissions and audit working for it automatically.
- **Humans see it through Nessie.** A person never logs into DeepCRM. They ask their Nessie agent, read a Nessie knowledge page an agent composed from CRM data, or approve a merge in a Nessie approval. DeepCRM is the system of record; Nessie is the system of conversation.

What it is **not**: not a chat product (Nessie is), not an intelligence product (DeepSignal is), not an email client, not a BI tool, not a general database. It is a CRM — opinionated about relationships, pipelines, interactions and governance — whose *shape* is open.

---

## 2. What makes a good CRM (and what we fold in)

Researched across Attio, HubSpot, Salesforce and Twenty (sources in §10). The must-haves, and the design consequence of each for a headless product:

| Essential | Why it is a must-have | How DeepCRM delivers it |
|---|---|---|
| **Core objects** — people, companies, deals | The vocabulary every integration, agent and human already shares. Attio ships people + companies by default, deals optional ([Attio: objects and lists](https://docs.attio.com/docs/objects-and-lists)); Twenty ships People/Companies/Opportunities/Tasks/Notes. | Seeded as **templates in the schema engine** (§5.6) — standard object types with system attributes that are locked but extensible. Not hard-coded tables. |
| **Custom objects, custom fields** | Every business has entities the vendor did not anticipate (subscriptions, properties, vessels, grants). Salesforce's entire platform is "object and field definitions as metadata rather than actual database structures" ([Salesforce multitenant architecture](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html)). | The centrepiece, §5. |
| **Typed relationships, many-to-many, with data on the edge** | "Company of a person" is one-to-many; "consultant ↔ project" is many-to-many *with attributes on the relationship*. Twenty treats this as first-class; HubSpot models it as associations with up to 100 labels per object pair ([HubSpot association labels](https://knowledge.hubspot.com/object-settings/create-and-use-association-labels)). | First-class `relation_types` + `record_links` with labels, cardinality rules and their own attributes (§5.3). |
| **Pipelines & stages** | A deal without a stage is a note. Stage history (when it moved, who moved it, how long it sat) is what forecasting and coaching are built on. | A `status`-typed attribute with an ordered stage set; stage transitions are field-level changes in the change log, so stage history is derived, never a second store (§5.5). |
| **Activities & interactions** | Emails, calls, meetings, notes — the *evidence* behind a relationship. Attio has an `interaction` attribute type; every CRM has an activity timeline. | `activity` is a system object type linked to any record; the **timeline** is the union of activities and field changes for a record and its neighbourhood (§5.5). |
| **Notes & tasks** | The two things a person or agent writes most. | System object types (`note`, `task`) with links; tasks carry assignee (an agent or a human principal), due date, status. |
| **History of every value** | "What was the ARR in March?" and "who changed the owner?" Attio stores `active_from` / `active_until` on every value ([Attio attribute types](https://docs.attio.com/docs/attribute-types)). | Append-only field-level change log with actor provenance (§5.4); bitemporal read tool `crm_record_at(time)`. |
| **Search** | Find by name fragment, by email, by "the company we talked to about packaging". | Postgres full-text over a per-record search document + pgvector semantic search, both tenant-scoped (§5.7). |
| **Dedup & merge** | Dirty data is the #1 reason CRMs die. Salesforce pairs *matching rules* (how to compare) with *duplicate rules* (what to do) and merges up to 3 records choosing a master and per-field survivors, re-parenting related records ([Salesforce duplicate management](https://www.apexhours.com/duplicate-rules-and-matching-rules-in-salesforce-2/)). | Unique attributes enforced in the DB; matching rules as metadata; `crm_find_duplicates` + `crm_merge_records` with per-field survivor choice, link re-pointing and a redirect tombstone (§5.8). |
| **Uniqueness & upsert** | Integrations need "create-or-update by email/domain" or they create duplicates on every sync. Attio exposes `is_unique` and an *assert* (upsert by matching attribute). | `is_unique` attributes backed by a normalised unique-key table; `crm_record_assert` is the upsert tool (§6). |
| **Ownership & permissions** | Who may see the deal, who may edit the contract value, who may merge. Attribute-level sensitivity matters (salary, health, personal email). | Nessie's `PolicyRule` shape (scope × resource × action × effect, deny-overrides) with actors that are agents *or* humans, plus attribute-level sensitivity tiers (§5.9). |
| **Audit** | Regulated customers need "who did what, when, from where". | Nessie's tamper-evident hash-chained `AuditLog`, verbatim (§4.4). |
| **Lists / saved views / segments** | "Enterprise deals closing this quarter" is a reusable query, and a *list* can carry its own attributes per entry (Attio lists/entries). | Saved queries as metadata (`views`) and **lists** with per-entry attributes (§5.6). |
| **Import / export / bulk** | Nobody starts empty. | Bulk assert + export tools run as MCP **Tasks** (long-running, pollable) (§6.4). |
| **Change feed / automation hooks** | Agents must be able to react ("a deal moved to *Negotiation* → draft the contract") without polling everything. | `crm_changes_since(cursor)` plus an outbound signed webhook into Nessie, the same delivery-shaped pattern DeepSignal uses (§6.5). |
| **Data quality signals** | Stale records, missing required fields, orphan deals. | Deterministic `crm_data_quality` report tool; the *judgement* of what to do is the calling agent's. |

What we deliberately leave out of v1 (CRM features that are really UI features or separate products): email sending/sequencing, calendar sync, dashboards/reports rendering, marketing automation, quotes/CPQ, territory management. Interactions still *land* in the CRM — ingestion is an open question (§9).

---

## 3. The protocol decision — MCP, "Matrix", or something newer?

### 3.1 What "Matrix" actually is in the agent world

You remembered Matrix as "a better/newer MCP". It is not a successor to MCP; it is a different layer. **Matrix** is the open, federated, end-to-end-encrypted communication protocol stewarded by the Matrix.org Foundation, with **Element** as its flagship client and enterprise vendor ([element.io](https://element.io/en), [matrix.org](https://matrix.org/)). Element's own positioning is secure, sovereign messaging for enterprise and government — it says nothing about agents or MCP. What *has* happened in 2026 is that others have adopted Matrix as an *agent coordination substrate*: **Alibaba's HiClaw** is "an open-source Collaborative Multi-Agent OS for transparent, human-in-the-loop task coordination via Matrix rooms" — a Manager agent coordinates Worker agents, every conversation is a Matrix room the human sits in and can interrupt, and it ships a bundled Tuwunel homeserver ([alibaba/hiclaw](https://github.com/alibaba/hiclaw)). Analysts describe Matrix-based designs as solving human-in-the-loop "elegantly but [requiring] infrastructure investment most teams are not ready to make" ([Zylos Research, March 2026](https://zylos.ai/research/2026-03-26-agent-interoperability-protocols-mcp-a2a-acp-convergence/)). There are also plain Matrix↔MCP bridges so coding agents can post into rooms ([elkimek/matrix-bridge](https://github.com/elkimek/matrix-bridge)).

So Matrix competes with **Nessie's channels**, not with MCP. Nessie *is* already our Matrix: channels, threads, agents as members, humans watching and intervening, approval gates. DeepCRM needs none of that — it needs a *tool* protocol.

### 3.2 The protocol landscape, honestly

The 2026 stack has settled into complementary layers rather than one winner ([Zylos: protocol comparison](https://zylos.ai/research/2026-03-05-multi-agent-communication-protocols-comparison/), [Oracle: the agent communication matrix](https://blogs.oracle.com/developers/the-agent-communication-matrix-when-mcp-a2a-and-plain-rest-each-win)):

- **MCP** — agent → tool. The CRM is a passive capability provider; this is exactly MCP's shape. Governance moved to the Linux Foundation's **Agentic AI Foundation** in December 2025 (Anthropic, OpenAI, Google, Microsoft, AWS, Block, Cloudflare, Bloomberg); 18k+ indexed servers, tens of millions of monthly SDK downloads, Salesforce and ServiceNow among enterprise adopters.
- **A2A** — agent → agent delegation, Agent Cards at `/.well-known/agent.json`, task lifecycle, Linux Foundation project. Relevant only if DeepCRM itself becomes an *agent* you hand goals to. It is not, in v1.
- **ACP / UCP** — commerce and REST-native agent interaction. Not relevant.
- A joint MCP/A2A interoperability spec is "reported" for Q3 2026 but no draft exists.

### 3.3 MCP itself just changed shape — and in our favour

The **MCP 2026-07-28 specification** (stable as of this month) is the one to build on ([release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)):

- **Stateless core.** No `initialize` handshake, no `Mcp-Session-Id`; every request carries protocol version and client capabilities in `_meta`. Guidance: "If your server needs to carry state across calls, mint an explicit handle from a tool and have the model pass it back as an argument." This is precisely how DeepSignal's `/mcp` already runs (a fresh server + transport per request, principal bound from headers), so the house pattern is *already* the new spec.
- **Multi Round-Trip Requests (MRTR).** A tool can return `resultType: "input_required"`; the client re-issues the call with answers. This is how a merge or destructive schema change asks "confirm?" without a held-open stream — the headless equivalent of Nessie's approval gate.
- **Extensions framework.** **Tasks** (`io.modelcontextprotocol/tasks`, poll-based `tasks/get`) for long-running work — bulk import, re-embedding, dedup scans. **MCP Apps** (server-rendered UI) — we explicitly do *not* use it; headless means headless.
- **Header-based routing** (`Mcp-Method`, `Mcp-Name`) — rate limiting and metering per tool at the Caddy edge without parsing bodies.
- **Cacheable `tools/list` / `resources/read`** (`ttlMs`, `cacheScope`) — important for us because the tool list is large and the schema resource changes rarely.
- **Authorization hardening** — RFC 9207 `iss`, Dynamic Client Registration deprecated in favour of Client ID Metadata Documents, credentials bound per issuer. Our inbound model (bearer app key + UOA delegation + signed provenance) sits on top of this unchanged.
- **Deprecated:** Roots, Sampling, Logging, and the legacy HTTP+SSE transport (12-month window). Do not design around sampling (server asking the client's model to think) — the CRM must not depend on it.

### 3.4 Decision

**Build on MCP 2026-07-28 now; keep the service layer protocol-agnostic; do not build on or for Matrix.**

1. The only public surface is a streamable-HTTP MCP endpoint at `/mcp`, stateless, plus the RFC 9728 protected-resource metadata document. No REST API for CRM data. (Health, metrics and inbound webhooks are infrastructure, not product surface.)
2. Every tool handler calls the same service functions a future second transport would call (DeepSignal's `McpHttpDeps` pattern: "the SAME service functions the REST routes call — no forked business logic"). If A2A or the joint spec matters later, it is a second thin adapter over the same services, not a rewrite.
3. Human-in-the-loop lives in **Nessie**, not in a Matrix room: an agent's DeepCRM tool call that needs confirmation returns MRTR `input_required`; the Nessie agent surfaces that to the person in-channel (or raises a Nessie `ApprovalRequest`) and re-issues the call with the answer.
4. Re-evaluate in two situations only: the joint MCP/A2A spec ships with something tools cannot express, or DeepCRM grows an autonomous role (e.g. "keep this pipeline clean" as a standing goal) — that is when an Agent Card makes sense.

### 3.5 Matrix as the connective fabric *between* products (not the CRM's interface)

The instinct that Matrix "could be good to connect things together" is right at a different layer. Matrix rooms are durable, ordered, federated, end-to-end-encrypted logs with membership, presence and replay — and Element gives humans a window onto them with no UI work. That is a credible **event/room layer across the product family**:

- replacing bespoke product→Nessie webhooks (DeepSignal's insight digest, DeepCRM's change feed) with a room per team: ordered delivery, offline catch-up, per-room membership for free;
- letting agents from *different* deployments — or a customer's own homeserver — share one conversation, which HTTP webhooks cannot do;
- bridging the outside world (Slack, Teams, WhatsApp, email bridges already exist) through one adapter instead of one connector per provider.

What it is not: the CRM's request/response surface. An agent creating a deal needs typed schemas, errors, permissions and idempotency — MCP's shape — and Nessie already occupies the rooms-with-humans role today.

**Consequence for DeepCRM:** nothing in the architecture changes; the change-feed delivery seam (§6.5) is the one place a `matrix_room` target would sit beside the HMAC webhook, as a small adapter. The real decision — whether Nessie's channels ever move onto a homeserver — is a Nessie decision, tracked as an open question (§9 Q11).

---

## 4. Architecture — the Nessie pattern, headless

### 4.1 What Nessie's backend is

Nessie's backend is **Fastify + Prisma + PostgreSQL** (`nessie/api/prisma/schema.prisma`, 140 models; `nessie/CLAUDE.md` → Tech), with a **Postgres-backed queue** (`queue_jobs`) instead of Redis, a separate **worker** process, shared **`packages/*`**, pnpm + Turbo, immutable Prisma migrations, and Docker on Hetzner behind the shared Caddy edge. DeepSignal's API is the same shape with raw `pg` + SQL migrations and an MCP endpoint. This brief follows that pattern exactly.

### 4.2 Topology

```
Nessie agent (or any MCP client)
        │  streamable HTTP, stateless, bearer + X-UOA-Delegation + X-Nessie-Context
        ▼
┌──────────────────────────────────────────────────────────┐
│ deepcrm-api  (Fastify)                                    │
│   /mcp                     MCP server, per-request build  │
│   /.well-known/oauth-protected-resource                   │
│   /health                                                 │
│   /webhooks/*  (inbound ingestion, HMAC)   [v2, §9]       │
│   services/*   ← every tool calls these, nothing else     │
└──────────────┬───────────────────────────────────────────┘
               │ Prisma                       ▲ queue_jobs
               ▼                              │
        PostgreSQL + pgvector  ◄──────  deepcrm-worker
        (schema metadata, records,      (embeddings, dedup scans,
         links, changes, audit)          bulk import/export, webhook
                                         delivery, retention)
```

Monorepo: `api/`, `worker/`, `packages/schema-engine`, `packages/schemas` (zod contracts), `packages/db`, `packages/mcp-inbound` (the auth seam — candidate to be *shared* with deepsignal rather than copied, see §9), `infrastructure/compose/`, `docs/`. No `admin/`, `web/`, `desktop/`, `mobile/`.

### 4.3 Reused from Nessie verbatim (the house pattern)

| Concern | Nessie source | DeepCRM |
|---|---|---|
| Runtime & layering | Fastify; "routes parse input, call a service, translate errors" (`docs/architecture.md`) | Identical, with *tools* in the role of routes. |
| Persistence | Prisma + PostgreSQL, `organization_id` on every child table, immutable migrations, `pnpm lint:migrations` | Identical. Metadata tables are ordinary Prisma models. |
| Tenancy | Organisation (1:1 UOA org, `externalOrgId` unique) → Team (1:1 UOA workspace, `externalWorkspaceId` unique). The compound **org + team** is the tenant; "neither half alone is the tenant" (deepsignal `tenant-scope.ts`). The tenant key is resolved from the authenticated principal, never from arguments. | Identical. No `Project`/`Channel` layers — the CRM has no chat hierarchy. Every CRM table carries `organization_id` **and** `team_id`. |
| Identity | UOA is the sole authority for humans, orgs, teams. No local users, no local passwords, no profile mirrors beyond a non-authoritative name. | Identical. DeepCRM stores **no** user table. Actors are referenced by stable UOA subject (humans) or Nessie agent id (agents). |
| Inbound MCP auth | DeepSignal `auth/mcp-inbound.ts`: bearer = product app key; `X-UOA-Delegation` = resource-bound user/workspace; `X-Nessie-Context` = RS256 provenance `{agentId, runId, toolCallId, requestId}`; 5-minute TTL, 30 s skew. | Identical, generalised so a non-Nessie MCP client can present a UOA token directly (§9 Q3). |
| Authorization | `PolicyRule` (scope, scopeId, resourceType, action, effect, priority, conditions) + `PolicyBinding` (actorType, actorId); `checkPolicy` deny-overrides on every tool invocation, with the `(org, resourceType, action, scopeId, priority)` index nessie learned it needs. | Same tables, CRM resource types (§5.9). |
| Approvals | `ApprovalRequest` with `continuationToken`, `expiresAt`, `requiredApproverRole` | Same shape; surfaced via MRTR and mirrored into Nessie (§6.3). |
| Audit | `AuditLog`, per-org SHA-256 hash chain, **no FK to organization** so rows survive org deletion | Verbatim, including the compliance note. |
| Async work | `QueueJob` in Postgres, worker pollers with `visible_at`, idempotency keys | Verbatim. |
| Secrets | AES-256-GCM secret store, server-minted `secret_*` refs, never caller-chosen | Verbatim (webhook HMAC secrets, outbound signing keys). |
| Egress | `safeFetch` IP-pinned SSRF guard for every operator- or agent-supplied URL | Verbatim (webhook targets, enrichment URLs). |
| Embeddings | One `EMBEDDING_DIMENSIONS` constant (1024, jina-v3), `vector(1024)` columns, `dimensions` sent on every request, routed to Ledger `/v1/jina` | Verbatim. |
| Budgets & metering | Inference/embedding calls go through Ledger with signed `X-Nessie-Context`; UOA alone rates usage commercially; no local billing | Verbatim. DeepCRM never stores commercial amounts. |
| Deployment | Docker on Hetzner, shared Caddy edge + `edge`/`db` networks, dedicated pgvector Postgres, compose in `infrastructure/compose/` | Identical: `api.deepcrm.live` only. |
| Engineering rules | 500-line file cap, no helper buckets, strict lint gates on build, docs updated in the same change, worktrees + immediate push + merge | Identical (`AGENTS.md` to be derived from nessie's). |

### 4.4 What differs for a headless MCP CRM

- **No presentation layer at all.** Nessie's "rule zero" ("a capability is not done until a person can reach it") is rewritten for DeepCRM as: **a capability is not done until an agent can discover it from `tools/list` and the schema resource, with a description good enough to use it unprompted.** The tool description *is* the doorway.
- **No inference loop.** DeepCRM does not run agents, threads, runs or messages. It never decides intent. The one model-adjacent thing it does is compute embeddings for search and candidate duplicates; *judging* whether two records are the same person, or whether a lead is qualified, is the calling agent's job (this keeps nessie's "natural-language intent is model-judged, never string-matched" rule on the right side of the boundary: DeepCRM's matching rules are structural — normalised email, domain, phone — not content heuristics).
- **No realtime.** No WebSocket/SSE hub. Change propagation is a cursor tool and a webhook (§6.5).
- **No humans as principals of the product — but humans as principals of the data.** Ownership, assignment and permissions still name humans (by UOA subject), because the deal is still *Anna's* deal even if her agent files it.
- **Schema is tenant data.** Nessie's schema is fixed in Prisma; DeepCRM's Prisma schema holds *metadata tables*, and the customer's schema lives in rows. Migrations evolve the engine, never a tenant's objects.
- **Smaller worker.** No run execution, no mailbox, no triggers engine — only embeddings, scans, bulk jobs, webhook delivery, retention.

---

## 5. The composable data-type engine (centrepiece)

### 5.1 Design goals

1. **Any object, any attribute, any relationship, at runtime**, via tool calls, with no migration and no downtime — Salesforce's founding property ("tolerate online multitenant application schema maintenance … without blocking the concurrent activity of other tenants").
2. **Every CRM feature is generic over the schema.** History, search, uniqueness, permissions, pipelines, timeline, merge: implemented once against metadata, never per object type.
3. **Typed, validated, indexed.** A `currency` attribute is a real decimal + ISO code, not a string; a `record_reference` is a real FK-checked link; a unique email is unique in the database, not in application code.
4. **Simple enough to be correct.** Nessie's "simplest thing that satisfies the current goal" — no query planner, no DSL compiler, no per-tenant DDL.

### 5.2 Storage model — *Decision*

Three proven shapes exist: Salesforce's **flex columns** (one giant `MT_Data` table with `Value0..ValueN` string columns mapped by `MT_Fields`, plus separate index/unique/relationship pivot tables — [Salesforce](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html)), Twenty's **real per-tenant Postgres tables/columns** created by DDL at runtime, and Attio's **per-value rows with validity intervals** (`active_from`/`active_until` on every value — [Attio](https://docs.attio.com/docs/attribute-types)).

DeepCRM uses a **hybrid that fits Postgres and the Nessie pattern**:

- **Current state as a JSONB document per record**, validated against attribute metadata in the service layer at every write. One row, one read, one GIN index per tenant-scope; filterable with `@>` and expression indexes for hot attributes. This is the read path.
- **History as an append-only field-level change log** (`record_changes`), not as validity intervals on the live value. Attio-style bitemporal reads (`crm_record_at`) are reconstructed by replaying changes; this is rare and acceptable. The change log is also the timeline, the stage-history source and the audit detail.
- **Relationships as an explicit edge table** (`record_links`), never as JSON arrays inside the document — so links are FK-checked, queryable from both sides, can carry attributes, and survive merges by re-pointing.
- **Uniqueness as a materialised key table** (`record_unique_keys`), so `is_unique` is a real unique index and dedup lookup is an index hit.
- **Search as a materialised per-record document** (`record_search`: tsvector + `vector(1024)`), refreshed by the worker.

Why not Twenty's runtime DDL: per-tenant DDL inside a shared multi-tenant database is operationally hostile (locks, migration immutability rule, Prisma drift) and buys nothing an agent needs. Why not pure EAV: every list read becomes a pivot, and Postgres JSONB already gives us typed-enough storage with indexing.

### 5.3 Metadata model

All tables carry `id uuid`, `organization_id`, `team_id`, `created_at`, `updated_at`, and actor columns `(created_by_type, created_by_id)` where `type ∈ {human, agent, system}`.

**`object_types`** — "roughly tables".
- `slug` (stable, snake_case, unique per tenant), `singular_name`, `plural_name`, `description` (agent-facing — this text is shown in tool schemas), `icon`, `kind ∈ {standard, custom, system}`, `template_slug?` (which seed it came from), `primary_attribute_id` (the display name), `archived_at?`.
- `kind = system` types (`activity`, `note`, `task`, `list_entry`) cannot be deleted; `standard` (`person`, `company`, `deal`) cannot be deleted but can be archived and extended.

**`attributes`** — columns, scoped to one object type *or* one list.
- `object_type_id | list_id`, `slug`, `name`, `description`, `type` (below), `config jsonb` (type-specific: select options, currency default, referenced object types, stage set, number precision, text max length), `is_multi` (many values), `is_required`, `is_unique`, `is_system` (locked), `is_indexed` (creates an expression index on `records.data->>slug`), `sensitivity ∈ {public, internal, confidential, restricted}` (reuses nessie's `SensitivityTier` idea), `default_value`, `archived_at?`.
- **Attribute types** (a closed set implemented once each; deliberately aligned with Attio's 17 plus what a typed engine needs): `text`, `rich_text` (markdown), `number`, `currency`, `percent`, `boolean`, `date`, `datetime`, `select`, `multi_select` (select + `is_multi`), `status` (ordered stages with `category ∈ {open, won, lost, neutral}` — this is what makes a pipeline), `rating`, `email`, `phone`, `url`, `domain`, `location`, `personal_name` (first/last/full with normalisation), `actor_reference` (human UOA subject or agent id — owner, assignee), `record_reference` (typed link, sugar over `record_links` — see below), `timestamp_system` (created/updated/last-activity, computed), `json` (escape hatch, unindexed, validated against an optional JSON Schema in `config`).
- Adding an attribute is a metadata insert. Removing one archives it (values stay in the JSONB and the change log; the attribute disappears from schemas). Hard-deleting values is a separate, approval-gated retention operation.

**`relation_types`** — named, typed, directional edge classes (HubSpot "association labels" + Twenty "relationship with attributes", formalised).
- `slug`, `from_object_type_id`, `to_object_type_id`, `forward_name` ("works at"), `inverse_name` ("employs"), `cardinality ∈ {one_to_one, one_to_many, many_to_one, many_to_many}`, `on_delete ∈ {unlink, cascade, restrict}`, `is_system`, `attributes_object_type_id?` — when set, each link has its own attributes (e.g. `role`, `since` on person↔company), stored as `record_links.data` validated against that attribute set.
- A `record_reference` attribute on an object type is *defined as* a relation type with `many_to_one` (or `many_to_many` when `is_multi`) cardinality; the engine keeps `records.data[slug]` as a denormalised projection of `record_links` for fast reads. Writes go through links. One truth.

**`records`**
- `object_type_id`, `data jsonb`, `display_name` (materialised from the primary attribute), `owner_actor` (type,id), `merged_into_id?` (tombstone redirect), `deleted_at?` (soft delete, retention job hard-deletes), `version int` (optimistic concurrency: every write tool takes `expected_version?`; mismatch → conflict, the agent re-reads).
- Indexes: `(organization_id, team_id, object_type_id, updated_at desc)`, GIN on `data jsonb_path_ops`, partial expression indexes for `is_indexed` attributes, `display_name` trigram.

**`record_links`**
- `relation_type_id`, `from_record_id`, `to_record_id`, `label?`, `data jsonb` (edge attributes), `active_from`, `active_until?` (a person *left* a company: the link ends, history kept). Unique on `(relation_type_id, from, to, active_until IS NULL)` for non-many cardinalities enforced in the service under a per-record advisory lock.

**`record_unique_keys`** — `(attribute_id, normalized_value)` unique; populated on every write for `is_unique` attributes using type-specific normalisation (lower-cased email, E.164 phone, registrable domain). This is both the constraint and the dedup index.

**`record_changes`** — append-only. `record_id`, `attribute_id | relation_type_id`, `kind ∈ {set, unset, link, unlink, create, merge, restore}`, `old_value`, `new_value`, `actor` (type,id), `provenance` (`runId`, `toolCallId`, `requestId` from `X-Nessie-Context`), `reason?` (the agent's stated reason, captured from the tool argument), `occurred_at`. Indexed by `(record_id, occurred_at desc)` and `(organization_id, team_id, occurred_at desc)` for the global change feed.

**`matching_rules`** — per object type: ordered list of `{ attributes: [...], method: exact | normalized | fuzzy(threshold), weight }`, `action ∈ {block, warn, allow}` on create (Salesforce matching rule + duplicate rule, merged into one metadata row).

**`views`** — saved queries: `object_type_id`, `name`, `filter` (the same filter JSON the query tool takes), `sort`, `columns`. **`lists`** + **`list_entries`** — a list is a curated set of records (any object type, or mixed) and can define its own attributes; entries carry `data` validated against them (Attio's lists/entries).

**`schema_versions`** — every metadata mutation bumps a tenant `schema_version` and writes a snapshot diff; `tools/list` and the schema resource carry it as an ETag so clients cache per spec (`ttlMs`, `cacheScope`).

### 5.4 Write path (the invariant list)

Every record write — create, update, assert, link, unlink, merge, delete — is **one transaction** that:
1. resolves tenant + actor from the authenticated principal (never from arguments);
2. `checkPolicy` for the object type, then for each *restricted/confidential* attribute touched;
3. loads the live schema for the object type (cached per `schema_version`);
4. validates and normalises every value by attribute type; rejects unknown attributes (no silent drops — nessie: "do not use fake sentinel values; fix the contract");
5. takes `pg_advisory_xact_lock(record_id)` for updates/links/merges;
6. checks `expected_version`;
7. upserts `record_unique_keys` (a violation surfaces as a *duplicate* error carrying the colliding record id, so the agent can decide to link, assert or merge);
8. writes `records.data`, `record_links`, `record_changes` rows, the `AuditLog` row (hash-chained);
9. enqueues `record.reindex` (search doc + embedding) and `change.deliver` (webhook) jobs.

Idempotency: every mutating tool accepts `idempotency_key`; replays return the original result (DeepSignal's `chat_idempotency_replays` pattern).

### 5.5 Pipelines, activities, timeline — generic over the schema

- A **pipeline** is any object type with a `status` attribute. Stages are the attribute's ordered options with categories (open/won/lost). Moving a deal = setting the attribute. Stage history, time-in-stage and conversion are **queries over `record_changes`** for that attribute. Multiple pipelines = multiple `status` attributes or multiple object types; nothing special.
- **Activity** is a system object type: `kind ∈ {email, call, meeting, note, message, task_event, custom}`, `occurred_at`, `direction`, `subject`, `body`, `participants` (actor references), `external_ref` (for idempotent ingestion), plus links to any records via a system relation type `activity → *`. A **note** and a **task** are system object types with their own attributes and the same linking.
- **Timeline** (`crm_record_timeline`) = activities linked to the record ∪ `record_changes` on the record ∪ (optionally) the same for linked records one hop out (a company's timeline includes its people's activities). Paginated, newest first, filterable by kind.
- `last_activity_at` is a computed `timestamp_system` attribute maintained by the worker — the single most-used CRM field ("stale accounts").

### 5.6 Seeded templates (the "standard" CRM, expressed in the engine)

Seed per tenant on first use, idempotently, from versioned JSON templates in `packages/schema-engine/templates/`:

- **person**: `name (personal_name, primary)`, `emails (email, multi, unique)`, `phones (phone, multi)`, `title`, `linkedin (url)`, `location`, `owner (actor_reference)`, `source (select)`, `tags (multi_select)`, `last_activity_at`.
- **company**: `name (primary)`, `domains (domain, multi, unique)`, `industry (select)`, `size (select)`, `annual_revenue (currency)`, `location`, `owner`, `tags`, `last_activity_at`.
- **deal**: `name`, `stage (status: Lead → Qualified → Proposal → Negotiation → Won | Lost)`, `amount (currency)`, `close_date`, `probability (percent)`, `owner`, `lost_reason (select)`.
- Relation types: `person —works_at→ company` (many_to_one, edge attributes `role`, `since`), `deal —for→ company`, `deal —contacts→ person` (many_to_many, edge attribute `role ∈ {champion, decision_maker, …}`), `activity —about→ *`, `note —about→ *`, `task —about→ *`, `task —assigned_to→ actor`.
- Matching rules: person by normalised email (block), by name+company (warn); company by domain (block), by normalised name (warn).

Templates are *suggestions the agent can change*: rename, add, archive, re-stage. Only `is_system` attributes (ids, timestamps, `merged_into`) are locked.

### 5.7 Search

- `record_search(record_id, tsv tsvector, embedding vector(1024), content text)` rebuilt by the worker on change; `content` is a type-aware rendering of the record plus its one-hop link names ("Anna Novak · CTO at Asahi Europe · anna@asahi.eu").
- `crm_search(query, object_types?, mode ∈ {keyword, semantic, hybrid})` — hybrid = RRF over tsvector rank and cosine distance, tenant-scoped, policy-filtered post-retrieval (restricted attributes never enter `content`).
- Structured filtering is a separate tool (`crm_records_query`) with a small JSON filter grammar: `{and|or|not, [ {attribute, op, value} ]}` with ops per type (`eq, neq, in, contains, starts_with, gt, gte, lt, lte, between, is_null, is_not_null, linked_to(relation, record)`). No free-form query language.

### 5.8 Dedup & merge

- **Prevent:** unique attributes block at write; matching rules with `action = warn` return `duplicates: [...]` alongside a successful create so the agent sees them; `action = block` refuses with candidates.
- **Find:** `crm_find_duplicates(object_type, scope?)` runs as a Task: exact/normalised matches from `record_unique_keys` and matching rules, plus *semantic candidates* from embedding proximity over `display_name`+key attributes, returned with per-pair evidence. The engine never auto-merges.
- **Merge:** `crm_merge_records(survivor_id, merged_ids[1..n], field_choices?, reason)`. Under locks on all records: per-attribute survivor value (default: survivor's non-null, else newest non-null — the agent may override per field, as in Salesforce), multi-valued attributes unioned, all `record_links` re-pointed (duplicates collapsed), list entries re-pointed, activities re-linked, `merged_into_id` set on the losers (they become redirect tombstones: any read by old id returns the survivor with `redirected_from`), one `merge` change row carrying the full pre-merge snapshot so **`crm_unmerge`** can restore within the retention window. Merge is approval-gated by policy by default (§6.3).

### 5.9 Permissions

Reuse nessie's engine with CRM vocabulary:
- `PolicyScope`: `organization | team | object_type | record | list`.
- `PolicyResourceType`: `schema | object_type | attribute | record | link | list | view | merge | export | webhook`.
- `PolicyAction`: `view | create | edit | delete | link | merge | export | admin | define` (define = schema mutation).
- `PolicyBinding.actorType`: `human | agent | role` (team roles from UOA: owner/admin/member).
- Defaults seeded per team: members (and their agents) view/create/edit records; `define`, `merge`, `delete`, `export` require admin or an explicit allow; `restricted` attributes are invisible unless explicitly allowed, `confidential` are visible but not editable without allow.
- Agents inherit nothing ambient: an agent's binding is explicit (nessie's "scope by entitlement, never by ambient context"). Reads are filtered by entitlement, never by "the caller's team" — the tenant *is* the team, and within it policy decides.
- Every tool result is post-filtered per attribute sensitivity; denied attributes are omitted, not nulled, and the result says `redacted_attributes: [...]` so the agent knows why something is missing.

---

## 6. The MCP tool surface

> The normative, exhaustive list (47 tools, exact names, inputs, outputs, MRTR and Task behaviour) is [mcp-surface.md](mcp-surface.md); this section is the design overview.

Design rules: few, generic, well-described tools over the schema (not one tool per object type — the tool list must stay stable and cacheable as the schema grows); every mutating tool takes `reason?` and `idempotency_key?`; every tool that takes an id ships with the read that finds it (nessie's rule); errors are typed and actionable (`duplicate_found{candidates}`, `version_conflict{current}`, `policy_denied{resource, action}`, `input_required` via MRTR).

### 6.1 Schema (discovery and definition)

- `crm_schema_get(object_type?)` — the full data model or one type: attributes with types/config/sensitivity, relation types, matching rules, views, `schema_version`. Also exposed as resource `crm://schema` and `crm://schema/{object_type}` with `ttlMs`.
- `crm_object_type_define({slug, singular_name, plural_name, description, attributes[], primary_attribute})` / `crm_object_type_update` / `crm_object_type_archive`.
- `crm_attribute_define({object_type, slug, name, description, type, config, is_multi, is_required, is_unique, is_indexed, sensitivity})` / `crm_attribute_update` / `crm_attribute_archive`.
- `crm_relation_type_define({slug, from, to, forward_name, inverse_name, cardinality, on_delete, edge_attributes?})` / `crm_relation_type_archive`.
- `crm_matching_rule_set({object_type, rules[]})`.
- `crm_template_apply({template: 'standard_crm' | 'saas' | 'agency' | …})` — idempotent seeding.

Schema mutations that lose data (archive with values, cardinality tightening, unique on a column with existing collisions) return MRTR `input_required` with the impact ("12 records have multiple values") before proceeding.

### 6.2 Records, links, lists

- `crm_record_create({object_type, data, links?})`, `crm_record_update({id, data, expected_version?})`, `crm_record_assert({object_type, match_attribute, data})` (upsert by unique attribute), `crm_record_get({id | object_type + match_attribute + value, include_links?, include_timeline?})`, `crm_record_delete({id})` (soft), `crm_record_restore({id})`.
- `crm_records_query({object_type, filter, sort, cursor, limit, attributes?})` — structured; returns `records[]`, `next_cursor`, `total?`.
- `crm_records_bulk_assert({object_type, match_attribute, rows[]})` — a **Task**; returns `task_id`, progress via `tasks/get`, result = per-row outcome.
- `crm_link({relation_type, from, to, data?})`, `crm_unlink({link_id | triple})`, `crm_links_list({record_id, relation_type?, direction?})`.
- `crm_record_at({id, at})` — the record as it was at a timestamp.
- `crm_list_create/add/remove/entries` and `crm_view_save/run`.

### 6.3 Pipelines, activities, tasks

- `crm_pipeline_summary({object_type, status_attribute, group_by?})` — counts, amounts, time-in-stage per stage (derived from `record_changes`).
- `crm_activity_log({kind, occurred_at, subject, body, participants, about: [record ids], external_ref?})` — idempotent on `external_ref`.
- `crm_record_timeline({id, hops?, kinds?, cursor})`.
- `crm_task_create/update/list` (assignee = agent or human actor reference; `due_at`; `status`). Tasks are CRM records, so everything above applies; these are conveniences with sharper descriptions.

Approval: when policy marks an action as requiring approval (merge, delete, export, schema `define` by a member's agent), the tool returns MRTR `input_required` with an `approval_token`. The Nessie agent either gets the human's yes in-channel and re-issues, or raises a Nessie `ApprovalRequest`; DeepCRM records the approval in its own `ApprovalRequest` table with the same `continuationToken` semantics nessie uses.

### 6.4 Search, quality, dedup

- `crm_search({query, object_types?, mode, limit})`.
- `crm_find_duplicates({object_type, scope?})` (Task), `crm_merge_records(...)`, `crm_unmerge({merge_change_id})`.
- `crm_data_quality({object_type?})` — missing required values, stale (no activity in N days), orphan deals (no company/contact), unique-key collisions that predate a rule.
- `crm_export({object_type | view, format: jsonl|csv})` (Task; result is a short-lived signed download URL through the shared file chokepoint pattern).

### 6.5 Change feed

- `crm_changes_since({cursor, object_types?, kinds?, limit})` — the global tenant change feed from `record_changes` (cursor = `(occurred_at, id)`), so an agent on a Nessie schedule can "do something about what changed since last run" cheaply.
- `crm_webhook_set({url, events[], secret_ref})` — outbound HMAC-signed, delivery-shaped (coalesced per window, retried by the worker) exactly like DeepSignal's insight webhook into Nessie. The Nessie side already knows how to turn a product webhook into a rolling digest message.

### 6.6 Prompts and resources

- Resources: `crm://schema`, `crm://schema/{type}`, `crm://templates`, `crm://views/{id}`.
- Prompts (few, optional): `crm/qualify-lead`, `crm/prepare-account-review`, `crm/clean-duplicates` — reusable instruction scaffolds that reference the tools above; they carry no logic.

### 6.7 Tool-list size

47 tools (see [mcp-surface.md](mcp-surface.md) §10). Nessie defers MCP schemas behind `mcp_find_tools`/`mcp_load_tools` above 12 inline tools, so DeepCRM groups its tools with consistent prefixes (`crm_schema_*`, `crm_record*`, `crm_link*`, `crm_search`, …) and short descriptions so the find/load step works well, and sets `ttlMs` on `tools/list` so clients do not refetch per call.

---

## 7. Cross-cutting

- **Provenance on every row.** `record_changes.provenance` carries `{agentId, runId, toolCallId, requestId}` from `X-Nessie-Context`; an agent-written value is always traceable to the run and the person it acted for. This is the CRM answer to "why does this say that?".
- **Rate limits & metering** at the edge on `Mcp-Name`, per app key × tenant; bulk tools are Tasks with explicit caps (`DEEPCRM_MAX_BULK_ROWS`).
- **Retention.** Soft-deleted records and merge snapshots are hard-deleted by the worker after `DEEPCRM_RETENTION_DAYS`; `record_changes` and `AuditLog` are never deleted by product code.
- **Tenant deletion** (UOA org removed): records, links, changes cascade; audit survives (nessie compliance note).
- **Testing.** Postgres-backed suites follow nessie's rules (seed-scoped cleanup, no global counts, `DATABASE_URL` via Turbo strict env). A scripted MCP client harness exercises every tool against a seeded tenant; the schema engine has property tests (random schema → random writes → invariants: JSON/link projection agree, unique keys consistent, replaying changes reproduces `data`).
- **Docs discipline.** `docs/brief.md` (this), `docs/schema-engine.md`, `docs/mcp-surface.md` (generated from tool definitions — the tool descriptions are the spec), `docs/deployment.md`; finished specs move to `docs/done/`.

---

## 8. Phasing (proposal)

1. **Engine + MCP skeleton** — tenancy/auth seam, metadata tables, records/links/changes, validation, `crm_schema_*`, `crm_record_*`, `crm_link*`, `crm_records_query`, audit chain. Standard template seeded. Stateless `/mcp` on 2026-07-28 SDK.
2. **CRM completeness** — activities/notes/tasks, timeline, pipeline summary, unique keys + assert, views/lists, `crm_changes_since`, webhook.
3. **Quality** — search (tsvector + pgvector), matching rules, find-duplicates Task, merge/unmerge, data-quality report, export/import Tasks, MRTR approvals.
4. **Nessie integration** — DeepCRM as a first-party integrated product in nessie (team enablement → tool projection, like DeepWater), `crm/*` prompts, webhook → digest.

---

## 9. Open questions for you

1. **Prisma vs raw `pg`.** Nessie uses Prisma; DeepSignal uses raw `pg` + SQL migrations. The engine's write path (advisory locks, unique-key table, change log in one transaction) is SQL-heavy either way; the brief proposes Prisma for the metadata/schema and `$queryRaw` where needed. Confirm.
2. **Runtime-schema strategy.** JSONB-current-state + change log (proposed) vs Attio-style per-value validity rows. The proposal is simpler and faster to read; it makes "value at time T" a replay rather than an index hit. Acceptable?
3. **Who else may call it?** v1 assumes Nessie is the only MCP client (app key + UOA delegation + signed provenance). Should a non-Nessie agent (Claude Code, a customer's own agent) be able to connect with a UOA OAuth token alone, using CIMD per the new spec? That decides whether `packages/mcp-inbound` must be generalised now.
4. **Shared inbound-auth package.** DeepSignal and DeepCRM would have byte-similar `mcp-inbound` code. Extract a shared `@deep/mcp-inbound` (lives where — `deep.agent`?) before DeepCRM copies it?
5. **Tenant = team, or org-wide CRM?** Following deepsignal/nessie, the tenant is org+team, so two Nessie workspaces in one org have two CRMs. Is that right for a CRM, where sales and success usually want *one* customer record across the company? Option: tenant = org, with team-scoped *policy* instead.
6. **Ingestion.** Emails, calendar, calls: do interactions arrive only via agents calling `crm_activity_log` (v1 proposal), or does DeepCRM get its own inbound connectors/webhooks (nessie's comms-connect already normalises Slack/Gmail into `CommsEvent` — the natural source)?
7. **Embeddings & semantic dedup.** Through Ledger `/v1/jina` like nessie (proposed), signed with the calling user's delegation. Confirm DeepCRM gets its own product-bound Ledger app key.
8. **Approvals home.** MRTR-only (agent asks the human in Nessie and re-issues) vs also mirroring into Nessie's `ApprovalRequest` via the integration. The former is simpler; the latter is auditable in one place.
9. **Per-object-type tool projection.** Keep the generic 47 tools (proposed), or additionally project typed convenience tools (`crm_deal_create` with a real schema) for the template types to make small models more reliable? Costs tool-list size.
10. **Naming.** `deepcrm.live` with `api.deepcrm.live` as the only host. Product name in `tools/list`: "DeepCRM".
11. **Matrix as the family's event fabric.** Should DeepCRM's change-feed delivery (§6.5) grow a `matrix_room` target, and — the bigger question, owned by Nessie — should Nessie channels ever sit on a Matrix homeserver so products and customers' own agents share rooms? Not needed for v1; the delivery seam keeps the door open (§3.5).

> Default answers assumed by the docs and plans until you say otherwise: Q1 Prisma (+ `$queryRaw`), Q2 JSONB + change log, Q3 Nessie-only in v1 with the auth seam generalisable, Q4 copy now/extract later, Q5 tenant = org + team, Q6 agents call `crm_activity_log`, Q7 own Ledger key, Q8 MRTR only, Q9 generic tools only, Q10 as stated, Q11 not in v1.

---

## 10. Sources

**Protocol**
- MCP 2026-07-28 specification — [release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [key changes / changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [release candidate post](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/), [SDK betas](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/).
- MCP/A2A/ACP landscape, AAIF governance, adoption figures — [Zylos Research, 2026-03-26](https://zylos.ai/research/2026-03-26-agent-interoperability-protocols-mcp-a2a-acp-convergence/); [Zylos, 2026-03-05](https://zylos.ai/research/2026-03-05-multi-agent-communication-protocols-comparison/); [Oracle Developers: the agent communication matrix](https://blogs.oracle.com/developers/the-agent-communication-matrix-when-mcp-a2a-and-plain-rest-each-win); [Ry Walker: agent coordination protocols](https://rywalker.com/research/agent-coordination-protocols); [DEV: state of agentic AI standards 2026](https://dev.to/alexmercedcoder/the-state-of-agentic-ai-standards-in-2026-mcp-a2a-webmcp-osi-and-the-protocol-stack-taking-3o2l).
- Matrix as agent substrate — [alibaba/hiclaw](https://github.com/alibaba/hiclaw) (Matrix rooms, Tuwunel homeserver, Manager–Workers); [elkimek/matrix-bridge](https://github.com/elkimek/matrix-bridge); [Matrix MCP server](https://mcpmarket.com/server/matrix).

**CRM essentials & flexible schema**
- Attio — [objects and lists](https://docs.attio.com/docs/objects-and-lists), [attribute types (17 types, `active_from`/`active_until`, `is_unique`, `is_multiselect`)](https://docs.attio.com/docs/attribute-types), [understanding the data model](https://attio.com/help/reference/attio-101/attios-data-model/understanding-attio-data-model), [understanding lists](https://attio.com/help/reference/attio-101/attios-data-model/understanding-lists).
- HubSpot — [custom objects](https://knowledge.hubspot.com/object-settings/create-custom-objects), [association labels](https://knowledge.hubspot.com/object-settings/create-and-use-association-labels), [association limits API](https://developers.hubspot.com/docs/api-reference/crm-limits-tracking-v3/guide).
- Salesforce — [platform multitenant architecture (metadata-driven, MT_Objects/MT_Fields/MT_Data)](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html), [duplicate & matching rules](https://www.apexhours.com/duplicate-rules-and-matching-rules-in-salesforce-2/), [merge duplicates](https://www.salesforceben.com/merge-duplicate-records-in-salesforce-lightning/).
- Twenty (open-source CRM; runtime custom objects, many-to-many with edge attributes, NestJS + Postgres) — [data model docs](https://docs.twenty.com/user-guide/data-model/overview), [review](https://www.opentechhub.io/twenty-a-data-centric-and-fully-customizabe-open-source-crm/).

**House pattern (local repos)**
- nessie — `CLAUDE.md`, `AGENTS.md`, `docs/architecture.md`, `api/prisma/schema.prisma` (`Organization`, `Team`, `OrganizationMember`, `PolicyRule`/`PolicyBinding`, `ApprovalRequest`, `AuditLog`, `QueueJob`), `packages/mcp-manage`.
- deepsignal.live — `api/src/mcp-http.ts` (stateless per-request MCP server, RFC 9728 metadata), `api/src/auth/mcp-inbound.ts` (app key + `X-UOA-Delegation` + `X-Nessie-Context`), `api/src/tenant-scope.ts` (compound org+team tenant), `docs/data-model.md`.
