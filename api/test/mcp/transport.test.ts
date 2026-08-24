import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { createAppDeps } from '../../src/deps.js'
import { parseEnv } from '../../src/env.js'
import { startTestServer } from './harness.js'

const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSJ9fQ=='
const DiscoverResultSchema = z.object({
  protocolVersions: z.array(z.string()),
  capabilities: z.object({
    tasks: z.object({
      cancel: z.record(z.unknown()),
      requests: z.object({ tools: z.object({ call: z.record(z.unknown()) }) }),
    }),
    extensions: z.record(z.unknown()),
  }).passthrough(),
  serverInfo: z.object({ name: z.string(), version: z.string() }),
  limits: z.object({
    maxBulkRows: z.number(),
    maxFilterNodes: z.number(),
    maxPageRows: z.number(),
  }),
  resultType: z.literal('complete'),
  _meta: z.record(z.unknown()),
}).passthrough()

let client: Client
let serverUrl: URL
let closeServer: () => Promise<void>

async function readSseEnvelope(response: Response): Promise<unknown> {
  const payload = await response.text()
  const dataLine = payload.split('\n').find((line) => line.startsWith('data: '))
  if (dataLine === undefined) throw new Error('Expected an MCP SSE data frame')
  return JSON.parse(dataLine.slice('data: '.length))
}

beforeAll(async () => {
  const started = await startTestServer()
  client = started.client
  serverUrl = started.url
  closeServer = started.close
})

afterAll(async () => {
  await closeServer()
})

describe('streamable HTTP MCP transport', () => {
  it('lists tools through the SDK client', async () => {
    const result = await client.listTools()
    expect(Array.isArray(result.tools)).toBe(true)
  })

  it('decorates constructor-installed initialize and ping results on the wire', async () => {
    const headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25',
    }
    const initialize = await fetch(serverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'wire-test', version: '0.0.0' },
        },
      }),
    })
    expect(initialize.status).toBe(200)
    expect(await readSseEnvelope(initialize)).toMatchObject({
      result: {
        resultType: 'complete',
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: 'deepcrm', version: '0.0.0' },
        },
      },
    })

    const ping = await fetch(serverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }),
    })
    expect(ping.status).toBe(200)
    expect(await readSseEnvelope(ping)).toMatchObject({
      result: {
        resultType: 'complete',
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: 'deepcrm', version: '0.0.0' },
        },
      },
    })
  })

  it('answers server/discover with the normative protocol and limits', async () => {
    const result = await client.request({ method: 'server/discover' }, DiscoverResultSchema)
    expect(result).toMatchObject({
      protocolVersions: ['2026-07-28'],
      serverInfo: { name: 'deepcrm', version: '0.0.0' },
      resultType: 'complete',
      limits: { maxBulkRows: 10_000, maxFilterNodes: 100, maxPageRows: 200 },
    })
    expect(result.capabilities.extensions).toHaveProperty('io.modelcontextprotocol/tasks')
    expect(result.capabilities.tasks).toEqual({
      cancel: {}, requests: { tools: { call: {} } },
    })
    expect(result._meta).toMatchObject({
      'io.modelcontextprotocol/serverInfo': { name: 'deepcrm', version: '0.0.0' },
    })
  })

  it('puts private cache hints on tools/list at the wire boundary', async () => {
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
    })
    expect(response.status).toBe(200)
    const envelope = await readSseEnvelope(response)
    expect(envelope).toMatchObject({
      result: {
        resultType: 'complete',
        ttlMs: 300_000,
        cacheScope: 'private',
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: 'deepcrm', version: '0.0.0' },
          'live.deepcrm/etag': '0.0.0',
        },
      },
    })
  })

  it('rejects unauthenticated requests with RFC 9728 discovery metadata', async () => {
    const env = parseEnv({
      DATABASE_URL: 'postgresql://unused',
      NODE_ENV: 'test',
      REQUIRE_AUTH: 'true',
      DEEPCRM_API_PUBLIC_URL: 'https://api.deepcrm.live',
      DEEPCRM_SECRET_KEYRING_B64: keyring,
    })
    const deps = createAppDeps(env)
    const app = buildApp(deps, env)
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })

    expect(response.statusCode).toBe(401)
    expect(response.headers['www-authenticate']).toBe(
      'Bearer resource_metadata="https://api.deepcrm.live/.well-known/oauth-protected-resource"',
    )
    await app.close()
    await deps.db.$disconnect()
  })

  it('returns 405 for stateful transport methods', async () => {
    const [getResponse, deleteResponse] = await Promise.all([
      fetch(serverUrl),
      fetch(serverUrl, { method: 'DELETE' }),
    ])
    expect(getResponse.status).toBe(405)
    expect(deleteResponse.status).toBe(405)
  })

  it('serves protected-resource metadata from configured origins', async () => {
    const databaseUrl = process.env.DATABASE_URL
    if (databaseUrl === undefined) throw new Error('DATABASE_URL is required')
    const env = parseEnv({
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'test',
      DEEPCRM_API_PUBLIC_URL: 'http://127.0.0.1:5656',
      UOA_BASE_URL: 'https://authentication.unlikeotherai.com',
      DEEPCRM_SECRET_KEYRING_B64: keyring,
    })
    const deps = createAppDeps(env)
    const app = buildApp(deps, env)
    const response = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })
    expect(response.json()).toEqual({
      resource: 'http://127.0.0.1:5656',
      authorization_servers: ['https://authentication.unlikeotherai.com'],
      bearer_methods_supported: ['header'],
    })
    await app.close()
    await deps.db.$disconnect()
  })
})
