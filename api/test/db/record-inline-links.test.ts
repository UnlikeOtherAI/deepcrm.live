import {
  createDb,
  type PolicyAction,
  type PolicyEffect,
  type PolicyResourceType,
} from '@deepcrm/db'
import { ServiceError } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import { createRecord, updateRecord } from '../../src/services/records.js'
import {
  createLinkFixture,
  dropLinkFixture,
  linkContext,
  linkDeps,
  type LinkTenant,
} from './link-fixture.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for inline link tests')

const db = createDb(databaseUrl)
const tenants: LinkTenant[] = []

async function fixture() {
  const created = await createLinkFixture(db)
  tenants.push(created.tenant)
  return created
}

async function addPolicy(
  target: LinkTenant,
  userId: string,
  resourceType: PolicyResourceType,
  action: PolicyAction,
  effect: PolicyEffect = 'allow',
  requiresApproval = false,
): Promise<void> {
  await db.policyRule.create({
    data: {
      ...target,
      scope: 'team',
      scopeId: target.teamId,
      resourceType,
      action,
      effect,
      priority: effect === 'deny' ? 200 : 100,
      requiresApproval,
      createdById: 'record_inline_fixture',
      bindings: { create: [{ actorType: 'human', actorId: userId }] },
    },
  })
}

async function allowRecordWrites(target: LinkTenant, userId: string): Promise<void> {
  await Promise.all([
    addPolicy(target, userId, 'record', 'create'),
    addPolicy(target, userId, 'record', 'edit'),
    addPolicy(target, userId, 'record', 'view'),
    addPolicy(target, userId, 'record', 'link'),
    addPolicy(target, userId, 'link', 'link'),
  ])
}

function firstCompany(ids: readonly string[]): string {
  const id = ids[0]
  if (id === undefined) throw new Error('Link fixture did not create a company')
  return id
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

function rowCounts(target: LinkTenant): Promise<[number, number, number, number, number]> {
  const where = { organizationId: target.organizationId, teamId: target.teamId }
  return Promise.all([
    db.record.count({ where }),
    db.recordLink.count({ where }),
    db.recordChange.count({ where }),
    db.queueJob.count({ where }),
    db.auditLog.count({ where }),
  ])
}

afterAll(async () => {
  for (const target of tenants) await dropLinkFixture(db, target)
  await db.$disconnect()
})

describe('record inline-link security and metadata', () => {
  it('rechecks link policy inside the write transaction under resolved locks', async () => {
    const target = await fixture()
    const userId = 'uoa_inline_recheck'
    await allowRecordWrites(target.tenant, userId)
    let linkPolicyReads = 0
    const observed = db.$extends({
      query: {
        policyRule: {
          async findMany({ args, query }) {
            if (JSON.stringify(args).includes('"action":"link"')) linkPolicyReads += 1
            return query(args)
          },
        },
      },
    })
    const result = await createRecord(linkDeps(observed), linkContext(target.tenant, userId), {
      objectType: 'person',
      data: {},
      links: [{ relationType: 'many_many', toRecordId: firstCompany(target.companies) }],
    })

    expect(result.record.version).toBe(2)
    expect(linkPolicyReads).toBe(2)
    expect(await db.recordLink.count({
      where: { ...target.tenant, fromRecordId: result.record.id, activeUntil: null },
    })).toBe(1)
  })

  it('applies global hard-deny precedence and rolls back every write', async () => {
    const target = await fixture()
    const userId = 'uoa_inline_denied'
    await allowRecordWrites(target.tenant, userId)
    await addPolicy(target.tenant, userId, 'record', 'link', 'deny', true)
    await addPolicy(target.tenant, userId, 'link', 'link', 'deny')
    const before = await rowCounts(target.tenant)

    const error = await caught(createRecord(linkDeps(db), linkContext(target.tenant, userId), {
      objectType: 'person',
      data: {},
      links: [{ relationType: 'many_many', toRecordId: firstCompany(target.companies) }],
      idempotencyKey: 'inline-denied-0001',
    }))

    expect(error.code).toBe('POLICY_DENIED')
    const after = await rowCounts(target.tenant)
    expect(after.slice(0, 4)).toEqual(before.slice(0, 4))
    expect(after[4]).toBe((before[4] ?? 0) + 1)
  })

  it('returns NOT_FOUND for an invisible target without a denial audit or partial write', async () => {
    const target = await fixture()
    const userId = 'uoa_inline_hidden'
    await allowRecordWrites(target.tenant, userId)
    const targetId = firstCompany(target.companies)
    await db.record.update({ where: { id: targetId }, data: { visibility: 'private' } })
    const before = await rowCounts(target.tenant)

    const error = await caught(createRecord(linkDeps(db), linkContext(target.tenant, userId), {
      objectType: 'person', data: {},
      links: [{ relationType: 'many_many', toRecordId: targetId }],
    }))

    expect(error.code).toBe('NOT_FOUND')
    expect(await rowCounts(target.tenant)).toEqual(before)
  })

  it('reauthorizes a completed replay after link rights are revoked', async () => {
    const target = await fixture()
    const userId = 'uoa_inline_replay'
    await allowRecordWrites(target.tenant, userId)
    const input = {
      objectType: 'person',
      data: {},
      links: [{ relationType: 'many_many', toRecordId: firstCompany(target.companies) }],
      idempotencyKey: 'inline-replay-0001',
    }
    const first = await createRecord(linkDeps(db), linkContext(target.tenant, userId), input)
    const before = await rowCounts(target.tenant)
    await addPolicy(target.tenant, userId, 'link', 'link', 'deny')

    await expect(createRecord(
      linkDeps(db), linkContext(target.tenant, userId), input,
    )).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    const after = await rowCounts(target.tenant)

    expect(first.changed).toBe(true)
    expect(after.slice(0, 4)).toEqual(before.slice(0, 4))
    expect(after[4]).toBe((before[4] ?? 0) + 1)
  })

  it('versions metadata-only changes and clears grants for explicit visibility', async () => {
    const target = await fixture()
    const userId = 'uoa_inline_metadata'
    await allowRecordWrites(target.tenant, userId)
    await db.principalLastSeen.create({
      data: { teamId: target.tenant.teamId, uoaUserId: 'uoa_grantee', lastSeenAt: linkContext(target.tenant).now },
    })
    const created = await createRecord(linkDeps(db), linkContext(target.tenant, userId), {
      objectType: 'person', data: {}, visibleTo: ['uoa_grantee'],
    })
    expect(created.record.visibility).toBe('users')
    expect(await db.recordVisibilityGrant.count({ where: { recordId: created.record.id } })).toBe(1)
    const changeWhere = { ...target.tenant, recordId: created.record.id }
    const beforeChanges = await db.recordChange.count({ where: changeWhere })

    const updated = await updateRecord(linkDeps(db), linkContext(target.tenant, userId), {
      recordId: created.record.id,
      data: {},
      visibility: 'private',
      expectedVersion: created.record.version,
    })

    expect(updated).toMatchObject({ changed: true, record: { visibility: 'private', version: 2 } })
    expect(await db.recordVisibilityGrant.count({ where: { recordId: created.record.id } })).toBe(0)
    expect(await db.recordChange.count({ where: changeWhere }))
      .toBe(beforeChanges + 2)
  })
})
