import { z } from 'zod'

import { Actor, IdempotencyKey, IsoDateTime, Reason, Uuid } from './primitives.js'
import { RecordOut } from './tools-records.js'

export const ActivityKind = z.enum([
  'email', 'call', 'meeting', 'note', 'message', 'task_event', 'custom',
])

export const CrmActivityLog = {
  in: z.object({
    kind: ActivityKind.describe('interaction kind'),
    occurred_at: IsoDateTime.describe('when the interaction occurred'),
    subject: z.string().max(300).optional().describe('one-line interaction summary'),
    body: z.string().max(100_000).optional().describe('interaction content or notes in markdown'),
    direction: z.enum(['inbound', 'outbound', 'internal']).optional()
      .describe('whether the interaction was inbound, outbound, or internal'),
    participants: z.array(Actor).max(50).optional().describe('humans and agents who participated'),
    about: z.array(Uuid).min(1).max(20).describe('visible record ids this interaction concerns'),
    external_ref: z.string().max(300).optional()
      .describe('source id; re-logging the same ref updates the existing activity'),
    reason: Reason,
    idempotency_key: IdempotencyKey,
  }),
  out: z.object({ record: RecordOut }),
}

export const CrmNoteAdd = {
  in: z.object({
    title: z.string().max(300).optional().describe('short note title'),
    body: z.string().min(1).max(100_000).describe('note body in markdown'),
    about: z.array(Uuid).min(1).max(20).describe('visible record ids this note concerns'),
    reason: Reason,
    idempotency_key: IdempotencyKey,
  }),
  out: z.object({ record: RecordOut }),
}
