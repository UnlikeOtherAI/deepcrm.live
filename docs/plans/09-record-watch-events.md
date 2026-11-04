# Record-scoped change events

DeepCRM supplies the durable saved-data events for a record's watch control in
Nessie. It owns event production, ordering, policy and catch-up. Nessie owns the
eye, watch preferences, significance judgement and user/agent delivery.

Extend the existing `crm_changes_since` service and tool with explicit
`record_ids`, preserving its team boundary, current record visibility and value
redaction. Include relationship changes from either endpoint and schema events
for the watched records' visible types. Keep every page bounded and advance the
cursor across a quiet or hidden tail. No new identity store or subscription
credentials are introduced.

## Acceptance

- Tools/list describes `record_ids` and empty-page cursor handling.
- A company watch receives its own changes and incoming relationship changes.
- Hidden and other-tenant records remain absent, including schema context.
- An empty filtered page advances; a later matching change is returned once.
- A long sparse backlog returns bounded, advancing pages until caught up.
- Existing change-feed pagination and value redaction pass unchanged.
- Lint, typecheck and the database-backed feed/MCP checks pass. Exercise the
  supported MCP interface and inspect the resulting event ids and cursors.
