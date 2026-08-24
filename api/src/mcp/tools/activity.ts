import {
  CrmActivityLog, CrmNoteAdd, CrmTaskCreate, CrmTasksList, CrmTaskUpdate,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { addNote, logActivity } from '../../services/activity.js'
import { createTask, listTasks, updateTask } from '../../services/tasks.js'
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

  defineTool(server, {
    name: 'crm_task_create',
    description: 'Create a task, optionally assigned and atomically linked to visible records. Use crm_note_add for information with no action. Returns the task record with applied defaults. Fails NOT_FOUND for hidden about records or policy errors when create/link is not allowed.',
    input: CrmTaskCreate.in.shape,
    handler: async (args) => {
      const result = await createTask(deps, ctx, {
        title: args.title,
        body: args.body,
        dueAt: args.due_at,
        assignee: args.assignee,
        priority: args.priority,
        about: args.about,
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      })
      return jsonResult({ record: result.record })
    },
  })

  defineTool(server, {
    name: 'crm_task_update',
    description: 'Patch a visible active task; null clears nullable fields. Use expected_version to prevent stale writes. Returns the updated task record. Fails NOT_FOUND for non-task or hidden records, VERSION_CONFLICT for stale versions, and policy errors when edit is not allowed.',
    input: CrmTaskUpdate.in.shape,
    handler: async (args) => {
      const result = await updateTask(deps, ctx, {
        id: args.id,
        status: args.status,
        assignee: args.assignee,
        dueAt: args.due_at,
        priority: args.priority,
        title: args.title,
        body: args.body,
        expectedVersion: args.expected_version,
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      })
      return jsonResult({ record: result.record })
    },
  })

  defineTool(server, {
    name: 'crm_tasks_list',
    description: 'List visible tasks by exact status or assignee, inclusive due window, and optional visible about record. Use crm_records_query for custom task filters. Returns a redacted page and opaque cursor. Fails NOT_FOUND for a hidden about record or VALIDATION_FAILED for cursor mismatch.',
    input: CrmTasksList.in.shape,
    handler: async (args) => jsonResult(await listTasks(deps, ctx, {
      status: args.status,
      assignee: args.assignee,
      dueBefore: args.due_before,
      dueAfter: args.due_after,
      about: args.about,
      cursor: args.cursor,
      limit: args.limit,
    })),
  })
}
