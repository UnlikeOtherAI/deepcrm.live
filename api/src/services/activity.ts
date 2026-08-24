import {
  ErrorCode,
  ServiceError,
  type Actor,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import type { RecordWriteIntegration } from './record-write-integration.js'
import {
  assertRecordWithIntegration,
  createRecordWithIntegration,
  type RecordServiceResult,
} from './records.js'

export type LogActivityInput = {
  kind: 'email' | 'call' | 'meeting' | 'note' | 'message' | 'task_event' | 'custom'
  occurredAt: string
  subject?: string
  body?: string
  direction?: 'inbound' | 'outbound' | 'internal'
  participants?: Actor[]
  about: string[]
  externalRef?: string
  reason?: string
  idempotencyKey?: string
}

export type AddNoteInput = {
  title?: string
  body: string
  about: string[]
  reason?: string
  idempotencyKey?: string
}

function aboutLinks(relationType: 'activity_about' | 'note_about', about: readonly string[]) {
  return [...new Set(about)].map((toRecordId) => ({ relationType, toRecordId }))
}

function activityWrite(
  ctx: ActorContext,
  tool: 'crm_activity_log' | 'crm_note_add',
  about: readonly string[],
  occurredAt: Date,
): RecordWriteIntegration {
  const recordIds = [...new Set(about)]
  return {
    tool,
    afterWrite: async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE records
        SET last_activity_at = GREATEST(COALESCE(last_activity_at, ${occurredAt}), ${occurredAt})
        WHERE organization_id = ${ctx.tenant.organizationId}::uuid
          AND team_id = ${ctx.tenant.teamId}::uuid
          AND id = ANY(${recordIds}::uuid[])
          AND deleted_at IS NULL
          AND merged_into_id IS NULL
          AND erased_at IS NULL
      `
      if (updated !== recordIds.length) {
        throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
      }
    },
  }
}

export function logActivity(
  deps: AppDeps,
  ctx: ActorContext,
  input: LogActivityInput,
): Promise<RecordServiceResult> {
  const data = {
    kind: input.kind,
    occurred_at: input.occurredAt,
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.direction === undefined ? {} : { direction: input.direction }),
    ...(input.participants === undefined ? {} : { participants: input.participants }),
    ...(input.externalRef === undefined ? {} : { external_ref: input.externalRef }),
  }
  const common = {
    objectType: 'activity',
    data,
    links: aboutLinks('activity_about', input.about),
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  }
  const integration = activityWrite(ctx, 'crm_activity_log', input.about, new Date(input.occurredAt))
  return input.externalRef === undefined
    ? createRecordWithIntegration(deps, ctx, common, integration)
    : assertRecordWithIntegration(
      deps,
      ctx,
      { ...common, matchAttribute: 'external_ref' },
      integration,
    )
}

export function addNote(
  deps: AppDeps,
  ctx: ActorContext,
  input: AddNoteInput,
): Promise<RecordServiceResult> {
  return createRecordWithIntegration(deps, ctx, {
    objectType: 'note',
    data: {
      body: input.body,
      ...(input.title === undefined ? {} : { title: input.title }),
    },
    links: aboutLinks('note_about', input.about),
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  }, activityWrite(ctx, 'crm_note_add', input.about, ctx.now))
}
