# DeepCRM.live

**The headless, agent-native CRM.** No web UI, no JS client. One stateless MCP endpoint; agents define any object type, attribute and relationship at runtime and run a fully-fledged CRM — contacts, companies, deals, pipelines, activities, timelines, search, dedup/merge, permissions, audit — entirely through `crm_*` tools.

By **UnlikeOtherAI Ltd**. Sibling of [nessie](../nessie) (where the agents live) and [deepsignal.live](../deepsignal.live).

| Path | What |
|---|---|
| [`docs/brief.md`](docs/brief.md) | Vision, what makes a good CRM, the protocol decision (MCP 2026-07-28; Matrix is a different layer), architecture, the composable schema engine, tool surface, open questions. **Start here.** |
| [`docs/architecture.md`](docs/architecture.md) | Topology, packages, guardrails. |
| [`docs/schema-engine.md`](docs/schema-engine.md) | Metadata model + Prisma schema, attribute types, write path, query grammar, merge. |
| [`docs/mcp-surface.md`](docs/mcp-surface.md) | Every tool, resource, prompt. |
| [`docs/auth-and-tenancy.md`](docs/auth-and-tenancy.md) | Inbound auth, tenant, policy. |
| [`docs/deployment.md`](docs/deployment.md) · [`docs/testing.md`](docs/testing.md) | Ops and test rules. |
| [`docs/spec/`](docs/spec/) | Wire-level design: [contracts.md](docs/spec/contracts.md) (every shared type + every tool's zod I/O), [templates/](docs/spec/templates/) (system + standard_crm JSON), [policy-defaults.json](docs/spec/policy-defaults.json), [events.md](docs/spec/events.md) (change feed + webhook protocol), [protocol-flows.md](docs/spec/protocol-flows.md) (11 wire sequences), [nessie-integration.md](docs/spec/nessie-integration.md), [uoa-integration.md](docs/spec/uoa-integration.md) (SSO/ownership: UOA token exchange, no re-login, direct OAuth profile). |
| [`docs/plans/`](docs/plans/) | Executable task plans, phase by phase. |

Status: **documentation complete, no code yet** (2026-08-23). Implementation follows `docs/plans/00-execution-guide.md`.
