import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import { canonicalJson, dropTenant } from '@deepcrm/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { buildApp } from '../../src/app.js'
import { createAppDeps } from '../../src/deps.js'
import { parseEnv } from '../../src/env.js'

// End to end through the real inbound auth (REQUIRE_AUTH=true): a Nessie app
// key, a UOA delegation and an X-Nessie-Context, each verified against a JWKS
// this test serves. A Nessie agent holds no DeepCRM binding of its own; the
// seeded agent:nessie:* wildcard lets it act exactly as the member it acts for.

const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSIsImV4cG9ydCI6IkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUU9In19'
const AUDIENCE = 'https://api.deepcrm.test'
const CONTEXT_ISSUER = 'https://nessie.test'
const SOURCE_DOMAIN = 'api.nessie.test'
const APP_KEY = `dck_test_${randomUUID()}`
const MEMBER = `usr_member_${randomUUID()}`
const AGENT_ID = 'agent_nessie_e2e'
const ORG = `org_${randomUUID()}`
const TEAM = `team_${randomUUID()}`

type SigningKey = { privateKey: KeyObject; jwk: Record<string, unknown> }

function signingKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } }
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function jwt(key: SigningKey, payload: Record<string, unknown>): string {
  const signingInput = `${base64url({ alg: 'RS256', typ: 'JWT', kid: key.jwk['kid'] })}.${base64url(payload)}`
  return `${signingInput}.${sign('sha256', Buffer.from(signingInput, 'utf8'), key.privateKey).toString('base64url')}`
}

const uoaKey = signingKey('uoa-e2e')
const contextKey = signingKey('context-e2e')
let jwks: Server
let uoaIssuer: string
let app: ReturnType<typeof buildApp>
let deps: ReturnType<typeof createAppDeps>
let mcpUrl: URL

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP auth tests')
  jwks = createServer((request, response) => {
    const keys = request.url === '/oauth/jwks.json' ? [uoaKey.jwk]
      : request.url === '/context/jwks.json' ? [contextKey.jwk] : undefined
    response.writeHead(keys === undefined ? 404 : 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(keys === undefined ? {} : { keys }))
  })
  await new Promise<void>((resolve) => { jwks.listen(0, '127.0.0.1', resolve) })
  const jwksAddress = jwks.address()
  if (jwksAddress === null || typeof jwksAddress === 'string') throw new Error('Expected a TCP JWKS address')
  uoaIssuer = `http://127.0.0.1:${jwksAddress.port}`
  const env = parseEnv({
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    REQUIRE_AUTH: 'true',
    DEEPCRM_API_PUBLIC_URL: AUDIENCE,
    UOA_BASE_URL: uoaIssuer,
    DEEPCRM_SECRET_KEYRING_B64: keyring,
    DEEPCRM_APPS: JSON.stringify({
      nessie: {
        keyHashes: [createHash('sha256').update(APP_KEY, 'utf8').digest('hex')],
        contextJwksUrl: `${uoaIssuer}/context/jwks.json`,
        contextIssuer: CONTEXT_ISSUER,
        sourceDomain: SOURCE_DOMAIN,
        product: 'nessie',
      },
    }),
  })
  deps = createAppDeps(env)
  app = buildApp(deps, env)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP test address')
  mcpUrl = new URL(`http://127.0.0.1:${address.port}/mcp`)
})

afterAll(async () => {
  const organization = await deps.db.organization.findUnique({ where: { externalOrgId: ORG } })
  if (organization !== null) await dropTenant(deps.db, organization.id)
  await app.close()
  await deps.db.$disconnect()
  await new Promise<void>((resolve) => { jwks.close(() => resolve()) })
})

const Envelope = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.record(z.unknown()).optional(),
  }).passthrough(),
})

async function readEnvelope(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) return JSON.parse(text)
  const data = text.split('\n').find((line) => line.startsWith('data: '))
  if (data === undefined) throw new Error('SSE response carried no data line')
  return JSON.parse(data.slice('data: '.length))
}

/** One `tools/call` with a fresh delegation and a context bound to it, the tool and the arguments. */
async function callTool(
  name: string, args: Record<string, unknown>, context: Record<string, unknown>,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1_000)
  const jti = randomUUID()
  const delegation = jwt(uoaKey, {
    iss: uoaIssuer, aud: AUDIENCE, sub: MEMBER, iat: now, exp: now + 300, jti,
    org: { org_id: ORG, team_roles: { [TEAM]: 'member' } },
    active: { orgId: ORG, teamId: TEAM },
    source_domain: SOURCE_DOMAIN, azp: SOURCE_DOMAIN, product: 'nessie', scope: 'openid ai.invoke',
  })
  const proof = jwt(contextKey, {
    iss: CONTEXT_ISSUER, aud: AUDIENCE, sub: MEMBER, iat: now, exp: now + 300,
    requestId: randomUUID(), delegation_jti: jti, tool: name,
    args_sha256: createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex'),
    ...context,
  })
  return fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25',
      Authorization: `Bearer ${APP_KEY}`,
      'X-UOA-Delegation': delegation,
      'X-Nessie-Context': proof,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
}

async function succeeded(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200)
  const envelope = Envelope.parse(await readEnvelope(response))
  expect(envelope.result.isError, JSON.stringify(envelope.result.structuredContent)).not.toBe(true)
  return envelope.result.structuredContent ?? {}
}

const agentContext = { agentId: AGENT_ID, runId: 'run_e2e', toolCallId: 'tool_call_e2e' }
const RecordResult = z.object({ record: z.object({ id: z.string().uuid() }) })

describe('a Nessie agent context through the real inbound auth', () => {
  it('writes and reads as the member it acts for, and a human context reads the same record', async () => {
    const created = RecordResult.parse(await succeeded(await callTool('crm_record_create', {
      object_type: 'note', data: { body: 'Written by a Nessie agent for a member.' },
    }, agentContext)))
    const recordId = created.record.id

    const asAgent = RecordResult.parse(await succeeded(await callTool('crm_record_get', { id: recordId }, agentContext)))
    expect(asAgent.record.id).toBe(recordId)
    const asHuman = RecordResult.parse(await succeeded(await callTool('crm_record_get', { id: recordId }, {
      actor: 'human',
    })))
    expect(asHuman.record.id).toBe(recordId)

    await expect(deps.db.recordChange.findFirstOrThrow({
      where: { recordId, kind: 'create' },
      select: { actorType: true, actorId: true, onBehalfOf: true, runId: true, toolCallId: true },
    })).resolves.toEqual({
      actorType: 'agent', actorId: AGENT_ID, onBehalfOf: MEMBER, runId: 'run_e2e', toolCallId: 'tool_call_e2e',
    })
  })

  it('refuses a context that names an agent while claiming a human actor', async () => {
    const response = await callTool('crm_record_get', { id: randomUUID() }, { actor: 'human', ...agentContext })
    expect(response.status).toBe(401)
  })
})
