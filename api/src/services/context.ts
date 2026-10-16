import { subjectActorId, type ActorContext, type Principal } from '@deepcrm/schemas'
import type { AppDeps } from '../deps.js'
import { resolveTenant } from './tenancy.js'

export async function buildActorContext(
  deps: AppDeps,
  principal: Principal,
  requestId: string,
): Promise<ActorContext> {
  const tenant = await resolveTenant(deps, principal, requestId)
  const base = {
    tenant: { organizationId: tenant.organizationId, teamId: tenant.teamId },
    app: principal.app,
    requestId,
    now: deps.clock(),
  }
  // The data subject's own act: no person acts, so there is no one to act
  // for and no role; the app's subject actor carries the write.
  if (principal.kind === 'subject') {
    return {
      ...base,
      actChain: [],
      actor: { type: 'system', id: subjectActorId(principal.app) },
      onBehalfOf: null,
      provenance: null,
    }
  }
  const actor: ActorContext['actor'] = principal.agentId === null
    ? { type: 'human', id: principal.uoaUserId }
    : { type: 'agent', id: principal.agentId }

  return {
    ...base,
    actChain: principal.actChain,
    actor,
    onBehalfOf: { uoaUserId: principal.uoaUserId, role: principal.role },
    provenance: principal.provenance,
  }
}
