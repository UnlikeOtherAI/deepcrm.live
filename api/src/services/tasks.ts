import { tenantWhere } from '@deepcrm/db'
import {
  ErrorCode,
  ServiceError,
  type Actor,
  type ActorContext,
  type Filter,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { checkPolicy } from './policy.js'
import { queryRecordsForTool, type RecordQueryResult } from './record-query.js'
import { standardRecordWrite } from './record-write-integration.js'
import { requireVisibleRecord } from './record-visibility.js'
import {
  createRecordWithIntegration,
  updateRecordWithIntegration,
  type RecordServiceResult,
} from './records.js'

export type CreateTaskInput = {
  title: string
  body?: string
  dueAt?: string
  assignee?: Actor
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  about?: string[]
  reason?: string
  idempotencyKey?: string
}

export type UpdateTaskInput = {
  id: string
  status?: 'open' | 'in_progress' | 'done' | 'cancelled'
  assignee?: Actor | null
  dueAt?: string | null
  priority?: 'low' | 'normal' | 'high' | 'urgent' | null
  title?: string
  body?: string | null
  expectedVersion?: number
  reason?: string
  idempotencyKey?: string
}

export type ListTasksInput = {
  status?: 'open' | 'in_progress' | 'done' | 'cancelled'
  assignee?: Actor
  dueBefore?: string
  dueAfter?: string
  about?: string
  cursor?: string
  limit?: number
}

type NormalizedList = Omit<ListTasksInput, 'limit'> & { limit: number }

function taskLinks(about: readonly string[] | undefined) {
  return about === undefined
    ? undefined
    : [...new Set(about)].map((toRecordId) => ({ relationType: 'task_about', toRecordId }))
}

function invalidList(path: string, message: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Task list input is invalid', {
    issues: [{ path, message }],
  })
}

function normalizedList(input: ListTasksInput): NormalizedList {
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    invalidList('/limit', 'Limit must be an integer from 1 to 200')
  }
  return { ...input, limit }
}

function filterFor(input: NormalizedList): Filter | undefined {
  const filters: Filter[] = []
  if (input.status !== undefined) {
    filters.push({ attribute: 'status', op: 'eq', value: input.status })
  }
  if (input.assignee !== undefined) {
    filters.push({ attribute: 'assignee', op: 'eq', value: input.assignee })
  }
  if (input.dueBefore !== undefined) {
    filters.push({ attribute: 'due_at', op: 'lte', value: input.dueBefore })
  }
  if (input.dueAfter !== undefined) {
    filters.push({ attribute: 'due_at', op: 'gte', value: input.dueAfter })
  }
  if (input.about !== undefined) {
    filters.push({
      linked_to: { relation: 'task_about', record_id: input.about, direction: 'from' },
    })
  }
  if (filters.length === 0) return undefined
  const first = filters[0]
  if (filters.length === 1 && first !== undefined) return first
  return { and: filters }
}

async function requireLiveTask(deps: AppDeps, ctx: ActorContext, id: string): Promise<void> {
  await requireVisibleRecord(deps.db, ctx, id)
  const task = await deps.db.record.findFirst({
    where: {
      ...tenantWhere(ctx.tenant), id, deletedAt: null, mergedIntoId: null, erasedAt: null,
      objectType: { slug: 'task', archivedAt: null },
    },
    select: { id: true },
  })
  if (task === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Task not found')
}

async function writeListDeniedAudit(
  deps: AppDeps, ctx: ActorContext, recordId: string,
): Promise<void> {
  await deps.db.$transaction((tx) => deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: 'crm_tasks_list',
    resourceType: 'record',
    resourceId: recordId,
    outcome: 'denied',
    reason: null,
    metadata: { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance },
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  }))
}

async function requireReadableAbout(
  deps: AppDeps, ctx: ActorContext, recordId: string,
): Promise<void> {
  const record = await requireVisibleRecord(deps.db, ctx, recordId)
  const live = await deps.db.record.findFirst({
    where: {
      ...tenantWhere(ctx.tenant), id: record.id,
      deletedAt: null, mergedIntoId: null, erasedAt: null,
    },
    select: { id: true },
  })
  if (live === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const decision = await checkPolicy(deps.db, ctx, {
    resourceType: 'record', action: 'view',
    scopes: [
      { scope: 'team', id: ctx.tenant.teamId },
      { scope: 'object_type', id: record.objectTypeId },
      { scope: 'record', id: record.id },
    ],
  })
  if (decision.allowed && !decision.requiresApproval) return
  await writeListDeniedAudit(deps, ctx, record.id)
  throw new ServiceError(
    decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Task list is not permitted', { resource: 'record', action: 'view' },
  )
}

export function createTask(
  deps: AppDeps, ctx: ActorContext, input: CreateTaskInput,
): Promise<RecordServiceResult> {
  return createRecordWithIntegration(deps, ctx, {
    objectType: 'task',
    data: {
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.dueAt === undefined ? {} : { due_at: input.dueAt }),
      ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
    },
    links: taskLinks(input.about),
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  }, standardRecordWrite('crm_task_create'))
}

export async function updateTask(
  deps: AppDeps, ctx: ActorContext, input: UpdateTaskInput,
): Promise<RecordServiceResult> {
  await requireLiveTask(deps, ctx, input.id)
  const data: Record<string, unknown> = {}
  if (input.status !== undefined) data['status'] = input.status
  if (input.assignee !== undefined) data['assignee'] = input.assignee
  if (input.dueAt !== undefined) data['due_at'] = input.dueAt
  if (input.priority !== undefined) data['priority'] = input.priority
  if (input.title !== undefined) data['title'] = input.title
  if (input.body !== undefined) data['body'] = input.body
  if (Object.keys(data).length === 0) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Task update has no changes')
  }
  return updateRecordWithIntegration(deps, ctx, {
    recordId: input.id,
    data,
    expectedVersion: input.expectedVersion,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  }, standardRecordWrite('crm_task_update'))
}

export async function listTasks(
  deps: AppDeps, ctx: ActorContext, input: ListTasksInput,
): Promise<RecordQueryResult> {
  const normalized = normalizedList(input)
  if (normalized.about !== undefined) {
    await requireReadableAbout(deps, ctx, normalized.about)
  }
  return queryRecordsForTool(deps, ctx, {
    objectType: 'task', filter: filterFor(normalized), cursor: normalized.cursor, limit: normalized.limit,
  }, {
    tool: 'crm_tasks_list',
    cursorArguments: (query) => ({
      status: normalized.status ?? null,
      assignee: normalized.assignee ?? null,
      due_before: normalized.dueBefore ?? null,
      due_after: normalized.dueAfter ?? null,
      about: normalized.about ?? null,
      limit: normalized.limit,
      sort: query.sort,
    }),
  })
}
