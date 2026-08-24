import { createDb, dropTenant, seedTenant, writeAudit, type Db } from '@deepcrm/db'
import { createProjectionLinkWriter, FakeEmbedder } from '@deepcrm/schema-engine'
import { ErrorCode, parseSecretBox, ServiceError, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { listRecordLinks } from '../../src/services/link-read.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for link read tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')
const keyring = Buffer.from(JSON.stringify({
  active: 'link-read-v1', keys: { 'link-read-v1': Buffer.alloc(32, 9).toString('base64') },
}), 'utf8').toString('base64')
const secretBox = parseSecretBox(keyring)
const deps: AppDeps = {
  db,
  clock: () => now,
  ids: () => crypto.randomUUID(),
  version: '0.0.0',
  maxBulkRows: 10_000,
  embedder: new FakeEmbedder('api-test'),
  orgAllowlist: null,
  linkWriter: createProjectionLinkWriter(),
  historyCursor: createHistoryCursorCodec(secretBox),
  queryCursor: createQueryCursorCodec(secretBox),
  secretBox,
  writeAudit,
}

type Tenant = { organizationId: string; teamId: string }
type Fixture = Tenant & {
  objectTypeId: string
  relationTypeId: string
  anchorId: string
  outgoingId: string
  incomingId: string
  historicalId: string
  privateId: string
  deletedId: string
  mergedId: string
  erasedId: string
}

function context(tenant: Tenant, userId = 'link_read_user'): ActorContext {
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

async function record(
  targetDb: Pick<Db, 'record'>,
  tenant: Tenant,
  objectTypeId: string,
  displayName: string,
  visibility: 'team' | 'private' = 'team',
  owner = 'link_read_user',
) {
  return targetDb.record.create({ data: {
    ...tenant,
    objectTypeId,
    data: { name: displayName },
    displayName,
    visibility,
    createdOnBehalfOf: owner,
    createdByType: 'human',
    createdById: owner,
    createdAt: now,
    updatedAt: now,
  } })
}

async function fixture(): Promise<Fixture> {
  const seeded = await seedTenant(db)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  organizations.push(tenant.organizationId)
  return db.$transaction(async (tx) => {
    const objectType = await tx.objectType.create({ data: {
      ...tenant,
      slug: 'case',
      singularName: 'Case',
      pluralName: 'Cases',
      description: 'Link read case',
      kind: 'custom',
      createdByType: 'system',
      createdById: 'link_read_fixture',
    } })
    const name = await tx.attribute.create({ data: {
      ...tenant,
      objectTypeId: objectType.id,
      slug: 'name',
      name: 'Name',
      description: 'Case name',
      type: 'text',
      config: { maxLength: 120 },
      position: 0,
    } })
    await tx.objectType.update({
      where: { id: objectType.id }, data: { primaryAttributeId: name.id },
    })
    const relation = await tx.relationType.create({ data: {
      ...tenant,
      slug: 'case_related',
      fromObjectTypeId: objectType.id,
      toObjectTypeId: objectType.id,
      forwardName: 'Related',
      inverseName: 'Related from',
      cardinality: 'many_to_many',
      edgeAttributes: [{
        slug: 'role', name: 'Role', description: 'Relationship role', type: 'text',
        config: { maxLength: 40 }, sensitivity: 'restricted',
      }],
    } })
    const [anchor, outgoing, incoming, historical, privateRecord, deleted, merged, erased] = (
      await Promise.all([
        record(tx, tenant, objectType.id, 'Anchor'),
        record(tx, tenant, objectType.id, 'Outgoing'),
        record(tx, tenant, objectType.id, 'Incoming'),
        record(tx, tenant, objectType.id, 'Historical'),
        record(tx, tenant, objectType.id, 'Private', 'private', 'other_user'),
        record(tx, tenant, objectType.id, 'Deleted'),
        record(tx, tenant, objectType.id, 'Merged'),
        record(tx, tenant, objectType.id, 'Erased'),
      ])
    )
    await tx.record.update({ where: { id: deleted.id }, data: { deletedAt: now } })
    await tx.record.update({ where: { id: merged.id }, data: { mergedIntoId: outgoing.id } })
    await tx.record.update({ where: { id: erased.id }, data: { erasedAt: now, deletedAt: now } })
    const link = (
      fromRecordId: string,
      toRecordId: string,
      activeFrom: string,
      activeUntil?: string,
    ) => tx.recordLink.create({ data: {
      ...tenant,
      relationTypeId: relation.id,
      fromRecordId,
      toRecordId,
      data: { role: 'stakeholder' },
      activeFrom: new Date(activeFrom),
      ...(activeUntil === undefined ? {} : { activeUntil: new Date(activeUntil) }),
      createdByType: 'system',
      createdById: 'link_read_fixture',
    } })
    await Promise.all([
      link(anchor.id, outgoing.id, '2026-08-24T11:59:00.000Z'),
      link(incoming.id, anchor.id, '2026-08-24T11:58:00.000Z'),
      link(anchor.id, historical.id, '2026-08-24T11:57:00.000Z', '2026-08-24T11:57:30.000Z'),
      link(anchor.id, privateRecord.id, '2026-08-24T11:56:00.000Z'),
      link(anchor.id, deleted.id, '2026-08-24T11:55:00.000Z'),
      link(anchor.id, merged.id, '2026-08-24T11:54:00.000Z'),
      link(anchor.id, erased.id, '2026-08-24T11:53:00.000Z'),
    ])
    await tx.team.update({ where: { id: tenant.teamId }, data: { schemaVersion: 1 } })
    return {
      ...tenant,
      objectTypeId: objectType.id,
      relationTypeId: relation.id,
      anchorId: anchor.id,
      outgoingId: outgoing.id,
      incomingId: incoming.id,
      historicalId: historical.id,
      privateId: privateRecord.id,
      deletedId: deleted.id,
      mergedId: merged.id,
      erasedId: erased.id,
    }
  })
}

async function policy(
  target: Fixture,
  resourceType: 'record' | 'link' | 'attribute',
  scope: 'team' | 'record',
  scopeId: string,
  requiresApproval = false,
): Promise<void> {
  await db.policyRule.create({ data: {
    organizationId: target.organizationId,
    teamId: target.teamId,
    scope,
    scopeId,
    resourceType,
    action: 'view',
    effect: 'deny',
    priority: 100,
    requiresApproval,
    ...(resourceType === 'attribute' ? { conditions: { sensitivity: 'restricted' } } : {}),
    createdById: 'link_read_fixture',
    bindings: { create: [{ actorType: 'role', actorId: 'member' }] },
  } })
}

async function caught(operation: Promise<unknown>): Promise<ServiceError> {
  try {
    await operation
  } catch (error) {
    if (error instanceof ServiceError) return error
    throw error
  }
  throw new Error('Expected link list to fail')
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizations } } })
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('link read service', () => {
  it('applies direction, relation and history while omitting non-live related records', async () => {
    const target = await fixture()
    const ctx = context(target)
    const active = await listRecordLinks(deps, ctx, { recordId: target.anchorId })
    expect(active.links.map((item) => item.related.id)).toEqual([
      target.outgoingId, target.incomingId,
    ])
    expect(active.links[0]?.link).toMatchObject({
      relation_type: 'case_related',
      data: { role: 'stakeholder' },
      active_until: null,
    })
    expect(active.links[0]?.related).toEqual({
      id: target.outgoingId, object_type: 'case', display_name: 'Outgoing',
    })
    expect((await listRecordLinks(deps, ctx, {
      recordId: target.anchorId, direction: 'from', relationType: 'case_related',
    })).links.map((item) => item.related.id)).toEqual([target.outgoingId])
    expect((await listRecordLinks(deps, ctx, {
      recordId: target.anchorId, direction: 'to',
    })).links.map((item) => item.related.id)).toEqual([target.incomingId])
    expect((await listRecordLinks(deps, ctx, {
      recordId: target.anchorId, includeHistory: true,
    })).links.map((item) => item.related.id)).toEqual([
      target.outgoingId, target.incomingId, target.historicalId,
    ])
  })

  it('paginates permitted rows deterministically and binds cursors to every argument', async () => {
    const target = await fixture()
    const ctx = context(target)
    const first = await listRecordLinks(deps, ctx, { recordId: target.anchorId, limit: 1 })
    expect(first.links.map((item) => item.related.id)).toEqual([target.outgoingId])
    expect(first.next_cursor).not.toBeNull()
    const second = await listRecordLinks(deps, ctx, {
      recordId: target.anchorId, limit: 1, cursor: first.next_cursor ?? undefined,
    })
    expect(second.links.map((item) => item.related.id)).toEqual([target.incomingId])
    expect(second.next_cursor).toBeNull()
    const mismatch = await caught(listRecordLinks(deps, ctx, {
      recordId: target.anchorId,
      limit: 2,
      cursor: first.next_cursor ?? undefined,
    }))
    expect(mismatch).toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
      details: { detail: 'cursor_mismatch' },
    })
  })

  it('filters related record and link policies, and redacts edge attributes', async () => {
    const target = await fixture()
    const ctx = context(target)
    await policy(target, 'record', 'record', target.incomingId)
    let result = await listRecordLinks(deps, ctx, { recordId: target.anchorId })
    expect(result.links.map((item) => item.related.id)).toEqual([target.outgoingId])
    await policy(target, 'attribute', 'team', target.teamId)
    result = await listRecordLinks(deps, ctx, { recordId: target.anchorId })
    expect(result.links[0]?.link.data).toEqual({})
    await policy(target, 'link', 'record', target.outgoingId)
    result = await listRecordLinks(deps, ctx, { recordId: target.anchorId })
    expect(result.links).toEqual([])
  })

  it('gates the anchor by visibility before policy and audits a visible policy denial once', async () => {
    const target = await fixture()
    const other = await fixture()
    const privateError = await caught(listRecordLinks(deps, context(target), {
      recordId: target.privateId,
    }))
    expect(privateError.code).toBe(ErrorCode.NOT_FOUND)
    const tenantError = await caught(listRecordLinks(deps, context(other), {
      recordId: target.anchorId,
    }))
    expect(tenantError.code).toBe(ErrorCode.NOT_FOUND)
    await policy(target, 'record', 'record', target.anchorId, true)
    const before = await db.auditLog.count({ where: {
      organizationId: target.organizationId,
      teamId: target.teamId,
      action: 'crm_links_list',
    } })
    const denied = await caught(listRecordLinks(deps, context(target), {
      recordId: target.anchorId,
    }))
    expect(denied.code).toBe(ErrorCode.APPROVAL_REQUIRED)
    expect(await db.auditLog.count({ where: {
      organizationId: target.organizationId,
      teamId: target.teamId,
      action: 'crm_links_list',
    } })).toBe(before + 1)
  })

  it('rejects invalid input and resolves a merged anchor to its survivor', async () => {
    const target = await fixture()
    const invalid = await caught(listRecordLinks(deps, context(target), {
      recordId: target.anchorId, limit: 0,
    }))
    expect(invalid.code).toBe(ErrorCode.VALIDATION_FAILED)
    const merged = await listRecordLinks(deps, context(target), {
      recordId: target.mergedId,
    })
    expect(merged).toMatchObject({
      links: [{ related: { id: target.anchorId } }],
    })
  })
})
