import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { dropTenant, seedTenant, type PolicyAction, type PolicyEffect, type PolicyResourceType } from '@deepcrm/db'
import { CrmRecordCreateAdmission, ErrorCode, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'
import { createAppDeps } from '../../src/deps.js'
import { parseEnv } from '../../src/env.js'
import { buildMcpServer } from '../../src/mcp/server.js'
import { readRecordCreateAdmission } from '../../src/services/record-create-admission.js'
import { createRecord } from '../../src/services/records.js'
import { seedDefaultPolicies } from '../../src/services/policy.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for record creation admission tests')
// Synthetic test-only keys, never an installed credential.
const key = Buffer.alloc(32, 1).toString('base64')
const keyring = Buffer.from(JSON.stringify({ active: 'test', keys: { test: key, export: key } })).toString('base64')
const deps = createAppDeps(parseEnv({ DATABASE_URL: databaseUrl, NODE_ENV: 'test', REQUIRE_AUTH: 'false',
  DEEPCRM_API_PUBLIC_URL: 'http://127.0.0.1', DEEPCRM_SECRET_KEYRING_B64: keyring }))
const db = deps.db
const organizations: string[] = []
async function fixture() {
  const seeded = await seedTenant(db)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  organizations.push(tenant.organizationId)
  await db.$transaction(tx => seedDefaultPolicies(tx, tenant))
  const userId = 'admission-' + randomUUID()
  const ctx: ActorContext = { tenant, app: 'test', actChain: [], actor: { type: 'human', id: userId },
    onBehalfOf: { uoaUserId: userId, role: 'member' }, provenance: null,
    requestId: randomUUID(), now: new Date() }
  const object = await db.objectType.create({ data: { ...tenant, slug: 'admission_object',
    singularName: 'Admission object', pluralName: 'Admission objects', description: 'Scoped fixture',
    kind: 'custom', createdByType: 'system', createdById: 'admission-fixture' } })
  return { tenant, ctx, object, userId }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function rule(f: Fixture, effect: PolicyEffect, options: { resourceType?: PolicyResourceType;
  action?: PolicyAction; approval?: boolean; team?: boolean;
  binding?: { actorType: 'human' | 'agent' | 'role'; actorId: string } } = {}) {
  return db.policyRule.create({ data: { ...f.tenant, scope: options.team ? 'team' : 'object_type',
    scopeId: options.team ? f.tenant.teamId : f.object.id, resourceType: options.resourceType ?? 'record',
    action: options.action ?? 'create', effect, priority: 100, requiresApproval: options.approval ?? false,
    createdById: f.userId, bindings: { create: [options.binding ?? { actorType: 'human', actorId: f.userId }] } } })
}
const read = (f: Fixture, ctx = f.ctx) => readRecordCreateAdmission(deps, ctx, f.object.slug)
afterAll(async () => {
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('current record creation admission', () => {
  it('observes current policy without writing records, audit, replay or schema', async () => {
    const f = await fixture()
    const before = { object: await db.objectType.findUniqueOrThrow({ where: { id: f.object.id } }),
      records: await db.record.count({ where: f.tenant }), audits: await db.auditLog.count({ where: f.tenant }),
      replays: await db.idempotencyReplay.count({ where: f.tenant }) }
    const result = CrmRecordCreateAdmission.out.parse(await read(f))
    expect(result).toMatchObject({ object_type_id: f.object.id, create: 'allowed' })
    expect(Number.isFinite(Date.parse(result.observed_at))).toBe(true)
    expect(await db.objectType.findUniqueOrThrow({ where: { id: f.object.id } })).toEqual(before.object)
    expect(await db.record.count({ where: f.tenant })).toBe(before.records)
    expect(await db.auditLog.count({ where: f.tenant })).toBe(before.audits)
    expect(await db.idempotencyReplay.count({ where: f.tenant })).toBe(before.replays)
    expect(Object.keys(result).sort()).toEqual(['create', 'object_type_id', 'observed_at', 'schema_version'])
  })
  it('keeps approval-required distinct and lets a hard deny override allowance and approval', async () => {
    const f = await fixture()
    await rule(f, 'allow', { approval: true })
    expect((await read(f)).create).toBe('approval_required')
    await rule(f, 'allow')
    await rule(f, 'deny')
    expect((await read(f)).create).toBe('denied')
    expect((await read(f, { ...f.ctx, onBehalfOf: { uoaUserId: f.userId, role: 'owner' } })).create).toBe('denied')
  })
  it('does not transfer an object/principal decision to another object or person', async () => {
    const f = await fixture()
    await rule(f, 'deny')
    const other = await db.objectType.create({ data: { ...f.tenant, slug: 'other_admission',
      singularName: 'Other', pluralName: 'Others', description: 'Other scope', kind: 'custom',
      createdByType: 'system', createdById: 'admission-fixture' } })
    expect((await read(f)).create).toBe('denied')
    expect((await readRecordCreateAdmission(deps, f.ctx, other.slug)).create).toBe('allowed')
    const userId = 'other-' + randomUUID()
    expect((await read(f, { ...f.ctx, actor: { type: 'human', id: userId },
      onBehalfOf: { uoaUserId: userId, role: 'member' } })).create).toBe('allowed')
  })
  it('requires schema view and refuses archived or foreign object identities', async () => {
    const f = await fixture()
    await db.objectType.update({ where: { id: f.object.id }, data: { archivedAt: new Date() } })
    await expect(read(f)).rejects.toMatchObject({ code: ErrorCode.UNKNOWN_OBJECT_TYPE })
    const other = await fixture()
    await db.objectType.create({ data: { ...other.tenant, slug: 'foreign_only', singularName: 'Foreign',
      pluralName: 'Foreign', description: 'Other team only', kind: 'custom',
      createdByType: 'system', createdById: 'admission-fixture' } })
    await expect(readRecordCreateAdmission(deps, f.ctx, 'foreign_only'))
      .rejects.toMatchObject({ code: ErrorCode.UNKNOWN_OBJECT_TYPE })
    await rule(f, 'deny', { resourceType: 'schema', action: 'view', team: true })
    await expect(readRecordCreateAdmission(deps, f.ctx, 'not_visible')).rejects.toMatchObject({
      code: ErrorCode.POLICY_DENIED })
    await expect(read(other, { ...other.ctx, onBehalfOf: null })).rejects.toMatchObject({
      code: ErrorCode.POLICY_DENIED })
  })
  it('requires the same human and agent grants as writes rather than tool discovery', async () => {
    const f = await fixture()
    const agent = { ...f.ctx, actor: { type: 'agent' as const, id: 'cap-agent' } }
    const binding = { actorType: 'agent' as const, actorId: 'agent:test:cap-agent' }
    await rule(f, 'allow', { resourceType: 'schema', action: 'view', team: true, binding })
    expect((await read(f, agent)).create).toBe('denied')
    await rule(f, 'allow', { binding })
    expect((await read(f, agent)).create).toBe('allowed')
    await rule(f, 'deny')
    expect((await read(f, agent)).create).toBe('denied')
  })
  it('observes later revocation and never turns prior allowance into a write grant', async () => {
    const f = await fixture()
    expect((await read(f)).create).toBe('allowed')
    await rule(f, 'deny')
    expect((await read(f)).create).toBe('denied')
    await expect(createRecord(deps, f.ctx, { objectType: f.object.slug, data: {} }))
      .rejects.toMatchObject({ code: ErrorCode.POLICY_DENIED })
    expect(await db.record.count({ where: f.tenant })).toBe(0)
  })
  it('base allowance does not promise permission for confidential submitted fields', async () => {
    const f = await fixture()
    await db.attribute.create({ data: { ...f.tenant, objectTypeId: f.object.id,
      slug: 'secret', name: 'Secret', description: 'Sensitive field', type: 'text',
      config: { maxLength: 100 }, sensitivity: 'confidential', position: 0 } })
    await rule(f, 'deny', { resourceType: 'attribute', action: 'edit' })
    expect((await read(f)).create).toBe('allowed')
    await expect(createRecord(deps, f.ctx, { objectType: f.object.slug, data: { secret: 'entered value' } }))
      .rejects.toMatchObject({ code: ErrorCode.POLICY_DENIED })
    expect(await db.record.count({ where: f.tenant })).toBe(0)
  })
  it('is discoverable and callable through the real MCP SDK without caller/team overrides', async () => {
    const f = await fixture()
    const server = buildMcpServer(f.ctx, deps)
    const client = new Client({ name: 'admission-interface', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const tool = (await client.listTools()).tools.find(item => item.name === 'crm_record_create_admission')
      expect(tool?.title).toBe('Check record creation')
      expect(tool?.inputSchema.properties).toHaveProperty('object_type.description')
      const result = await client.callTool({ name: 'crm_record_create_admission',
        arguments: { object_type: f.object.slug } })
      expect(CrmRecordCreateAdmission.out.parse(result.structuredContent)).toMatchObject({
        object_type_id: f.object.id, create: 'allowed' })
      const forged = await client.callTool({ name: 'crm_record_create_admission',
        arguments: { object_type: f.object.slug, team_id: randomUUID(), actor: { role: 'owner' } } })
      expect(forged).toMatchObject({ isError: true, structuredContent: { code: ErrorCode.VALIDATION_FAILED } })
      expect(await db.record.count({ where: f.tenant })).toBe(0)
    } finally { await client.close(); await server.close() }
  })
})
