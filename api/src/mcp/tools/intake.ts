import {
  CrmIntakeSubmit, CrmProposalDecide, CrmProposalsList, type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { submitIntake } from '../../services/intake.js'
import { decideProposal } from '../../services/proposal-decide.js'
import { listProposals } from '../../services/proposals.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

function jsonResult(value: Record<string, unknown>) {
  return ok(value, JSON.stringify(value))
}

export function registerIntakeTools(
  server: Parameters<typeof defineTool>[0],
  ctx: ActorContext,
  deps: AppDeps,
): void {
  defineTool(server, {
    name: 'crm_intake_submit', title: 'Record a form or chat submission', group: 'records', access: 'explicit',
    description: 'A data subject\'s own form or chat submission, subject-attested only. No email/phone match creates the person; one match pairs (fills empty fields, adds new emails/phones beside); else a pending match. Logs the activity and note. Returns outcome and record_id only.',
    input: CrmIntakeSubmit.in.shape,
    handler: async (args) => jsonResult(await submitIntake(deps, ctx, args)),
  })
  defineTool(server, {
    name: 'crm_proposals_list', title: 'List proposals', group: 'records', access: 'standard',
    description: 'List changes a form or chat submission proposed for a person to decide: amendments (one field: proposed and current value) and unresolved matches (candidates and submitted values), each with its source. Decide with crm_proposal_decide.',
    input: CrmProposalsList.in.shape,
    handler: async (args) => jsonResult(await listProposals(deps, ctx, args)),
  })
  defineTool(server, {
    name: 'crm_proposal_decide', title: 'Decide proposal', group: 'records', access: 'standard',
    description: 'Approve or reject a pending proposal as yourself. Approving an amendment writes its value (expected_version guards it); approving a match pairs it with record_id or creates the person. Rejecting writes nothing. NOT_FOUND once decided.',
    input: CrmProposalDecide.in.shape,
    handler: async (args) => jsonResult(await decideProposal(deps, ctx, args)),
  })
}
