import { CrmRecordCreateAdmission, ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'
import type { AppDeps } from '../deps.js'
import { getSchema } from './schema.js'
import { loadPolicyEvaluator, type PolicyRequest } from './policy.js'
import { objectScopes, recordPolicy } from './record-write-authorization.js'
import { recordBoundary } from './record-boundary.js'

/** Observe the canonical base create policy. Field/link and actual-write admission remain independent. */
export const readRecordCreateAdmission = (deps: AppDeps, ctx: ActorContext, objectType: string) =>
  recordBoundary(deps.db, deps.ids, ctx, async () => {
    const schema = await getSchema(deps, ctx)
    const selected = schema.objectTypesBySlug.get(objectType)
    if (!selected || selected.archivedAt !== null)
      throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Unknown object type')
    const view: PolicyRequest = { resourceType: 'schema', action: 'view',
      scopes: [{ scope: 'team', id: ctx.tenant.teamId }] }
    const create = recordPolicy('create', objectScopes(ctx, schema, objectType))
    // Both final decisions use one current policy query; schema version is not a policy generation.
    const evaluator = await loadPolicyEvaluator(deps.db, ctx, [view, create])
    const visible = evaluator.evaluate(view)
    if (!visible.allowed || visible.requiresApproval) throw new ServiceError(
      visible.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
      'Schema access is not permitted',
    )
    const decision = evaluator.evaluate(create)
    return CrmRecordCreateAdmission.out.parse({ object_type_id: selected.id, schema_version: schema.schemaVersion,
      create: decision.requiresApproval ? 'approval_required' : decision.allowed ? 'allowed' : 'denied',
      observed_at: deps.clock().toISOString() })
  })
