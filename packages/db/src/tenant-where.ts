// The one definition of tenant scoping (docs/auth-and-tenancy.md §3): every
// CRM-table query filters on both columns via this spreadable fragment.
export type TenantRef = { organizationId: string; teamId: string }

export function tenantWhere(t: TenantRef): { organizationId: string; teamId: string } {
  return { organizationId: t.organizationId, teamId: t.teamId }
}
