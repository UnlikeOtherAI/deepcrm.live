import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { applyTemplate, createProjectionLinkWriter, FakeEmbedder, keyHash } from '@deepcrm/schema-engine'
import { ErrorCode, parseSecretBox, ServiceError, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { testFileAccess } from '../file-access-fixture.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { getRecord } from '../../src/services/record-read.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for record read tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')
const keyring = Buffer.from(JSON.stringify({
  active: 'read-v1', keys: { 'read-v1': Buffer.alloc(32, 7).toString('base64') },
}), 'utf8').toString('base64')
const deps: AppDeps = {
  db,
  clock: () => now,
  ids: () => crypto.randomUUID(),
  version: '0.0.0',
  maxBulkRows: 10_000, maxExportRows: 100_000,
  embedder: new FakeEmbedder('api-test'),
  orgAllowlist: null,
  linkWriter: createProjectionLinkWriter(),
  historyCursor: createHistoryCursorCodec(parseSecretBox(keyring)),
  queryCursor: createQueryCursorCodec(parseSecretBox(keyring)),
  secretBox: parseSecretBox(keyring),
  fileAccess: testFileAccess,
  writeAudit,
}

type Tenant = { organizationId: string; teamId: string }
type Fixture = Tenant & {
  caseTypeId: string
  emailAttributeId: string
  primaryId: string
  relatedId: string
  privateId: string
}

function context(tenant: Tenant, userId = 'read_user'): ActorContext {
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
  const seeded = await seedTenant(db)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: ctx.actor.type,
    id: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    requestId: ctx.requestId,
  }, 'system'))
  const caseType = await db.objectType.create({ data: {
    ...tenant, slug: 'case', singularName: 'Case', pluralName: 'Cases', description: 'Case',
    kind: 'custom', createdByType: 'system', createdById: 'record_read_fixture',
  } })
  const email = await db.attribute.create({ data: {
    ...tenant, objectTypeId: caseType.id, slug: 'email', name: 'Email', description: 'Unique email',
    type: 'email', config: {}, isMulti: true, isUnique: true, sensitivity: 'restricted', position: 0,
  } })
  const name = await db.attribute.create({ data: {
    ...tenant, objectTypeId: caseType.id, slug: 'name', name: 'Name', description: 'Name',
    type: 'text', config: { maxLength: 120 }, position: 1,
  } })
  await db.objectType.update({ where: { id: caseType.id }, data: { primaryAttributeId: name.id } })
  const relation = await db.relationType.create({ data: {
    ...tenant, slug: 'case_related', fromObjectTypeId: caseType.id, toObjectTypeId: caseType.id,
    forwardName: 'Related', inverseName: 'Related to', cardinality: 'many_to_many',
    edgeAttributes: [{ slug: 'role', name: 'Role', description: 'Edge role', type: 'text',
      config: { maxLength: 20 }, sensitivity: 'restricted' }],
  } })
  const record = async (emailValue: string, visibility: 'team' | 'private', owner = 'read_user') => (
    db.record.create({ data: {
      ...tenant, objectTypeId: caseType.id, data: { email: emailValue, name: emailValue },
      displayName: emailValue, visibility, createdOnBehalfOf: owner,
      createdByType: 'human', createdById: owner, createdAt: now, updatedAt: now,
    } })
  )
  const [primary, related, privateRecord] = await Promise.all([
    record('Alice@Example.test', 'team'), record('related@example.test', 'team'),
    record('private@example.test', 'private', 'other_user'),
  ])
  const uniqueKey = (recordId: string, normalizedValue: string) => ({
    ...tenant, attributeId: email.id, recordId,
    normalizedHash: keyHash(normalizedValue), normalizedValue,
  })
  await db.recordUniqueKey.createMany({ data: [
    uniqueKey(primary.id, 'alice@example.test'),
    uniqueKey(related.id, 'related@example.test'),
    uniqueKey(privateRecord.id, 'private@example.test'),
  ] })
  await db.recordLink.create({ data: {
    ...tenant, relationTypeId: relation.id, fromRecordId: primary.id, toRecordId: related.id,
      data: { role: 'owner' }, activeFrom: now, createdByType: 'system', createdById: 'record_read_fixture',
  } })
  await db.recordChange.create({ data: {
    ...tenant, recordId: primary.id, kind: 'set', attributeSlug: 'name', newValue: 'Alice',
    actorType: 'human', actorId: 'read_user', onBehalfOf: 'read_user', requestId: crypto.randomUUID(),
    resultingVersion: 1, seq: 1n, occurredAt: now,
  } })
  await db.team.update({ where: { id: tenant.teamId }, data: { schemaVersion: 1 } })
  return {
    ...tenant, caseTypeId: caseType.id, emailAttributeId: email.id,
    primaryId: primary.id, relatedId: related.id, privateId: privateRecord.id,
  }
}

async function caught(operation: Promise<unknown>): Promise<ServiceError> {
  try {
    await operation
  } catch (error) {
    if (error instanceof ServiceError) return error
    throw error
  }
  throw new Error('Expected an error')
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizations } } })
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('record read service', () => {
  it('resolves a canonical unique key exactly as an id and rejects invalid lookup shapes', async () => {
    const target = await fixture()
    const byId = await getRecord(deps, context(target), { id: target.primaryId })
    const byUnique = await getRecord(deps, context(target), {
      objectType: 'case', matchAttribute: 'email', value: ' alice@example.TEST ',
    })
    expect(byUnique.record.id).toBe(byId.record.id)
    const invalid = await caught(getRecord(deps, context(target), { id: target.primaryId, objectType: 'case' }))
    expect(invalid.code).toBe(ErrorCode.VALIDATION_FAILED)
    const nonunique = await caught(getRecord(deps, context(target), {
      objectType: 'case', matchAttribute: 'name', value: 'Alice',
    }))
    expect(nonunique.code).toBe(ErrorCode.VALIDATION_FAILED)
  })

  it('redacts attributes and edge details, groups visible links, and fails closed for approval', async () => {
    const target = await fixture()
    const ctx = context(target)
    const result = await getRecord(deps, ctx, { id: target.primaryId, includeLinks: true })
    expect(result.links?.['case_related']).toHaveLength(1)
    expect(result.links?.['case_related']?.[0]?.related.id).toBe(target.relatedId)
    await db.policyRule.create({ data: {
      organizationId: target.organizationId, teamId: target.teamId,
      scope: 'team', scopeId: target.teamId, resourceType: 'attribute', action: 'view',
      effect: 'deny', priority: 100, conditions: { sensitivity: 'restricted' }, createdById: 'record_read_fixture',
      bindings: { create: [{ actorType: 'role', actorId: 'member' }] },
    } })
    const redacted = await getRecord(deps, ctx, { id: target.primaryId, includeLinks: true })
    expect(redacted.record.redacted_attributes).toContain('email')
    expect(redacted.record.data).not.toHaveProperty('email')
    expect(redacted.links?.['case_related']?.[0]?.link.data).toEqual({})
    await db.policyRule.create({ data: {
      organizationId: target.organizationId, teamId: target.teamId,
      scope: 'record', scopeId: target.primaryId, resourceType: 'record', action: 'view',
      effect: 'deny', priority: 101, requiresApproval: true, createdById: 'record_read_fixture',
      bindings: { create: [{ actorType: 'role', actorId: 'member' }] },
    } })
    const approval = await caught(getRecord(deps, ctx, { id: target.primaryId }))
    expect(approval.code).toBe(ErrorCode.APPROVAL_REQUIRED)
  })

  it('does not reveal invisible records or records from another tenant', async () => {
    const target = await fixture()
    const privateError = await caught(getRecord(deps, context(target), { id: target.privateId }))
    expect(privateError.code).toBe(ErrorCode.NOT_FOUND)
    const other = await fixture()
    const tenantError = await caught(getRecord(deps, context(other), { id: target.primaryId }))
    expect(tenantError.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('maps recent history changes into timeline items and omits an invisible linked record', async () => {
    const target = await fixture()
    const result = await getRecord(deps, context(target), {
      id: target.primaryId, includeLinks: true, includeTimeline: 1,
    })
    expect(result.timeline).toHaveLength(1)
    expect(result.timeline?.[0]).toMatchObject({ kind: 'change', occurred_at: now.toISOString() })
    await db.record.update({
      where: { id: target.relatedId }, data: { visibility: 'private', createdOnBehalfOf: 'other_user' },
    })
    const hiddenRelated = await getRecord(deps, context(target), {
      id: target.primaryId, includeLinks: true,
    })
    expect(hiddenRelated.links).toEqual({})
  })

  it('lists visible multi-value collision candidates but redacts ids if any candidate is invisible', async () => {
    const target = await fixture()
    const visible = await caught(getRecord(deps, context(target), {
      objectType: 'case', matchAttribute: 'email',
      value: ['alice@example.test', 'related@example.test'],
    }))
    expect(visible.code).toBe(ErrorCode.DUPLICATE_FOUND)
    expect(visible.details['record_ids']).toEqual([target.primaryId, target.relatedId].sort())
    const hidden = await caught(getRecord(deps, context(target), {
      objectType: 'case', matchAttribute: 'email',
      value: ['alice@example.test', 'private@example.test'],
    }))
    expect(hidden.code).toBe(ErrorCode.DUPLICATE_FOUND)
    expect(hidden.details).not.toHaveProperty('record_ids')
    expect(hidden.details).not.toHaveProperty('record_id')
  })

  it('writes one denied audit for a primary approval gate', async () => {
    const target = await fixture()
    await db.policyRule.create({ data: {
      organizationId: target.organizationId, teamId: target.teamId,
      scope: 'record', scopeId: target.primaryId, resourceType: 'record', action: 'view',
      effect: 'deny', priority: 100, requiresApproval: true, createdById: 'record_read_fixture',
      bindings: { create: [{ actorType: 'role', actorId: 'member' }] },
    } })
    const before = await db.auditLog.count({ where: {
      organizationId: target.organizationId, teamId: target.teamId, action: 'crm_record_get',
    } })
    const error = await caught(getRecord(deps, context(target), { id: target.primaryId }))
    expect(error.code).toBe(ErrorCode.APPROVAL_REQUIRED)
    const after = await db.auditLog.count({ where: {
      organizationId: target.organizationId, teamId: target.teamId, action: 'crm_record_get',
    } })
    expect(after - before).toBe(1)
  })
})
