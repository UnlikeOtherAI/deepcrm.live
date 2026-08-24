import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { createProjectionLinkWriter, FakeEmbedder } from '@deepcrm/schema-engine'
import { ErrorCode, parseSecretBox, ServiceError, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import { recordAt, recordHistory } from '../../src/services/records.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for record history tests')

const db = createDb(databaseUrl)
const organizations: string[] = []
const keyring = Buffer.from(JSON.stringify({
  active: 'history-v1',
  keys: { 'history-v1': Buffer.alloc(32, 17).toString('base64') },
}), 'utf8').toString('base64')
const secretBox = parseSecretBox(keyring)
const deps: AppDeps = {
  db,
  clock: () => new Date('2026-08-24T12:00:00.000Z'),
  ids: () => crypto.randomUUID(),
  version: '0.0.0',
  maxBulkRows: 10_000, maxExportRows: 100_000,
  orgAllowlist: null,
  linkWriter: createProjectionLinkWriter(),
  historyCursor: createHistoryCursorCodec(secretBox),
  queryCursor: createQueryCursorCodec(secretBox),
  secretBox,
  embedder: new FakeEmbedder('api-test'),
  writeAudit,
}

type Tenant = { organizationId: string; teamId: string }
type Fixture = Tenant & {
  recordId: string
  companyId: string
  firstAt: Date
  middleAt: Date
  latestAt: Date
  deletedAt: Date
  restoredAt: Date
  linkAt: Date
}

function context(tenant: Tenant, user = 'history_user'): ActorContext {
  return {
    tenant,
    app: 'test',
    actChain: [],
    actor: { type: 'human', id: user },
    onBehalfOf: { uoaUserId: user, role: 'member' },
    provenance: { runId: 'history_run', toolCallId: 'history_call', requestId: crypto.randomUUID() },
    requestId: crypto.randomUUID(),
    now: new Date('2026-08-24T12:00:00.000Z'),
  }
}

async function fixture(): Promise<Fixture> {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const firstAt = new Date('2026-08-24T10:00:00.000Z')
  const middleAt = new Date('2026-08-24T11:00:00.000Z')
  const latestAt = new Date('2026-08-24T12:00:00.000Z')
  const deletedAt = new Date('2026-08-24T13:00:00.000Z')
  const restoredAt = new Date('2026-08-24T14:00:00.000Z')
  const linkAt = new Date('2026-08-24T15:00:00.000Z')
  const objectType = await db.objectType.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      slug: 'person',
      singularName: 'Person',
      pluralName: 'People',
      description: 'History fixture',
      kind: 'custom',
      createdByType: 'system',
      createdById: 'history_fixture',
    },
  })
  const companyType = await db.objectType.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      slug: 'company',
      singularName: 'Company',
      pluralName: 'Companies',
      description: 'History link fixture',
      kind: 'custom',
      createdByType: 'system',
      createdById: 'history_fixture',
    },
  })
  await db.attribute.createMany({
    data: [
      {
        organizationId: tenant.organizationId,
        teamId: tenant.teamId,
        objectTypeId: objectType.id,
        slug: 'name',
        name: 'Name',
        description: 'Name',
        type: 'text',
        config: { maxLength: 120 },
        position: 0,
      },
      {
        organizationId: tenant.organizationId,
        teamId: tenant.teamId,
        objectTypeId: objectType.id,
        slug: 'secret',
        name: 'Secret',
        description: 'Restricted value',
        type: 'text',
        config: { maxLength: 120 },
        sensitivity: 'restricted',
        position: 1,
      },
      {
        organizationId: tenant.organizationId,
        teamId: tenant.teamId,
        objectTypeId: objectType.id,
        slug: 'legacy',
        name: 'Legacy',
        description: 'Archived but readable in history',
        type: 'text',
        config: { maxLength: 120 },
        archivedAt: new Date('2026-08-24T15:00:00.000Z'),
        position: 2,
      },
      {
        organizationId: tenant.organizationId,
        teamId: tenant.teamId,
        objectTypeId: objectType.id,
        slug: 'company',
        name: 'Company',
        description: 'Employer',
        type: 'record_reference',
        config: { objectTypes: ['company'] },
        position: 3,
      },
    ],
  })
  const relation = await db.relationType.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      slug: 'person_company',
      fromObjectTypeId: objectType.id,
      toObjectTypeId: companyType.id,
      forwardName: 'Company',
      inverseName: 'People',
      cardinality: 'many_to_one',
      projectionAttributeSlug: 'company',
      edgeAttributes: [{
        slug: 'role', name: 'Role', description: 'Sensitive role', type: 'text',
        sensitivity: 'restricted',
      }],
    },
  })
  const company = await db.record.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      objectTypeId: companyType.id,
      data: {},
      displayName: 'Company',
      createdOnBehalfOf: 'history_user',
      createdByType: 'human',
      createdById: 'history_user',
      createdAt: firstAt,
    },
  })
  const record = await db.record.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      objectTypeId: objectType.id,
      data: { name: 'Latest', secret: 'classified', legacy: 'retained' },
      displayName: 'Latest',
      version: 5,
      createdOnBehalfOf: 'history_user',
      createdByType: 'human',
      createdById: 'history_user',
      createdAt: firstAt,
    },
  })
  const base = {
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    recordId: record.id,
    actorType: 'human' as const,
    actorId: 'history_user',
    onBehalfOf: 'history_user',
    runId: 'history_run',
    toolCallId: 'history_call',
    requestId: 'history_request',
  }
  const link = await db.recordLink.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      relationTypeId: relation.id,
      fromRecordId: record.id,
      toRecordId: company.id,
      data: { role: 'classified-edge' },
      activeFrom: linkAt,
      createdByType: 'human',
      createdById: 'history_user',
    },
  })
  await db.recordChange.createMany({
    data: [
      { ...base, kind: 'create', resultingVersion: 1, seq: 1n, occurredAt: firstAt },
      {
        ...base, kind: 'set', attributeSlug: 'name', newValue: 'First',
        resultingVersion: 1, seq: 2n, occurredAt: new Date(firstAt.getTime() + 1_000),
      },
      {
        ...base, kind: 'set', attributeSlug: 'secret', newValue: 'classified',
        resultingVersion: 1, seq: 3n, occurredAt: new Date(firstAt.getTime() + 2_000),
      },
      {
        ...base, kind: 'set', attributeSlug: 'legacy', newValue: 'retained',
        resultingVersion: 1, seq: 4n, occurredAt: new Date(firstAt.getTime() + 3_000),
      },
      {
        ...base, kind: 'set', attributeSlug: 'name', oldValue: 'First', newValue: 'Middle',
        resultingVersion: 2, seq: 5n, occurredAt: middleAt,
      },
      {
        ...base, kind: 'set', attributeSlug: 'name', oldValue: 'Middle', newValue: 'Latest',
        resultingVersion: 3, seq: 6n, occurredAt: latestAt,
      },
      {
        ...base, kind: 'delete', snapshot: { secret: 'must-never-leave' },
        resultingVersion: 4, seq: 7n, occurredAt: deletedAt,
      },
      { ...base, kind: 'restore', resultingVersion: 5, seq: 8n, occurredAt: restoredAt },
      {
        ...base,
        kind: 'link',
        relationTypeId: relation.id,
        linkId: link.id,
        newValue: {
          from_record_id: record.id,
          to_record_id: company.id,
          data: { role: 'classified-edge' },
          position: null,
        },
        resultingVersion: 5,
        seq: 9n,
        occurredAt: linkAt,
      },
    ],
  })
  await db.team.update({ where: { id: tenant.teamId }, data: { feedSeq: 9n } })
  await db.policyRule.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      scope: 'team',
      scopeId: tenant.teamId,
      resourceType: 'attribute',
      action: 'view',
      effect: 'deny',
      conditions: { sensitivity: 'restricted' },
      createdById: 'history_fixture',
      bindings: { create: [{ actorType: 'role', actorId: 'member' }] },
    },
  })
  return {
    ...tenant, recordId: record.id, companyId: company.id,
    firstAt, middleAt, latestAt, deletedAt, restoredAt, linkAt,
  }
}

async function caught(operation: Promise<unknown>): Promise<ServiceError> {
  try {
    await operation
  } catch (error) {
    if (error instanceof ServiceError) return error
    throw error
  }
  throw new Error('Expected service operation to fail')
}

afterAll(async () => {
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('record history service', () => {
  it('returns a middle historical state and retroactively redacts current restricted values', async () => {
    const target = await fixture()
    const result = await recordAt(deps, context(target), {
      recordId: target.recordId,
      at: new Date(target.middleAt.getTime() + 1_000),
    })
    expect(result.record_at.data).toEqual({ name: 'Middle', legacy: 'retained' })
    expect(result.record_at.version_at).toBe(2)
    expect(result.record_at.as_of).toBe('2026-08-24T11:00:01.000Z')
    expect(JSON.stringify(result)).not.toContain('classified')
    expect(JSON.stringify(result)).not.toContain('snapshot')
  })

  it('returns no record before create or during a deleted interval', async () => {
    const target = await fixture()
    const ctx = context(target)
    const before = await caught(recordAt(deps, ctx, {
      recordId: target.recordId,
      at: new Date(target.firstAt.getTime() - 1),
    }))
    const deleted = await caught(recordAt(deps, ctx, {
      recordId: target.recordId,
      at: new Date(target.deletedAt.getTime() + 1),
    }))
    expect(before.code).toBe(ErrorCode.NOT_FOUND)
    expect(deleted.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('binds its opaque cursor to the full canonical argument set', async () => {
    const target = await fixture()
    const ctx = context(target)
    const first = await recordHistory(deps, ctx, { recordId: target.recordId, limit: 1 })
    expect(first.changes).toHaveLength(1)
    expect(first.next_cursor).not.toBeNull()
    const mismatch = await caught(recordHistory(deps, ctx, {
      recordId: target.recordId,
      attributes: ['name'],
      cursor: first.next_cursor ?? undefined,
      limit: 1,
    }))
    expect(mismatch.code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(mismatch.details).toEqual({ detail: 'cursor_mismatch' })
  })

  it('never serializes snapshots or restricted values and rejects a restricted filter', async () => {
    const target = await fixture()
    const ctx = context(target)
    const page = await recordHistory(deps, ctx, { recordId: target.recordId, limit: 50 })
    const json = JSON.stringify(page)
    expect(json).not.toContain('snapshot')
    expect(json).not.toContain('must-never-leave')
    expect(json).not.toContain('classified')
    expect(json).not.toContain('classified-edge')
    const secret = page.changes.find((change) => change.attribute === 'secret')
    expect(secret).toMatchObject({ attribute: 'secret' })
    expect(secret).not.toHaveProperty('old_value')
    expect(secret).not.toHaveProperty('new_value')
    const future = await recordAt(deps, ctx, {
      recordId: target.recordId,
      at: new Date(target.linkAt.getTime() + 1),
    })
    expect(future.record_at.links['company']?.[0]?.data).toEqual({})
    expect(JSON.stringify(future)).not.toContain('classified-edge')
    await db.record.update({
      where: { id: target.companyId },
      data: { visibility: 'private', createdOnBehalfOf: 'another_user' },
    })
    const hiddenLink = await recordAt(deps, ctx, {
      recordId: target.recordId,
      at: new Date(target.linkAt.getTime() + 1),
    })
    expect(hiddenLink.record_at.links).toEqual({})
    const hiddenHistory = await recordHistory(deps, ctx, {
      recordId: target.recordId,
      limit: 50,
    })
    const hiddenChange = hiddenHistory.changes.find((change) => change.link_id !== null)
    expect(hiddenChange).not.toHaveProperty('old_value')
    expect(hiddenChange).not.toHaveProperty('new_value')

    const denied = await caught(recordHistory(deps, ctx, {
      recordId: target.recordId,
      attributes: ['secret'],
    }))
    expect(denied.code).toBe(ErrorCode.POLICY_DENIED)
    expect(await db.auditLog.count({
      where: {
        organizationId: target.organizationId,
        teamId: target.teamId,
        action: 'crm_record_history',
        outcome: 'denied',
      },
    })).toBe(1)
  })
})
