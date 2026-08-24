import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CancelTaskRequestSchema,
  ErrorCode as McpErrorCode,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { ErrorCode, isServiceError, TaskIdInput, type ActorContext } from '@deepcrm/schemas'
import { z as z4 } from 'zod/v4'

import type { AppDeps } from '../deps.js'
import {
  cancelQueueTask,
  getQueueTask,
  getQueueTaskResult,
} from '../services/queue-tasks.js'
import { ok } from './tools/result.js'

const TasksUpdateRequestSchema = z4.object({
  method: z4.literal('tasks/update'),
  params: z4.looseObject({}).optional(),
})

function taskId(value: unknown): string {
  const parsed = TaskIdInput.safeParse(value)
  if (!parsed.success) {
    throw new McpError(McpErrorCode.InvalidParams, 'Invalid task request', {
      code: ErrorCode.VALIDATION_FAILED,
    })
  }
  return parsed.data.taskId
}

function protocolError(error: unknown): never {
  if (isServiceError(error)) {
    throw new McpError(McpErrorCode.InvalidParams, error.message, {
      code: error.code,
      ...error.details,
    })
  }
  throw new McpError(McpErrorCode.InternalError, 'Task request failed', {
    code: ErrorCode.INTERNAL,
  })
}

export function registerTaskMethods(server: McpServer, ctx: ActorContext, deps: AppDeps): void {
  server.server.setRequestHandler(GetTaskRequestSchema, async (request) => {
    try {
      return await getQueueTask(deps, ctx, taskId({ taskId: request.params.taskId }))
    } catch (error) {
      return protocolError(error)
    }
  })
  server.server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
    try {
      return await cancelQueueTask(deps, ctx, taskId({ taskId: request.params.taskId }))
    } catch (error) {
      return protocolError(error)
    }
  })
  server.server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
    try {
      const result = await getQueueTaskResult(deps, ctx, taskId({ taskId: request.params.taskId }))
      return ok(result, JSON.stringify(result))
    } catch (error) {
      return protocolError(error)
    }
  })
  server.server.setRequestHandler(TasksUpdateRequestSchema, async () => {
    throw new McpError(McpErrorCode.MethodNotFound, 'Method not found')
  })
}
