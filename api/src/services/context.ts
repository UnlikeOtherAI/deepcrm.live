import type { ActorContext, Principal } from '@deepcrm/schemas'
import type { AppDeps } from '../deps.js'
import { resolveTenant } from './tenancy.js'

export async function buildActorContext(
  deps: AppDeps,
  principal: Principal,
  requestId: string,
): Promise<ActorContext> {
  const tenant = await resolveTenant(deps, principal)
  const actor: ActorContext['actor'] = principal.agentId === null
    ? { type: 'human', id: principal.uoaUserId }
    : { type: 'agent', id: principal.agentId }

  return {
    tenant: { organizationId: tenant.organizationId, teamId: tenant.teamId },
    app: principal.app,
    actChain: principal.actChain,
    actor,
    onBehalfOf: { uoaUserId: principal.uoaUserId, role: principal.role },
    provenance: principal.provenance,
    requestId,
    now: deps.clock(),
  }
}
