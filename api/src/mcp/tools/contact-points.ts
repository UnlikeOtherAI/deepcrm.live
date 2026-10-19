import { CrmContactPointSet, CrmContactPointsGet, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { getContactPoints, setContactPoint } from '../../services/contact-points.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

function jsonResult(value: Record<string, unknown>) {
  return ok(value, JSON.stringify(value))
}

export function registerContactPointTools(
  server: Parameters<typeof defineTool>[0],
  ctx: ActorContext,
  deps: AppDeps,
): void {
  defineTool(server, {
    name: 'crm_contact_points_get', title: 'Read emails and phones', group: 'records', access: 'standard',
    description: 'Read a visible record\'s emails and phones with their state: active values in stored order, then archived ones; each says when and by whom or through which source it was added, if confirmed, last reached (by whom, note) and archived. Change one with crm_contact_point_set.',
    input: CrmContactPointsGet.in.shape,
    handler: async (args) => jsonResult(await getContactPoints(deps, ctx, args)),
  })
  defineTool(server, {
    name: 'crm_contact_point_set', title: 'Update an email or phone', group: 'records', access: 'standard',
    description: 'Act on one email or phone as yourself: reach (successful contact; confirms it; optional note), unreach (undo), confirm (keep as additional), replace_others (keep it, archive the other active values) or restore an archived one. Any member who may edit the record may. Returns that attribute\'s state.',
    input: CrmContactPointSet.in.shape,
    handler: async (args) => jsonResult(await setContactPoint(deps, ctx, args)),
  })
}
