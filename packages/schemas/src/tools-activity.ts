import { z } from 'zod'

import {
  Actor, Cursor, ExpectedVersion, IdempotencyKey, IsoDateTime, Limit, Reason, Uuid,
} from './primitives.js'
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

export const TaskStatus = z.enum(['open', 'in_progress', 'done', 'cancelled'])
export const TaskPriority = z.enum(['low', 'normal', 'high', 'urgent'])
const TaskTitle = z.string().min(1).max(300)
const TaskBody = z.string().max(100_000)

export const CrmTaskCreate = {
  in: z.object({
    title: TaskTitle.describe('task title describing the required outcome'),
    body: TaskBody.optional().describe('optional task details in markdown'),
    due_at: IsoDateTime.optional().describe('optional task deadline'),
    assignee: Actor.optional().describe('human or agent responsible for the task'),
    priority: TaskPriority.optional().describe('task urgency; defaults to normal'),
    about: z.array(Uuid).min(1).max(20).optional()
      .describe('visible record ids linked atomically through task_about'),
    reason: Reason,
    idempotency_key: IdempotencyKey,
  }).strict(),
  out: z.object({ record: RecordOut }).strict(),
}

export const CrmTaskUpdate = {
  in: z.object({
    id: Uuid.describe('visible active task record id'),
    status: TaskStatus.optional().describe('replacement task state'),
    assignee: Actor.nullable().optional().describe('replacement assignee; null clears it'),
    due_at: IsoDateTime.nullable().optional().describe('replacement deadline; null clears it'),
    priority: TaskPriority.nullable().optional().describe('replacement priority; null clears it'),
    title: TaskTitle.optional().describe('replacement task title'),
    body: TaskBody.nullable().optional().describe('replacement markdown details; null clears them'),
    expected_version: ExpectedVersion,
    reason: Reason,
    idempotency_key: IdempotencyKey,
  }).strict(),
  out: z.object({ record: RecordOut }).strict(),
}

export const CrmTasksList = {
  in: z.object({
    status: TaskStatus.optional().describe('exact task state to include'),
    assignee: Actor.optional().describe('exact canonical human or agent assignee to include'),
    due_before: IsoDateTime.optional().describe('include tasks due at or before this timestamp'),
    due_after: IsoDateTime.optional().describe('include tasks due at or after this timestamp'),
    about: Uuid.optional().describe('visible record id linked from matching tasks through task_about'),
    cursor: Cursor,
    limit: Limit,
  }).strict(),
  out: z.object({ records: z.array(RecordOut), next_cursor: z.string().nullable() }).strict(),
}
