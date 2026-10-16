import { DelegatedPrincipalSchema, type DelegatedPrincipal } from '@deepcrm/schemas'

export function devPrincipal(requestId: string): DelegatedPrincipal {
  return DelegatedPrincipalSchema.parse({
    kind: 'delegated',
    app: 'dev',
    uoaUserId: 'usr_dev',
    uoaOrgId: 'org_dev',
    uoaTeamId: 'team_dev',
    role: 'owner',
    sourceDomain: 'dev',
    product: 'dev',
    actChain: [],
    agentId: 'agent_dev',
    tokenVersion: null,
    provenance: {
      runId: 'run_dev',
      toolCallId: 'call_dev',
      requestId,
    },
  })
}
