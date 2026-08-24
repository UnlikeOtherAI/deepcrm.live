import {
  CrmSuppressionAdd,
  CrmSuppressionCheck,
  CrmSuppressionList,
  CrmSuppressionRemove,
  CrmRecordErase,
  CrmWriteGuardSet,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import {
  addSuppression,
  checkSuppression,
  listSuppressions,
  removeSuppression,
  setWriteGuard,
} from '../../services/compliance.js'
import { eraseCrmRecord } from '../../services/erasure.js'
import { withApproval } from './approval.js'
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
    name: 'crm_suppression_add',
    description: 'Add a hashed suppression entry. Use for objections, erasure, bounces, and manual channel holds. Values are normalized in memory and never stored raw.',
    input: CrmSuppressionAdd.in.shape,
    handler: async (args) => jsonResult(await addSuppression(deps, ctx, args)),
  })
  defineTool(server, {
    name: 'crm_suppression_check',
    description: 'Call before outbound contact on the exact channel. all entries and unexpired channel entries suppress; expired entries return suppressed false.',
    input: CrmSuppressionCheck.in.shape,
    handler: async (args) => jsonResult(await checkSuppression(deps, ctx, args)),
  })
  defineTool(server, {
    name: 'crm_suppression_list',
    description: 'List suppression metadata and hashes only. Use filters to inspect compliance state; raw suppressed values are never returned.',
    input: CrmSuppressionList.in.shape,
    handler: async (args) => jsonResult(await listSuppressions(deps, ctx, args)),
  })
  defineTool(server, {
    name: 'crm_suppression_remove',
    description: 'Remove one hashed suppression entry by value and channel. This is owner approval-gated because it may re-enable outbound contact.',
    input: CrmSuppressionRemove.in.shape,
    handler: withApproval(deps, ctx, 'crm_suppression_remove', CrmSuppressionRemove.in.shape, {
      resourceType: 'suppression',
      reason: (args) => args.reason,
      message: () => 'Approve removing this suppression entry? Requires an owner.',
    }, async (args, _mrtr, approval) => jsonResult(await removeSuppression(deps, ctx, args, approval))),
  })
  defineTool(server, {
    name: 'crm_record_erase',
    description: 'Right-to-erasure operation. Suppresses contact facts first, scrubs record, link data, list entry data, historical values, search, keys, and grants, emits record.erased, and leaves a permanent ERASED tombstone. Owner approval-gated and irreversible.',
    input: CrmRecordErase.in.shape,
    handler: withApproval(deps, ctx, 'crm_record_erase', CrmRecordErase.in.shape, {
      resourceType: 'record',
      resourceId: (args) => args.id,
      reason: (args) => args.reason,
      message: () => 'Approve irreversible record erasure? Requires an owner.',
    }, async (args, _mrtr, approval) => jsonResult(await eraseCrmRecord(deps, ctx, args, approval))),
  })
  defineTool(server, {
    name: 'crm_write_guard_set',
    description: 'Set rejected origins, require_origin, and app keys forced to team-visible writes. Owner-only; rejected writes return ORIGIN_REJECTED or VISIBILITY_REJECTED.',
    input: CrmWriteGuardSet.in.shape,
    handler: async (args) => jsonResult(await setWriteGuard(deps, ctx, args)),
  })
}
