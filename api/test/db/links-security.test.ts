import { createDb } from '@deepcrm/db'
import { ServiceError } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { linkRecords, unlinkRecords } from '../../src/services/links.js'
import {
  addLinkPolicy,
  createLinkFixture,
  dropLinkFixture,
  linkContext,
  linkDeps,
  type LinkTenant,
} from './link-fixture.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for link security tests')
const db = createDb(databaseUrl)
const organizations: LinkTenant[] = []

async function fixture() {
  const created = await createLinkFixture(db)
  organizations.push(created.tenant)
  return created
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

async function state(tenant: LinkTenant) {
  const [links, changes, jobs, replays, audits] = await Promise.all([
    db.recordLink.count({ where: tenant }),
    db.recordChange.count({ where: tenant }),
    db.queueJob.count({ where: tenant }),
    db.idempotencyReplay.count({ where: tenant }),
    db.auditLog.count({ where: tenant }),
  ])
  return { links, changes, jobs, replays, audits }
}

afterAll(async () => {
  for (const tenant of organizations) await dropLinkFixture(db, tenant)
  await db.$disconnect()
})

describe('link service security boundaries', () => {
  it('returns NOT_FOUND before policy for either submitted endpoint and cross-tenant ids', async () => {
    const target = await fixture()
    const foreign = await fixture()
    const deps = linkDeps(db)
    const ctx = linkContext(target.tenant, 'uoa_link_caller')
    await addLinkPolicy(db, target.tenant, 'record', 'deny', ctx.onBehalfOf.uoaUserId)

    await db.record.update({
      where: { id: target.people[0]! },
      data: { visibility: 'private', createdOnBehalfOf: 'uoa_hidden_owner' },
    })
    const before = await state(target.tenant)
    await expect(linkRecords(deps, ctx, {
      relationType: 'many_many',
      fromRecordId: target.people[0]!,
      toRecordId: target.companies[0]!,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await state(target.tenant)).toEqual(before)

    await db.record.update({
      where: { id: target.people[0]! },
      data: { visibility: 'team' },
    })
    await db.record.update({
      where: { id: target.companies[0]! },
      data: { visibility: 'private', createdOnBehalfOf: 'uoa_hidden_owner' },
    })
    await expect(linkRecords(deps, ctx, {
      relationType: 'many_many',
      fromRecordId: target.people[0]!,
      toRecordId: target.companies[0]!,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await state(target.tenant)).toEqual(before)

    await expect(linkRecords(deps, ctx, {
      relationType: 'many_many',
      fromRecordId: target.people[1]!,
      toRecordId: foreign.companies[0]!,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await state(target.tenant)).toEqual(before)
  })

  it('checks conflict-linked endpoints under lock without leaking or partially replacing', async () => {
    const target = await fixture()
    const deps = linkDeps(db)
    const ctx = linkContext(target.tenant)
    const original = await linkRecords(deps, ctx, {
      relationType: 'many_one',
      fromRecordId: target.people[0]!,
      toRecordId: target.companies[0]!,
    })
    await db.record.update({
      where: { id: target.companies[0]! },
      data: { visibility: 'private', createdOnBehalfOf: 'uoa_hidden_owner' },
    })
    const before = await state(target.tenant)
    const versions = await db.record.findMany({
      where: {
        ...target.tenant,
        id: { in: [target.people[0]!, target.companies[0]!, target.companies[1]!] },
      },
      select: { id: true, version: true },
      orderBy: { id: 'asc' },
    })

    const error = await caught(linkRecords(deps, ctx, {
      relationType: 'many_one',
      fromRecordId: target.people[0]!,
      toRecordId: target.companies[1]!,
      idempotencyKey: 'hidden-conflict',
    }))
    expect(error).toMatchObject({ code: 'NOT_FOUND', details: {} })
    expect(await state(target.tenant)).toEqual(before)
    expect(await db.record.findMany({
      where: {
        ...target.tenant,
        id: { in: [target.people[0]!, target.companies[0]!, target.companies[1]!] },
      },
      select: { id: true, version: true },
      orderBy: { id: 'asc' },
    })).toEqual(versions)
    await expect(db.recordLink.findUniqueOrThrow({ where: { id: original.link.id } }))
      .resolves.toMatchObject({ activeUntil: null })
  })

  it('rechecks submitted endpoint and link policy after engine record locks', async () => {
    const target = await fixture()
    const userId = 'uoa_link_policy_race'
    let recordLinkReads = 0
    let injected = false
    const checkedDb = db.$extends({
      name: 'link-policy-race',
      query: {
        async $allOperations({ model, operation, args, query }) {
          const result = await query(args)
          if (model === 'RecordLink' && operation === 'findMany') {
            recordLinkReads += 1
            if (recordLinkReads === 2) {
              injected = true
              await addLinkPolicy(db, target.tenant, 'link', 'deny', userId)
            }
          }
          return result
        },
      },
    })
    const deps: AppDeps = { ...linkDeps(db), db: checkedDb }

    await expect(linkRecords(deps, linkContext(target.tenant, userId), {
      relationType: 'many_many',
      fromRecordId: target.people[0]!,
      toRecordId: target.companies[0]!,
      idempotencyKey: 'policy-race',
    })).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { resource: 'link' } })
    expect(injected).toBe(true)
    expect(await state(target.tenant)).toEqual({
      links: 0, changes: 0, jobs: 0, replays: 0, audits: 1,
    })
  })

  it('writes exactly one denied audit and no mutation for record policy denial', async () => {
    const target = await fixture()
    const userId = 'uoa_link_denied'
    await addLinkPolicy(db, target.tenant, 'record', 'deny', userId)

    const error = await caught(linkRecords(linkDeps(db), linkContext(target.tenant, userId), {
      relationType: 'many_many',
      fromRecordId: target.people[0]!,
      toRecordId: target.companies[0]!,
      idempotencyKey: 'denied-link',
    }))
    expect(error).toMatchObject({ code: 'POLICY_DENIED', details: { resource: 'record' } })
    expect(await state(target.tenant)).toEqual({
      links: 0, changes: 0, jobs: 0, replays: 0, audits: 1,
    })
  })

  it('rechecks policy before completed link and unlink replays after rights are revoked', async () => {
    const target = await fixture()
    const userId = 'uoa_link_replay_user'
    const deps = linkDeps(db)
    const ctx = linkContext(target.tenant, userId)
    const input = {
      relationType: 'many_many',
      fromRecordId: target.people[0]!,
      toRecordId: target.companies[0]!,
      idempotencyKey: 'revoked-replay',
    }
    const linked = await linkRecords(deps, ctx, input)
    const unlinkInput = { linkId: linked.link.id, idempotencyKey: 'revoked-unlink-replay' }
    await unlinkRecords(deps, ctx, unlinkInput)
    await addLinkPolicy(db, target.tenant, 'link', 'deny', userId)
    const before = await state(target.tenant)

    await expect(linkRecords(deps, ctx, input)).rejects.toMatchObject({
      code: 'POLICY_DENIED', details: { resource: 'link' },
    })
    await expect(unlinkRecords(deps, ctx, unlinkInput)).rejects.toMatchObject({
      code: 'POLICY_DENIED', details: { resource: 'link' },
    })
    expect(await state(target.tenant)).toEqual({ ...before, audits: before.audits + 2 })
  })

  it('enforces confidential edge attribute denial and approval before reservation', async () => {
    const denied = await fixture()
    const deniedUser = 'uoa_edge_denied'
    await addLinkPolicy(db, denied.tenant, 'attribute', 'deny', deniedUser, false, 'confidential')
    const deniedError = await caught(linkRecords(linkDeps(db), linkContext(denied.tenant, deniedUser), {
      relationType: 'edge_many',
      fromRecordId: denied.people[0]!,
      toRecordId: denied.companies[0]!,
      data: { role: 'buyer' },
      idempotencyKey: 'edge-denied',
    }))
    expect(deniedError).toMatchObject({ code: 'POLICY_DENIED', details: { resource: 'attribute' } })
    expect(await state(denied.tenant)).toEqual({
      links: 0, changes: 0, jobs: 0, replays: 0, audits: 1,
    })

    const approval = await fixture()
    const approvalUser = 'uoa_edge_approval'
    await addLinkPolicy(
      db, approval.tenant, 'attribute', 'deny', approvalUser, true, 'confidential',
    )
    await expect(linkRecords(linkDeps(db), linkContext(approval.tenant, approvalUser), {
      relationType: 'edge_many',
      fromRecordId: approval.people[0]!,
      toRecordId: approval.companies[0]!,
      data: { role: 'buyer' },
    })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED', details: { resource: 'attribute' } })
    expect(await state(approval.tenant)).toEqual({
      links: 0, changes: 0, jobs: 0, replays: 0, audits: 1,
    })
  })

  it('applies policy and tenant visibility to unlink by id', async () => {
    const target = await fixture()
    const foreign = await fixture()
    const deps = linkDeps(db)
    const owner = linkContext(target.tenant)
    const linked = await linkRecords(deps, owner, {
      relationType: 'many_many',
      fromRecordId: target.people[0]!,
      toRecordId: target.companies[0]!,
    })
    await expect(unlinkRecords(linkDeps(db), linkContext(foreign.tenant), {
      linkId: linked.link.id,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const deniedUser = 'uoa_unlink_denied'
    await addLinkPolicy(db, target.tenant, 'link', 'deny', deniedUser)
    const before = await state(target.tenant)
    await expect(unlinkRecords(deps, linkContext(target.tenant, deniedUser), {
      linkId: linked.link.id,
      idempotencyKey: 'unlink-denied',
    })).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    expect(await state(target.tenant)).toEqual({ ...before, audits: before.audits + 1 })
    await expect(db.recordLink.findUniqueOrThrow({ where: { id: linked.link.id } }))
      .resolves.toMatchObject({ activeUntil: null })
  })
})
