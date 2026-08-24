import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AnyObjectSchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Notification,
  type Request,
  type Result,
  type ServerNotification,
  type ServerRequest,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { ActorContext } from '@deepcrm/schemas'
import { z } from 'zod'
import type { AppDeps } from '../deps.js'
import { registerResources } from './resources.js'
import { registerSchemaTools } from './tools/schema.js'
import { configureToolRuntime, logToolEntry } from './tools/register.js'

const PROTOCOL_VERSION = '2026-07-28'
const CACHE_TTL_MS = 300_000
const MAX_FILTER_NODES = 100
const MAX_PAGE_ROWS = 200

const ServerDiscoverRequestSchema = z.object({
  method: z.literal('server/discover'),
  params: z.object({}).optional(),
})

type Handler<T extends AnyObjectSchema> = (
  request: SchemaOutput<T>,
  extra: RequestHandlerExtra<ServerRequest | Request, ServerNotification | Notification>,
) => ServerResult | Result | Promise<ServerResult | Result>

function serverMeta(version: string): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/serverInfo': { name: 'deepcrm', version },
  }
}

const CACHEABLE_SCHEMAS: ReadonlySet<object> = new Set([
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
])

function decorateResult(
  result: ServerResult | Result,
  version: string,
  cacheable: boolean,
  toolList: boolean,
): ServerResult | Result {
  const taskShaped = 'taskId' in result
  const hasResultType = 'resultType' in result && result.resultType !== undefined
  const resultType = !hasResultType && !taskShaped
    ? { resultType: 'complete' }
    : {}
  const cache = cacheable
    ? { ttlMs: CACHE_TTL_MS, cacheScope: 'private' }
    : {}
  const etag = toolList ? { 'live.deepcrm/etag': version } : {}
  return {
    ...result,
    ...resultType,
    ...cache,
    _meta: {
      ...result._meta,
      ...serverMeta(version),
      ...etag,
    },
  }
}

function installResultWrappers(server: McpServer, version: string): void {
  const protocol = server.server
  const setRequestHandler = protocol.setRequestHandler.bind(protocol)

  // SDK 1.30 exposes result interception at the low-level Server handler seam.
  // Wrapping registration keeps McpServer's registries authoritative while
  // adding 2026-07-28 result metadata. The five list/read methods carry their
  // cache fields at result top level because SDK 1.30 has no list-result options.
  protocol.setRequestHandler = <T extends AnyObjectSchema>(
    schema: T,
    handler: Handler<T>,
  ): void => {
    setRequestHandler(schema, async (request, extra) => (
      decorateResult(
        await handler(request, extra),
        version,
        CACHEABLE_SCHEMAS.has(schema),
        Object.is(schema, ListToolsRequestSchema),
      )
    ))
  }
}

export function installTransportResultWrapper(transport: Transport, version: string): void {
  const send = transport.send.bind(transport)

  // Server installs initialize and ping handlers in its constructor, before
  // installResultWrappers can intercept handler registration. The transport
  // seam covers those built-ins and safely re-applies decoration to later
  // handlers without removing cache, task, or MRTR fields already present.
  transport.send = async (message, options): Promise<void> => {
    if (!('result' in message)) {
      await send(message, options)
      return
    }
    await send({
      ...message,
      result: decorateResult(message.result, version, false, false),
    }, options)
  }
}

export function buildMcpServer(ctx: ActorContext, deps: AppDeps): McpServer {
  const server = new McpServer(
    { name: 'deepcrm', version: deps.version },
    {
      capabilities: {
        extensions: { 'io.modelcontextprotocol/tasks': {} },
      },
    },
  )
  installResultWrappers(server, deps.version)
  configureToolRuntime(server, {
    requestId: ctx.requestId,
    clock: () => deps.clock().getTime(),
    log: logToolEntry,
  })

  // Initialises the SDK's tools/list and tools/call handlers without exposing
  // a placeholder capability. T22+ registers real tools into this same registry.
  const bootstrap = server.registerTool('deepcrm-internal-bootstrap', {
    description: 'Internal disabled registration used to initialise the MCP tool registry.',
  }, async () => ({ content: [] }))
  bootstrap.disable()
  registerSchemaTools(server, ctx, deps)
  registerResources(server, ctx, deps)

  server.server.setRequestHandler(ServerDiscoverRequestSchema, async () => {
    const result = {
      protocolVersions: [PROTOCOL_VERSION],
      capabilities: {
        tools: {},
        extensions: { 'io.modelcontextprotocol/tasks': {} },
      },
      serverInfo: { name: 'deepcrm', version: deps.version },
      limits: {
        maxBulkRows: deps.maxBulkRows,
        maxFilterNodes: MAX_FILTER_NODES,
        maxPageRows: MAX_PAGE_ROWS,
      },
      resultType: 'complete',
      _meta: serverMeta(deps.version),
    }
    return result
  })

  return server
}
