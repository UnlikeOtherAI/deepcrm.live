import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import { canonicalJson, dropTenant, seedTenant } from '@deepcrm/db'
import { applyTemplate } from '@deepcrm/schema-engine'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { buildApp } from '../../src/app.js'
import { createAppDeps } from '../../src/deps.js'
import { parseEnv } from '../../src/env.js'
import { seedDefaultPolicies } from '../../src/services/policy.js'

// The data subject's own act through the real inbound auth (REQUIRE_AUTH=true):
// a Nessie app key and an `actor: "subject"` context, no UOA delegation. The
// registry's subjectTools allowlists the two consent tools; nothing else runs.

// Postgres-backed writes on a shared, loaded host take seconds each.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSIsImV4cG9ydCI6IkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUU9In19'
const AUDIENCE = 'https://api.deepcrm.test'
const CONTEXT_ISSUER = 'https://nessie.test'
const APP_KEY = `dck_test_${randomUUID()}`

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

const contextKey = signingKey('context-subject')
let jwks: Server
let app: ReturnType<typeof buildApp>
let deps: ReturnType<typeof createAppDeps>
let mcpUrl: URL
let tenant: Awaited<ReturnType<typeof seedTenant>>

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP subject tests')
  jwks = createServer((request, response) => {
    const found = request.url === '/context/jwks.json'
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(found ? { keys: [contextKey.jwk] } : {}))
  })
  await new Promise<void>((resolve) => { jwks.listen(0, '127.0.0.1', resolve) })
  const address = jwks.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP JWKS address')
  const issuer = `http://127.0.0.1:${address.port}`
  const env = parseEnv({
    DATABASE_URL: databaseUrl, NODE_ENV: 'test', REQUIRE_AUTH: 'true', DEEPCRM_API_PUBLIC_URL: AUDIENCE,
    UOA_BASE_URL: issuer, DEEPCRM_SECRET_KEYRING_B64: keyring,
    DEEPCRM_APPS: JSON.stringify({
      nessie: {
        keyHashes: [createHash('sha256').update(APP_KEY, 'utf8').digest('hex')],
        contextJwksUrl: `${issuer}/context/jwks.json`, contextIssuer: CONTEXT_ISSUER,
        sourceDomain: 'api.nessie.test', product: 'nessie',
        subjectTools: ['crm_consent_set', 'crm_consent_get'],
      },
    }),
  })
  deps = createAppDeps(env)
  tenant = await seedTenant(deps.db)
  const target = { organizationId: tenant.organizationId, teamId: tenant.teamId }
  await deps.db.$transaction(async (tx) => {
    await seedDefaultPolicies(tx, target)
    await applyTemplate(tx, target, { type: 'system', id: 'subject-test', onBehalfOf: null, requestId: 'seed' },
      'standard_crm')
  })
  app = buildApp(deps, env)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const served = app.server.address()
  if (served === null || typeof served === 'string') throw new Error('Expected a TCP test address')
  mcpUrl = new URL(`http://127.0.0.1:${served.port}/mcp`)
})

afterAll(async () => {
  await deps.db.auditLog.deleteMany({ where: { organizationId: tenant.organizationId } })
  await dropTenant(deps.db, tenant.organizationId)
  await app.close()
  await deps.db.$disconnect()
  await new Promise<void>((resolve) => { jwks.close(() => resolve()) })
})

type Attestation = { tool: string; args: Record<string, unknown>; requestId?: string; team?: string }

function subjectContext(attestation: Attestation): string {
  const now = Math.floor(Date.now() / 1_000)
  return jwt(contextKey, {
    iss: CONTEXT_ISSUER, aud: AUDIENCE, iat: now, exp: now + 300, actor: 'subject',
    org: tenant.externalOrgId, team: attestation.team ?? tenant.externalTeamId,
    requestId: attestation.requestId ?? randomUUID(), tool: attestation.tool,
    args_sha256: createHash('sha256').update(canonicalJson(attestation.args), 'utf8').digest('hex'),
  })
}

async function post(context: string, body: unknown): Promise<Response> {
  return fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25', Authorization: `Bearer ${APP_KEY}`, 'X-Nessie-Context': context,
    },
    body: JSON.stringify(body),
  })
}

function toolCall(name: string, args: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
}

const Envelope = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.record(z.unknown()).optional(),
    tools: z.array(z.object({ name: z.string() })).optional(),
  }).passthrough(),
})

async function envelope(response: Response) {
  expect(response.status).toBe(200)
  const text = await response.text()
  const isStream = (response.headers.get('content-type') ?? '').includes('text/event-stream')
  const data = isStream ? text.split('\n').find((line) => line.startsWith('data: '))?.slice('data: '.length) : text
  if (data === undefined) throw new Error('Response carried no JSON-RPC message')
  return Envelope.parse(JSON.parse(data)).result
}

const signup = {
  email: 'subject-e2e@example.com', state: 'not_confirmed', source: 'signup_form',
  create: { data: { name: { full: 'Subject Person' } } },
}

describe('a subject-attested consent call through the real inbound auth', () => {
  it('writes consent as the app subject, for nobody, and answers a replay with 401', async () => {
    const requestId = randomUUID()
    const context = subjectContext({ tool: 'crm_consent_set', args: signup, requestId })
    const result = await envelope(await post(context, toolCall('crm_consent_set', signup)))
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ created: true, state: 'not_confirmed' })
    await expect(deps.db.auditLog.findFirstOrThrow({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, action: 'crm_consent_set' },
      select: { actorType: true, actorId: true, onBehalfOf: true },
    })).resolves.toEqual({ actorType: 'system', actorId: 'subject:nessie', onBehalfOf: null })

    expect((await post(context, toolCall('crm_consent_set', signup))).status).toBe(401)

    const read = { email: 'subject-e2e@example.com' }
    const got = await envelope(await post(
      subjectContext({ tool: 'crm_consent_get', args: read }), toolCall('crm_consent_get', read),
    ))
    expect(got.structuredContent).toMatchObject({ state: 'not_confirmed', source: 'signup_form' })
  })

  it('lists only the attested tool and refuses any other call, tool or batch', async () => {
    const listed = await envelope(await post(
      subjectContext({ tool: 'crm_consent_get', args: {} }), { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ))
    expect(listed.tools?.map((tool) => tool.name)).toEqual(['crm_consent_get'])

    const read = { email: 'subject-e2e@example.com' }
    const mismatch = await post(subjectContext({ tool: 'crm_consent_get', args: read }), toolCall('crm_consent_set', read))
    expect(mismatch.status).toBe(401)
    const recordGet = { id: randomUUID() }
    const notAllowed = await post(subjectContext({ tool: 'crm_record_get', args: recordGet }),
      toolCall('crm_record_get', recordGet))
    expect(notAllowed.status).toBe(401)
    const batch = await post(subjectContext({ tool: 'crm_consent_get', args: read }), [
      toolCall('crm_consent_get', read), { ...toolCall('crm_consent_set', signup), id: 3 },
    ])
    expect(batch.status).toBe(401)
    const reasons = await deps.db.auditLog.findMany({
      where: { organizationId: null, action: 'auth.failed', reason: { in: ['subject_tool_mismatch', 'subject_not_allowed'] } },
      select: { reason: true },
    })
    expect(new Set(reasons.map((row) => row.reason))).toEqual(new Set(['subject_tool_mismatch', 'subject_not_allowed']))
  })

  it('answers a team with no workspace with TENANT_NOT_FOUND and provisions nothing', async () => {
    const team = `tm_missing_${randomUUID()}`
    const result = await envelope(await post(
      subjectContext({ tool: 'crm_consent_set', args: signup, team }), toolCall('crm_consent_set', signup),
    ))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'TENANT_NOT_FOUND', next: 'fatal' })
    await expect(deps.db.team.findUnique({ where: { externalTeamId: team } })).resolves.toBeNull()
  })
})
