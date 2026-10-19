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

// A form or chat submission through the real inbound auth (REQUIRE_AUTH=true):
// a Nessie app key and an `actor: "subject"` context, no UOA delegation, with
// crm_intake_submit in the registry's subjectTools (schema-engine §4d″).

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
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP intake tests')
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
        subjectTools: ['crm_consent_set', 'crm_consent_get', 'crm_intake_submit'],
      },
    }),
  })
  deps = createAppDeps(env)
  tenant = await seedTenant(deps.db)
  const target = { organizationId: tenant.organizationId, teamId: tenant.teamId }
  await deps.db.$transaction(async (tx) => {
    await seedDefaultPolicies(tx, target)
    const actor = { type: 'system' as const, id: 'intake-test', onBehalfOf: null, requestId: 'seed' }
    await applyTemplate(tx, target, actor, 'system')
    await applyTemplate(tx, target, actor, 'standard_crm')
  }, { timeout: 60_000 })
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
    tools: z.array(z.object({ name: z.string(), inputSchema: z.record(z.unknown()) })).optional(),
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

const submission = {
  source: { kind: 'website_chat', id: 'chat_works', name: 'nessie.works chat' },
  email: 'visitor@example.com', phone: '+442071838750',
  data: { name: { full: 'Website Visitor' } },
  activity: { kind: 'message', occurred_at: '2026-10-19T09:00:00Z', subject: 'Website chat on nessie.works' },
  note: { title: 'Website chat terms accepted', body: 'Accepted the terms.' },
}

const SchemaProperties = z.object({
  properties: z.record(z.object({ properties: z.record(z.unknown()).optional() }).passthrough()),
  required: z.array(z.string()),
}).passthrough()

describe('crm_intake_submit through the real inbound auth', () => {
  it('lists the tool with its whole input schema to a subject principal', async () => {
    const listed = await envelope(await post(
      subjectContext({ tool: 'crm_intake_submit', args: {} }), { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ))
    expect(listed.tools?.map((tool) => tool.name)).toEqual(['crm_intake_submit'])
    const schema = SchemaProperties.parse(listed.tools?.[0]?.inputSchema)
    expect(Object.keys(schema.properties).sort()).toEqual([
      'activity', 'consent', 'data', 'email', 'idempotency_key', 'note', 'object_type', 'phone', 'source',
    ])
    expect(schema.required.sort()).toEqual(['activity', 'source'])
    expect(Object.keys(schema.properties['source']?.properties ?? {}).sort()).toEqual(['id', 'kind', 'name'])
  })

  it('creates the person as the app subject and answers only the outcome; a replay is 401', async () => {
    const context = subjectContext({ tool: 'crm_intake_submit', args: submission })
    const result = await envelope(await post(context, toolCall('crm_intake_submit', submission)))
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ outcome: 'created', record_id: expect.any(String) })
    const id = String(result.structuredContent?.['record_id'])
    const created = await deps.db.record.findFirstOrThrow({ where: { teamId: tenant.teamId, id } })
    expect(created).toMatchObject({ createdById: 'subject:nessie', origin: 'subject:nessie' })
    expect(created.data).toMatchObject({ first_source_name: 'nessie.works chat', phones: ['+442071838750'] })
    expect((await post(context, toolCall('crm_intake_submit', submission))).status).toBe(401)

    const again = { ...submission, data: { name: { full: 'Website Visitor' }, title: 'Founder' } }
    const paired = await envelope(await post(
      subjectContext({ tool: 'crm_intake_submit', args: again }), toolCall('crm_intake_submit', again),
    ))
    expect(paired.structuredContent).toEqual({ outcome: 'paired', record_id: id })
  })

  it('binds the source to the signed argument hash', async () => {
    const signed = subjectContext({ tool: 'crm_intake_submit', args: submission })
    const renamed = { ...submission, source: { ...submission.source, name: 'Another form' } }
    expect((await post(signed, toolCall('crm_intake_submit', renamed))).status).toBe(401)
    const reasons = await deps.db.auditLog.findMany({
      where: { organizationId: null, action: 'auth.failed', reason: 'invalid_context' }, select: { reason: true },
    })
    expect(reasons.length).toBeGreaterThan(0)
  })

  it('refuses an invalid source name as a tool error', async () => {
    const bad = { ...submission, source: { ...submission.source, name: 'line\nbreak' } }
    const result = await envelope(await post(
      subjectContext({ tool: 'crm_intake_submit', args: bad }), toolCall('crm_intake_submit', bad),
    ))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})
