import { createDb, dropTenant, seedTenant, writeAudit, type PolicyResourceType } from '@deepcrm/db'
import { createProjectionLinkWriter } from '@deepcrm/schema-engine'
import { ErrorCode, parseSecretBox, ServiceError, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { queryRecords } from '../../src/services/record-query.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for query security tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')
const encodedKeyring = Buffer.from(JSON.stringify({
  active: 'security-v1',
  keys: { 'security-v1': Buffer.alloc(32, 4).toString('base64') },
}), 'utf8').toString('base64')
const deps: AppDeps = {
  db,
  clock: () => now,
  ids: () => crypto.randomUUID(),
  version: '0.0.0',
  maxBulkRows: 10_000,
  orgAllowlist: null,
  linkWriter: createProjectionLinkWriter(),
  historyCursor: createHistoryCursorCodec(parseSecretBox(encodedKeyring)),
  queryCursor: createQueryCursorCodec(parseSecretBox(encodedKeyring)),
  secretBox: parseSecretBox(encodedKeyring),
  writeAudit,
}

type Tenant = { organizationId: string; teamId: string }
type Fixture = Tenant & {
  objectTypeId: string
  visibleId: string
  deniedId: string
  privateId: string
  grantedId: string
}

function context(tenant: Tenant, userId = 'security_user'): ActorContext {
  return {
    tenant,
    app: 'test',
    actChain: [],
    actor: { type: 'human', id: userId },
    onBehalfOf: { uoaUserId: userId, role: 'member' },
    provenance: null,
    requestId: crypto.randomUUID(),
    now,
  }
}

async function fixture(): Promise<Fixture> {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const objectType = await db.objectType.create({
    data: {
      organizationId: tenant.organizationId, teamId: tenant.teamId,
      slug: 'case', singularName: 'Case', pluralName: 'Cases', description: 'A case',
      kind: 'custom', createdByType: 'system', createdById: 'query_security_fixture',
    },
  })
  const name = await db.attribute.create({
    data: {
      organizationId: tenant.organizationId, teamId: tenant.teamId,
      objectTypeId: objectType.id, slug: 'name', name: 'Name', description: 'Name',
      type: 'text', config: { maxLength: 120 }, position: 0,
    },
  })
  await db.attribute.create({
    data: {
      organizationId: tenant.organizationId, teamId: tenant.teamId,
      objectTypeId: objectType.id, slug: 'secret', name: 'Secret', description: 'Secret',
      type: 'text', config: { maxLength: 120 }, sensitivity: 'restricted', position: 1,
    },
  })
  await db.objectType.update({ where: { id: objectType.id }, data: { primaryAttributeId: name.id } })
  await db.team.update({ where: { id: tenant.teamId }, data: { schemaVersion: 1 } })
  const create = async (displayName: string, visibility: 'team' | 'users' | 'private') => (
    db.record.create({
      data: {
        organizationId: tenant.organizationId, teamId: tenant.teamId,
        objectTypeId: objectType.id, data: { name: displayName, secret: `${displayName} secret` },
        displayName, visibility, createdOnBehalfOf: 'other_user',
        createdByType: 'human', createdById: 'other_user', createdAt: now, updatedAt: now,
      },
    })
  )
  const [visible, denied, privateRecord, granted] = await Promise.all([
    create('Visible', 'team'), create('Denied', 'team'),
    create('Private', 'private'), create('Granted', 'users'),
  ])
  await db.recordVisibilityGrant.create({
    data: { recordId: granted.id, uoaUserId: 'security_user' },
  })
  return {
    ...tenant,
    objectTypeId: objectType.id,
    visibleId: visible.id,
    deniedId: denied.id,
    privateId: privateRecord.id,
    grantedId: granted.id,
  }
}

async function rule(
  target: Fixture,
  resourceType: PolicyResourceType,
  effect: 'allow' | 'deny',
  scope: 'team' | 'record',
  scopeId: string,
  sensitivity?: 'restricted',
  requiresApproval = false,
): Promise<void> {
  await db.policyRule.create({
    data: {
      organizationId: target.organizationId, teamId: target.teamId,
      scope, scopeId, resourceType, action: 'view', effect, priority: 100,
      requiresApproval,
      ...(sensitivity === undefined ? {} : { conditions: { sensitivity } }),
      createdById: 'query_security_fixture',
      bindings: { create: [{ actorType: 'role', actorId: 'member' }] },
    },
  })
}

async function actorRule(
  target: Fixture,
  actorType: 'role' | 'agent',
  actorId: string,
): Promise<void> {
  await db.policyRule.create({
    data: {
      organizationId: target.organizationId, teamId: target.teamId,
      scope: 'team', scopeId: target.teamId, resourceType: 'record', action: 'view',
      effect: 'allow', priority: 100, createdById: 'query_security_fixture',
      bindings: { create: [{ actorType, actorId }] },
    },
  })
}

async function caught(operation: Promise<unknown>): Promise<ServiceError> {
  try {
    await operation
  } catch (error) {
    if (error instanceof ServiceError) return error
    throw error
  }
  throw new Error('Expected query to fail')
}

function dbWithoutDataSql() {
  const checked = db.$extends({})
  const queryRaw = checked.$queryRaw
  Reflect.defineProperty(checked, '$queryRaw', {
    configurable: true,
    value: (query: unknown, ...values: unknown[]) => {
      if (Array.isArray(query)) return Reflect.apply(queryRaw, checked, [query, ...values])
      return Promise.reject(new Error('data SQL must not run'))
    },
  })
  return checked
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizations } } })
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('record query security', () => {
  it('applies visibility, tenant, row policy, and record-scoped attribute redaction', async () => {
    const target = await fixture()
    const foreign = await fixture()
    await rule(target, 'record', 'deny', 'record', target.deniedId)
    await rule(target, 'attribute', 'deny', 'record', target.visibleId, 'restricted')
    const result = await queryRecords(deps, context(target), {
      objectType: 'case', attributes: ['name', 'secret'], includeTotal: true,
    })
    const ids = new Set(result.records.map((record) => record.id))
    expect(ids).toEqual(new Set([target.visibleId, target.grantedId]))
    expect(ids.has(target.privateId)).toBe(false)
    expect(ids.has(target.deniedId)).toBe(false)
    expect(foreign.visibleId).not.toBe(target.visibleId)
    expect(ids.has(foreign.visibleId)).toBe(false)
    expect(result.total).toBe(2)
    expect(result.records.find((record) => record.id === target.visibleId)).toMatchObject({
      data: { name: 'Visible' }, redacted_attributes: ['secret'],
    })
    expect(result.records.find((record) => record.id === target.grantedId)).toMatchObject({
      data: { name: 'Granted', secret: 'Granted secret' }, redacted_attributes: [],
    })
    const filtered = await queryRecords(deps, context(target), {
      objectType: 'case',
      filter: { attribute: 'secret', op: 'contains', value: 'secret' },
      attributes: ['name'],
    })
    expect(filtered.records.map((record) => record.id)).toEqual([target.grantedId])
  })

  it('denies sensitive filter and sort before data SQL with exactly one audit', async () => {
    const target = await fixture()
    await rule(target, 'attribute', 'deny', 'team', target.teamId, 'restricted')
    const checkedDb = dbWithoutDataSql()
    const checkedDeps: AppDeps = { ...deps, db: checkedDb }
    const before = await db.auditLog.count({
      where: { organizationId: target.organizationId, teamId: target.teamId, action: 'crm_records_query' },
    })
    const filtered = await caught(queryRecords(checkedDeps, context(target), {
      objectType: 'case', filter: { attribute: 'secret', op: 'contains', value: 'x' },
    }))
    expect(filtered.code).toBe(ErrorCode.POLICY_DENIED)
    const afterFilter = await db.auditLog.count({
      where: { organizationId: target.organizationId, teamId: target.teamId, action: 'crm_records_query' },
    })
    expect(afterFilter - before).toBe(1)
    const sorted = await caught(queryRecords(checkedDeps, context(target), {
      objectType: 'case', sort: [{ attribute: 'secret', direction: 'asc' }],
    }))
    expect(sorted.code).toBe(ErrorCode.POLICY_DENIED)
    expect(await db.auditLog.count({
      where: { organizationId: target.organizationId, teamId: target.teamId, action: 'crm_records_query' },
    })).toBe(afterFilter + 1)
  })

  it('denies object-level record view once and never invokes data SQL', async () => {
    const target = await fixture()
    await rule(target, 'record', 'deny', 'team', target.teamId)
    const checkedDb = dbWithoutDataSql()
    const error = await caught(queryRecords({ ...deps, db: checkedDb }, context(target), {
      objectType: 'case',
    }))
    expect(error.code).toBe(ErrorCode.POLICY_DENIED)
    expect(await db.auditLog.count({
      where: { organizationId: target.organizationId, teamId: target.teamId, action: 'crm_records_query' },
    })).toBe(1)
  })

  it('maps approval and cursor failures without exposing rows', async () => {
    const target = await fixture()
    await rule(target, 'record', 'allow', 'team', target.teamId, undefined, true)
    const approval = await caught(queryRecords(deps, context(target), { objectType: 'case' }))
    expect(approval.code).toBe(ErrorCode.APPROVAL_REQUIRED)

    const cursorTarget = await fixture()
    const checkedDb = dbWithoutDataSql()
    const mismatch = await caught(queryRecords({ ...deps, db: checkedDb }, context(cursorTarget), {
      objectType: 'case', cursor: 'not-a-cursor',
    }))
    expect(mismatch).toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
      details: { detail: 'cursor_mismatch' },
    })
  })

  it('requires both human and agent policy channels for an agent query', async () => {
    const target = await fixture()
    const agentCtx: ActorContext = {
      ...context(target),
      actor: { type: 'agent', id: 'worker' },
      requestId: crypto.randomUUID(),
    }
    await actorRule(target, 'agent', 'agent:test:worker')
    const denied = await caught(queryRecords(
      { ...deps, db: dbWithoutDataSql() }, agentCtx, { objectType: 'case' },
    ))
    expect(denied.code).toBe(ErrorCode.POLICY_DENIED)
    expect(await db.auditLog.count({
      where: {
        organizationId: target.organizationId,
        teamId: target.teamId,
        action: 'crm_records_query',
      },
    })).toBe(1)

    await actorRule(target, 'role', 'member')
    const allowed = await queryRecords(deps, agentCtx, { objectType: 'case' })
    expect(new Set(allowed.records.map((record) => record.id)))
      .toEqual(new Set([target.visibleId, target.deniedId, target.grantedId]))
  })
})
