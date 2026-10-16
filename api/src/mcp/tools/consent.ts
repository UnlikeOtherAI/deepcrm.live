import { CrmConsentGet, CrmConsentSet, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { getConsent, setConsent } from '../../services/consent.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

function jsonResult(value: Record<string, unknown>) {
  return ok(value, JSON.stringify(value))
}

export function registerConsentTools(
  server: Parameters<typeof defineTool>[0],
  ctx: ActorContext,
  deps: AppDeps,
): void {
  defineTool(server, {
    name: 'crm_consent_set', title: 'Set marketing consent', group: 'compliance', access: 'standard',
    description: 'Record a person\'s marketing consent by email: not_confirmed, confirmed or declined. declined also suppresses the email; other states lift its opt-out. Only a later at is written; create makes the person when absent. A person needs reason for confirmed; an agent may set declined only.',
    input: CrmConsentSet.in.shape,
    handler: async (args) => jsonResult(await setConsent(deps, ctx, args)),
  })
  defineTool(server, {
    name: 'crm_consent_get', title: 'Read marketing consent', group: 'compliance', access: 'standard',
    description: 'Read a person\'s marketing consent by email: state, when, where it came from, and whether the email is suppressed for email. record_id and state are null when no visible person holds the email.',
    input: CrmConsentGet.in.shape,
    handler: async (args) => jsonResult(await getConsent(deps, ctx, args)),
  })
}
