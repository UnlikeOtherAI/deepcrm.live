import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  ErrorCode,
  isServiceError,
  McpTask,
  type ErrorCodeValue,
} from '@deepcrm/schemas'

export type ToolLogEntry = {
  level: 'info' | 'error'
  tool: string
  requestId: string
  durationMs: number
  code?: ErrorCodeValue
}

export type ToolLogger = (entry: ToolLogEntry) => void

export type ToolErrorContext = {
  tool: string
  requestId: string
  durationMs: number
  log: ToolLogger
}

function nextHint(code: ErrorCodeValue): 'retry_with_approval' | 'fetch_and_retry' | 'use_redirect' | 'fix_input' | 'fatal' {
  switch (code) {
    case ErrorCode.APPROVAL_REQUIRED:
      return 'retry_with_approval'
    case ErrorCode.VERSION_CONFLICT:
    case ErrorCode.DUPLICATE_FOUND:
    case ErrorCode.SCHEMA_CONFLICT:
    case ErrorCode.IDEMPOTENCY_IN_PROGRESS:
    case ErrorCode.TENANT_REPARENTING:
      return 'fetch_and_retry'
    case ErrorCode.MERGED:
      return 'use_redirect'
    case ErrorCode.UNKNOWN_OBJECT_TYPE:
    case ErrorCode.UNKNOWN_ATTRIBUTE:
    case ErrorCode.ATTRIBUTE_ARCHIVED:
    case ErrorCode.ATTRIBUTE_READ_ONLY:
    case ErrorCode.VALIDATION_FAILED:
    case ErrorCode.IDEMPOTENCY_MISMATCH:
    case ErrorCode.UNKNOWN_TEMPLATE:
    case ErrorCode.ORIGIN_REJECTED:
    case ErrorCode.VISIBILITY_REJECTED:
    case ErrorCode.LIMIT_EXCEEDED:
      return 'fix_input'
    default:
      return 'fatal'
  }
}

export function ok<T extends Record<string, unknown>>(structured: T, summary: string): CallToolResult {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: structured,
  }
}

export function taskCreated(
  task: ReturnType<typeof McpTask.parse>,
): CallToolResult & { task: ReturnType<typeof McpTask.parse> } {
  const parsed = McpTask.parse(task)
  return {
    task: parsed,
    content: [{
      type: 'text',
      text: `Task ${parsed.taskId} started; poll tasks/get with taskId and read tasks/result when completed.`,
    }],
    structuredContent: { task: parsed },
  }
}

export function toolError(error: unknown, context: ToolErrorContext): CallToolResult {
  const serviceError = isServiceError(error)
    ? error
    : {
        code: ErrorCode.INTERNAL,
        message: 'An internal error occurred',
        details: { correlation_id: context.requestId },
      }
  context.log({
    level: isServiceError(error) ? 'info' : 'error',
    tool: context.tool,
    requestId: context.requestId,
    durationMs: context.durationMs,
    code: serviceError.code,
  })
  const structuredContent = {
    ...serviceError.details,
    code: serviceError.code,
    message: serviceError.message,
    next: nextHint(serviceError.code),
  }
  return {
    isError: true,
    content: [{ type: 'text', text: `${serviceError.code}: ${serviceError.message}` }],
    structuredContent,
  }
}
