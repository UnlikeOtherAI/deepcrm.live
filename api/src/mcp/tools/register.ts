import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import {
  CallToolRequestSchema,
  ErrorCode as McpErrorCode,
  McpError,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'
import { z } from 'zod'
import { z as z4 } from 'zod/v4'
import { readMrtr, type MrtrInput } from './input-required.js'
import { toolError, type ToolLogger } from './result.js'

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

type ToolRuntime = {
  invoke(params: unknown, extra: ToolExtra): Promise<CallToolResult>
}

type RuntimeConfig = {
  requestId: string
  clock: () => number
  log: ToolLogger
  tools: Map<string, ToolRuntime>
  installed: boolean
}

const runtimes = new WeakMap<McpServer, RuntimeConfig>()

const MrtrCallToolRequestSchema = CallToolRequestSchema.extend({
  params: CallToolRequestSchema.shape.params.extend({
    inputResponses: z4.unknown().optional(),
    requestState: z4.unknown().optional(),
  }),
})

export type ToolRuntimeOptions = {
  requestId: string
  clock: () => number
  log: ToolLogger
}

export type ToolDefinition<Shape extends z.ZodRawShape> = {
  name: string
  description: string
  input: Shape
  handler: (
    args: z.output<z.ZodObject<Shape>>,
    mrtr: MrtrInput,
    extra: ToolExtra,
  ) => CallToolResult | Promise<CallToolResult>
}

function jsonPointer(path: Array<string | number>): string {
  if (path.length === 0) return ''
  return `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`
}

function invalidArguments(error: z.ZodError): ServiceError {
  return new ServiceError(ErrorCode.VALIDATION_FAILED, 'Tool arguments are invalid', {
    issues: error.issues.map((issue) => ({ path: jsonPointer(issue.path), message: issue.message })),
  })
}

function assertDiscoverableTool<Shape extends z.ZodRawShape>(
  definition: ToolDefinition<Shape>,
): void {
  if (definition.description.length > 300) {
    throw new Error(`Tool '${definition.name}' description exceeds 300 characters`)
  }
  const missingDescriptions = Object.entries(definition.input)
    .filter(([, field]) => (field.description?.trim().length ?? 0) === 0)
    .map(([name]) => name)
  if (missingDescriptions.length > 0) {
    throw new Error(
      `Tool '${definition.name}' input fields lack descriptions: ${missingDescriptions.join(', ')}`,
    )
  }
}

export function logToolEntry(entry: Parameters<ToolLogger>[0]): void {
  process.stderr.write(`${JSON.stringify({ event: 'mcp_tool', ...entry })}\n`)
}

export function configureToolRuntime(server: McpServer, options: ToolRuntimeOptions): void {
  if (runtimes.has(server)) throw new Error('Tool runtime is already configured')
  runtimes.set(server, { ...options, tools: new Map(), installed: false })
}

function runtimeFor(server: McpServer): RuntimeConfig {
  const runtime = runtimes.get(server)
  if (runtime === undefined) throw new Error('Tool runtime is not configured')
  return runtime
}

function installCallHandler(server: McpServer, runtime: RuntimeConfig): void {
  if (runtime.installed) return
  server.server.setRequestHandler(MrtrCallToolRequestSchema, async (request, extra) => {
    const tool = runtime.tools.get(request.params.name)
    if (tool === undefined) throw new McpError(McpErrorCode.InvalidParams, 'Tool not found')
    return tool.invoke({
      arguments: request.params.arguments,
      inputResponses: request.params.inputResponses,
      requestState: request.params.requestState,
      _meta: request.params._meta,
    }, extra)
  })
  runtime.installed = true
}

export function defineTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  definition: ToolDefinition<Shape>,
): void {
  assertDiscoverableTool(definition)
  const runtime = runtimeFor(server)
  const inputSchema = z.object(definition.input).strict()
  const tool: ToolRuntime = {
    async invoke(params, extra): Promise<CallToolResult> {
      const startedAt = runtime.clock()
      try {
        const unwrapped = readMrtr(params)
        const parsed = inputSchema.safeParse(unwrapped.arguments)
        if (!parsed.success) throw invalidArguments(parsed.error)
        const result = await definition.handler(parsed.data, {
          inputResponses: unwrapped.inputResponses,
          requestState: unwrapped.requestState,
        }, extra)
        runtime.log({
          level: 'info',
          tool: definition.name,
          requestId: runtime.requestId,
          durationMs: runtime.clock() - startedAt,
        })
        return result
      } catch (error) {
        return toolError(error, {
          tool: definition.name,
          requestId: runtime.requestId,
          durationMs: runtime.clock() - startedAt,
          log: runtime.log,
        })
      }
    },
  }
  runtime.tools.set(definition.name, tool)
  server.registerTool(definition.name, {
    description: definition.description,
    inputSchema,
  }, async (args, requestExtra) => {
    return tool.invoke({ arguments: args }, requestExtra)
  })
  installCallHandler(server, runtime)
}
