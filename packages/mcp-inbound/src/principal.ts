import { PrincipalSchema, type Principal } from '@deepcrm/schemas'

export function devPrincipal(requestId: string): Principal {
  return PrincipalSchema.parse({
    app: 'dev',
    uoaUserId: 'usr_dev',
    uoaOrgId: 'org_dev',
    uoaTeamId: 'team_dev',
    role: 'owner',
    sourceDomain: 'dev',
    product: 'dev',
    actChain: [],
    agentId: 'agent_dev',
    provenance: {
      runId: 'run_dev',
      toolCallId: 'call_dev',
      requestId,
    },
  })
}
