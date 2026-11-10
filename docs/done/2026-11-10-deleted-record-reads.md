# Deleted record recovery reads

## Contract

Add explicit, policy-preserving recovery reads to the existing headless MCP
record services. Use UUID-only `include_deleted` on get, exclusive `record_state`
on query and optional nullable ISO `deleted_at` in RecordOut. Preserve delete,
restore, erase, UOA authority and relation cascade/unlink policy.

## Acceptance

- Default get/query excludes soft-deleted records; explicit UUID get and deleted
  query return recoverable records with deletion timestamps.
- Current tenant/team, visibility, read/approval and redaction checks apply.
- Erased/merged rows never enter deleted pages; ordinary merge redirects persist.
- Exact filtering, sort, projection, totals, limits and authenticated state-bound
  pagination work. Cross-state/filter/scope cursor reuse fails.
- Restore conflicts retain deleted membership; successful restore leaves Deleted
  and recovers eligible links. Ended links stay absent before restore.
- Discovered MCP inputs, generated surface docs and contract/release notes agree.
- Lint, typecheck, build, PostgreSQL tests and supported MCP calls pass on the
  candidate revision. Deployment evidence identifies the exact shipped source;
  authenticated live acceptance is reported only if actually exercised.
