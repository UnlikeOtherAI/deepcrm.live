import type { ActorContext } from '@deepcrm/schemas'
import { loadSchema, type LoadedSchema } from '@deepcrm/schema-engine'
import type { AppDeps } from '../deps.js'
import { checkPolicy } from './policy.js'

export async function getSchema(deps: AppDeps, ctx: ActorContext): Promise<LoadedSchema> {
  return loadSchema(deps.db, ctx.tenant)
}

export async function requireSchemaDefine(deps: AppDeps, ctx: ActorContext): Promise<void> {
  const decision = await checkPolicy(deps.db, ctx, 'schema', 'define', [ctx.tenant.teamId])
  if (!decision.allowed) throw new Error(decision.requiresApproval ? 'APPROVAL_REQUIRED' : 'POLICY_DENIED')
}
