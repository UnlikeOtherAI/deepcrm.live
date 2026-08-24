import { CrmWriteGuardSet, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { setWriteGuard } from '../../services/compliance.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

function jsonResult(value: Record<string, unknown>) {
  return ok(value, JSON.stringify(value))
}

export function registerComplianceTools(
  server: Parameters<typeof defineTool>[0],
  ctx: ActorContext,
  deps: AppDeps,
): void {
  defineTool(server, {
    name: 'crm_write_guard_set',
    description: 'Set rejected origins, require_origin, and app keys forced to team-visible writes. Owner-only; rejected writes return ORIGIN_REJECTED or VISIBILITY_REJECTED.',
    input: CrmWriteGuardSet.in.shape,
    handler: async (args) => jsonResult(await setWriteGuard(deps, ctx, args)),
  })
}
