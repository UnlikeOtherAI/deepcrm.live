import { CrmActivityLog, CrmNoteAdd, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { addNote, logActivity } from '../../services/activity.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

function jsonResult(value: Record<string, unknown>) {
  return ok(value, JSON.stringify(value))
}

export function registerActivityTools(
  server: Parameters<typeof defineTool>[0], ctx: ActorContext, deps: AppDeps,
): void {
  defineTool(server, {
    name: 'crm_activity_log',
    description: 'Log a timestamped interaction about visible records; use crm_note_add for an untimed note. external_ref updates the existing activity and last_activity_at stays monotonic. Returns the activity record. Fails NOT_FOUND for hidden targets or policy errors when create/link is not allowed.',
    input: CrmActivityLog.in.shape,
    handler: async (args) => {
      const result = await logActivity(deps, ctx, {
        kind: args.kind,
        occurredAt: args.occurred_at,
        subject: args.subject,
        body: args.body,
        direction: args.direction,
        participants: args.participants,
        about: args.about,
        externalRef: args.external_ref,
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      })
      return jsonResult({ record: result.record })
    },
  })

  defineTool(server, {
    name: 'crm_note_add',
    description: 'Attach an untimed markdown note to visible records; use crm_activity_log for a timestamped interaction. The note, links, and monotonic last_activity_at update are atomic. Returns the note record. Fails NOT_FOUND for hidden targets or policy errors when create/link is not allowed.',
    input: CrmNoteAdd.in.shape,
    handler: async (args) => {
      const result = await addNote(deps, ctx, {
        title: args.title,
        body: args.body,
        about: args.about,
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      })
      return jsonResult({ record: result.record })
    },
  })
}
