import {
  authenticate,
  parseAppRegistry,
  type AppRegistry,
} from '@deepcrm/mcp-inbound'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppDeps } from '../deps.js'
import type { Env } from '../env.js'
import { buildMcpServer, installTransportResultWrapper } from '../mcp/server.js'
import { buildActorContext } from '../services/context.js'
import {
  consumeSeenRequestId,
  expectedToolInvocation,
  recordPrincipalSeen,
  TokenVersionRegressionError,
} from '../services/principals.js'

const PROVISION_WINDOW_MS = 60_000
const PROVISION_LIMIT_PER_APP = 30
const MAX_TRACKED_APPS = 1_000

type ProvisionWindow = {
  count: number
  resetsAt: number
}

class ProvisioningRateLimiter {
  private readonly windows = new Map<string, ProvisionWindow>()

  allow(app: string, now: number): boolean {
    const current = this.windows.get(app)
    if (current === undefined || current.resetsAt <= now) {
      this.windows.delete(app)
      this.windows.set(app, { count: 1, resetsAt: now + PROVISION_WINDOW_MS })
      this.trim()
      return true
    }
    if (current.count >= PROVISION_LIMIT_PER_APP) return false
    current.count += 1
    this.windows.delete(app)
    this.windows.set(app, current)
    return true
  }

  private trim(): void {
    while (this.windows.size > MAX_TRACKED_APPS) {
      const oldest = this.windows.keys().next().value
      if (oldest === undefined) return
      this.windows.delete(oldest)
    }
  }
}

function registry(env: Env): AppRegistry {
  return parseAppRegistry(env.DEEPCRM_APPS ?? '{}')
}

function uoaIssuer(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

function unauthorized(reply: FastifyReply, env: Env): FastifyReply {
  const metadata = new URL('/.well-known/oauth-protected-resource', env.DEEPCRM_API_PUBLIC_URL)
  return reply
    .code(401)
    .header('WWW-Authenticate', `Bearer resource_metadata="${metadata.href}"`)
    .send({ error: 'unauthorized' })
}

async function isFirstContact(deps: AppDeps, externalTeamId: string): Promise<boolean> {
  const existing = await deps.db.team.findUnique({
    where: { externalTeamId },
    select: { id: true },
  })
  return existing === null
}

async function handleMcp(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AppDeps,
  env: Env,
  apps: AppRegistry,
  limiter: ProvisioningRateLimiter,
): Promise<void> {
  const requestId = request.id
  let invocation: ReturnType<typeof expectedToolInvocation> | undefined
  try {
    invocation = expectedToolInvocation(request.body)
  } catch {
    unauthorized(reply, env)
    return
  }
  const principalResult = await authenticate(request.headers, {
    requireAuth: env.REQUIRE_AUTH,
    directClients: env.DEEPCRM_DIRECT_CLIENTS,
    requestId,
    apps,
    uoa: {
      issuer: uoaIssuer(env.UOA_BASE_URL),
      audience: env.DEEPCRM_API_PUBLIC_URL,
      jwksUrl: new URL('/oauth/jwks.json', env.UOA_BASE_URL),
      now: deps.clock(),
    },
    contextAudience: env.DEEPCRM_API_PUBLIC_URL,
    expectedTool: invocation === undefined
      ? undefined
      : { tool: invocation.tool, argsSha256: invocation.argsSha256 },
  })
  if (!principalResult.ok) {
    unauthorized(reply, env)
    return
  }

  const principal = principalResult.principal
  if (
    await isFirstContact(deps, principal.uoaTeamId)
    && !limiter.allow(principal.app, deps.clock().getTime())
  ) {
    await reply.code(429).header('Retry-After', '60').send({ error: 'provisioning_rate_limited' })
    return
  }

  // buildActorContext is the single tenancy-resolution seam and provisions a
  // verified first-contact team before returning the request-scoped context.
  let ctx: Awaited<ReturnType<typeof buildActorContext>>
  try {
    ctx = await buildActorContext(deps, principal, requestId)
    await recordPrincipalSeen(deps.db, ctx, principal)
    if (
      env.REQUIRE_AUTH
      &&
      invocation?.destructive === true
      && !await consumeSeenRequestId(deps.db, ctx, invocation.tool, invocation.argsSha256)
    ) {
      unauthorized(reply, env)
      return
    }
  } catch (error) {
    if (error instanceof TokenVersionRegressionError) {
      unauthorized(reply, env)
      return
    }
    throw error
  }
  const server = buildMcpServer(ctx, deps)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  installTransportResultWrapper(transport, deps.version)
  try {
    await server.connect(transport)
    await transport.handleRequest(request.raw, reply.raw, request.body)
    reply.hijack()
  } finally {
    await server.close()
  }
}

export function registerMcpHttpPlugin(app: FastifyInstance, deps: AppDeps, env: Env): void {
  const apps = registry(env)
  const limiter = new ProvisioningRateLimiter()

  app.post('/mcp', async (request, reply) => {
    await handleMcp(request, reply, deps, env, apps, limiter)
  })
  app.get('/mcp', async (_request, reply) => {
    await reply.code(405).header('Allow', 'POST').send({ error: 'method_not_allowed' })
  })
  app.delete('/mcp', async (_request, reply) => {
    await reply.code(405).header('Allow', 'POST').send({ error: 'method_not_allowed' })
  })
}
