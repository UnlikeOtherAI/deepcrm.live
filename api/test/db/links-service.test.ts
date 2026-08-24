import { createDb, seedTenant, writeAudit } from '@deepcrm/db'
import { applyTemplate } from '@deepcrm/schema-engine'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { linkRecords, unlinkRecords } from '../../src/services/links.js'
import {
  createRecord, deleteRecord, restoreRecord, updateRecord,
} from '../../src/services/records.js'
import {
  createLinkFixture,
  dropLinkFixture,
  linkContext,
  linkDeps,
  type LinkTenant,
} from './link-fixture.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for link service tests')
const db = createDb(databaseUrl)
const organizations: LinkTenant[] = []

async function fixture() {
  const created = await createLinkFixture(db)
  organizations.push(created.tenant)
  return created
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolver: (() => void) | undefined
  const promise = new Promise<void>((resolve) => { resolver = resolve })
  return {
    promise,
    resolve: () => {
      if (resolver === undefined) throw new Error('Deferred promise is not initialized')
      resolver()
    },
  }
}

afterAll(async () => {
  for (const tenant of organizations) await dropLinkFixture(db, tenant)
  await db.$disconnect()
})

describe('direct link service', () => {
  it('projects record_reference writes through the required AppDeps LinkWriter', async () => {
    const seeded = await seedTenant(db)
    const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
    organizations.push(tenant)
    const ctx = linkContext(tenant)
    await db.$transaction((tx) => applyTemplate(tx, tenant, {
      type: 'system', id: 'link_fixture', onBehalfOf: null, requestId: ctx.requestId,
    }, 'standard_crm'))
    const deps = linkDeps(db)
    const company = await createRecord(deps, ctx, {
      objectType: 'company', data: { name: 'Analytical Engines' },
    })
    const person = await createRecord(deps, ctx, {
      objectType: 'person', data: { name: { full: 'Ada Lovelace' }, company: company.record.id },
    })

    const projected = await db.recordLink.findFirstOrThrow({
      where: {
        organizationId: tenant.organizationId,
        teamId: tenant.teamId,
        fromRecordId: person.record.id,
        toRecordId: company.record.id,
        relationType: { slug: 'person_works_at' },
        activeUntil: null,
      },
    })
    const personRule = await db.matchingRule.findFirstOrThrow({
      where: {
        ...tenant, objectType: { slug: 'person' }, position: 1,
        generation: { state: 'active' },
      },
    })
    const matchingRows = () => db.recordMatchLookupKey.count({
      where: { ...tenant, recordId: person.record.id, matchingRuleId: personRule.id },
    })
    expect(await matchingRows()).toBe(1)
    await updateRecord(deps, ctx, {
      recordId: person.record.id,
      expectedVersion: person.record.version,
      data: { company: null },
    })
    await expect(db.recordLink.findUniqueOrThrow({ where: { id: projected.id } }))
      .resolves.toMatchObject({ activeUntil: expect.any(Date) })
    expect(await matchingRows()).toBe(0)

    const direct = await linkRecords(deps, ctx, {
      relationType: 'person_works_at',
      fromRecordId: person.record.id,
      toRecordId: company.record.id,
    })
    expect(await matchingRows()).toBe(1)
    await unlinkRecords(deps, ctx, { linkId: direct.link.id })
    expect(await matchingRows()).toBe(0)
    await linkRecords(deps, ctx, {
      relationType: 'person_works_at',
      fromRecordId: person.record.id,
      toRecordId: company.record.id,
    })
    expect(await matchingRows()).toBe(1)
    for (const action of ['delete', 'restore'] as const) {
      await db.policyRule.create({
        data: {
          ...tenant, scope: 'team', scopeId: tenant.teamId, resourceType: 'record',
          action, effect: 'allow', priority: 1_000, createdById: 'matching_refresh_test',
          bindings: { create: [{ actorType: 'human', actorId: ctx.actor.id }] },
        },
      })
    }
    const currentCompany = await db.record.findUniqueOrThrow({ where: { id: company.record.id } })
    const deleted = await deleteRecord(deps, ctx, {
      recordId: company.record.id, expectedVersion: currentCompany.version,
    })
    expect(await matchingRows()).toBe(0)
    await restoreRecord(deps, ctx, {
      recordId: company.record.id, expectedVersion: deleted.record.version,
    })
    expect(await matchingRows()).toBe(1)
  })

  it('enforces all cardinalities and reports every replacement compactly', async () => {
    const target = await fixture()
    const deps = linkDeps(db)
    const ctx = linkContext(target.tenant)

    const manyA = await linkRecords(deps, ctx, {
      relationType: 'many_many', fromRecordId: target.people[0]!, toRecordId: target.companies[0]!,
    })
    const manyB = await linkRecords(deps, ctx, {
      relationType: 'many_many', fromRecordId: target.people[0]!, toRecordId: target.companies[1]!,
    })
    expect(manyA.ended_links).toEqual([])
    expect(manyB.ended_links).toEqual([])

    const outgoingA = await linkRecords(deps, ctx, {
      relationType: 'many_one', fromRecordId: target.people[1]!, toRecordId: target.companies[0]!,
    })
    const outgoingB = await linkRecords(deps, ctx, {
      relationType: 'many_one', fromRecordId: target.people[1]!, toRecordId: target.companies[1]!,
    })
    expect(outgoingB.ended_links).toEqual([outgoingA.link.id])

    const incomingA = await linkRecords(deps, ctx, {
      relationType: 'one_many', fromRecordId: target.people[2]!, toRecordId: target.companies[2]!,
    })
    const incomingB = await linkRecords(deps, ctx, {
      relationType: 'one_many', fromRecordId: target.people[3]!, toRecordId: target.companies[2]!,
    })
    expect(incomingB.ended_links).toEqual([incomingA.link.id])

    const oneA = await linkRecords(deps, ctx, {
      relationType: 'one_one', fromRecordId: target.people[2]!, toRecordId: target.companies[3]!,
    })
    const oneB = await linkRecords(deps, ctx, {
      relationType: 'one_one', fromRecordId: target.people[3]!, toRecordId: target.companies[3]!,
    })
    const oneC = await linkRecords(deps, ctx, {
      relationType: 'one_one', fromRecordId: target.people[3]!, toRecordId: target.companies[0]!,
    })
    expect(oneB.ended_links).toEqual([oneA.link.id])
    expect(oneC.ended_links).toEqual([oneB.link.id])

    const active = await db.recordLink.findMany({
      where: { ...target.tenant, activeUntil: null },
      select: { relationTypeId: true, fromRecordId: true, toRecordId: true },
    })
    expect(active.filter((link) => link.relationTypeId === target.relations.manyMany)).toHaveLength(2)
    expect(active.filter((link) => link.relationTypeId === target.relations.manyOne)).toEqual([
      expect.objectContaining({ fromRecordId: target.people[1], toRecordId: target.companies[1] }),
    ])
    expect(active.filter((link) => link.relationTypeId === target.relations.oneMany)).toEqual([
      expect.objectContaining({ fromRecordId: target.people[3], toRecordId: target.companies[2] }),
    ])
    expect(active.filter((link) => link.relationTypeId === target.relations.oneOne)).toEqual([
      expect.objectContaining({ fromRecordId: target.people[3], toRecordId: target.companies[0] }),
    ])
  })

  it('writes edge data, paired feed rows, endpoint jobs, replay, then audit literally last', async () => {
    const target = await fixture()
    const trace: string[] = []
    const tracedDb = db.$extends({
      name: 'link-audit-terminal-trace',
      query: {
        async $allOperations({ model, operation, args, query }) {
          const result = await query(args)
          trace.push(`${model ?? 'client'}.${operation}`)
          return result
        },
      },
    })
    const deps: AppDeps = { ...linkDeps(db), db: tracedDb, writeAudit }
    const result = await linkRecords(deps, linkContext(target.tenant), {
      relationType: 'edge_many',
      fromRecordId: target.people[0]!,
      toRecordId: target.companies[0]!,
      data: { role: 'buyer' },
      label: 'primary',
      idempotencyKey: 'edge-link',
      reason: 'edge reason',
    })

    const link = await db.recordLink.findUniqueOrThrow({ where: { id: result.link.id } })
    const changes = await db.recordChange.findMany({
      where: { ...target.tenant, linkId: result.link.id }, orderBy: { seq: 'asc' },
    })
    const records = await db.record.findMany({
      where: { ...target.tenant, id: { in: [target.people[0]!, target.companies[0]!] } },
    })
    expect(link).toMatchObject({ data: { role: 'buyer' }, label: 'primary' })
    expect(result.link).toMatchObject({
      relation_type: 'edge_many',
      from_record_id: target.people[0],
      to_record_id: target.companies[0],
      data: { role: 'buyer' },
      label: 'primary',
      active_until: null,
    })
    expect(result.link.active_from).toBe(link.activeFrom.toISOString())
    expect(changes).toHaveLength(2)
    expect(changes.map((change) => change.kind)).toEqual(['link', 'link'])
    expect(new Set(changes.map((change) => change.groupId)).size).toBe(1)
    expect(changes.map((change) => Number(change.seq))).toEqual([1, 2])
    expect(changes.every((change) => change.reason === 'edge reason')).toBe(true)
    for (const change of changes) {
      expect(change.resultingVersion).toBe(records.find((record) => record.id === change.recordId)?.version)
    }
    const jobs = await db.queueJob.findMany({
      where: { ...target.tenant, type: 'record.reindex' }, select: { payload: true },
    })
    expect(jobs).toHaveLength(2)
    expect(jobs.map((job) => job.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordId: target.people[0] }),
      expect.objectContaining({ recordId: target.companies[0] }),
    ]))
    await expect(db.idempotencyReplay.findFirstOrThrow({
      where: { ...target.tenant, key: 'edge-link' },
    })).resolves.toMatchObject({ result })
    const replayAt = trace.lastIndexOf('IdempotencyReplay.updateMany')
    const jobAt = Math.max(trace.lastIndexOf('QueueJob.create'), trace.lastIndexOf('QueueJob.createMany'))
    const auditAt = trace.lastIndexOf('AuditLog.create')
    expect(auditAt).toBeGreaterThan(replayAt)
    expect(auditAt).toBeGreaterThan(jobAt)
    expect(auditAt).toBe(trace.length - 1)
  })

  it('supports completed, mismatch, in-progress, and deterministic no-op replay', async () => {
    const target = await fixture()
    const ctx = linkContext(target.tenant)
    const baseDeps = linkDeps(db)
    const input = {
      relationType: 'many_many',
      fromRecordId: target.people[0]!,
      toRecordId: target.companies[0]!,
      idempotencyKey: 'completed-link',
    }
    const first = await linkRecords(baseDeps, ctx, input)
    await expect(linkRecords(baseDeps, ctx, input)).resolves.toEqual(first)
    await expect(linkRecords(baseDeps, ctx, { ...input, label: 'different' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_MISMATCH',
    })
    const beforeNoop = await Promise.all([
      db.recordChange.count({ where: target.tenant }),
      db.queueJob.count({ where: target.tenant }),
      db.auditLog.count({ where: target.tenant }),
    ])
    const noopInput = { ...input, idempotencyKey: 'noop-link' }
    const noop = await linkRecords(baseDeps, ctx, noopInput)
    const noopReplay = await linkRecords(baseDeps, ctx, noopInput)
    expect(noop).toEqual(noopReplay)
    expect(noop.changed).toBe(false)
    expect(await Promise.all([
      db.recordChange.count({ where: target.tenant }),
      db.queueJob.count({ where: target.tenant }),
      db.auditLog.count({ where: target.tenant }),
    ])).toEqual(beforeNoop)

    const entered = deferred()
    const release = deferred()
    let blocked = false
    const heldContext = linkContext(target.tenant)
    const heldDeps: AppDeps = {
      ...baseDeps,
      writeAudit: async (tx, entry) => {
        if (!blocked && entry.requestId === heldContext.requestId) {
          blocked = true
          entered.resolve()
          await release.promise
        }
        return writeAudit(tx, entry)
      },
    }
    const heldInput = {
      relationType: 'many_many',
      fromRecordId: target.people[1]!,
      toRecordId: target.companies[1]!,
      idempotencyKey: 'held-link',
    }
    const held = linkRecords(heldDeps, heldContext, heldInput)
    await entered.promise
    try {
      await expect(linkRecords(heldDeps, heldContext, heldInput)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_IN_PROGRESS',
      })
    } finally {
      release.resolve()
    }
    await expect(held).resolves.toMatchObject({ changed: true })
  })

  it('unlinks by id or triple and replays the completed result', async () => {
    const target = await fixture()
    const deps = linkDeps(db)
    const ctx = linkContext(target.tenant)
    const first = await linkRecords(deps, ctx, {
      relationType: 'many_many', fromRecordId: target.people[0]!, toRecordId: target.companies[0]!,
    })
    const byIdInput = { linkId: first.link.id, idempotencyKey: 'unlink-id', reason: 'unlink id' }
    const byId = await unlinkRecords(deps, ctx, byIdInput)
    await expect(unlinkRecords(deps, ctx, byIdInput)).resolves.toEqual(byId)
    expect(byId).toMatchObject({ changed: true, ended_links: [first.link.id] })

    const second = await linkRecords(deps, ctx, {
      relationType: 'many_many', fromRecordId: target.people[1]!, toRecordId: target.companies[1]!,
    })
    const byTriple = await unlinkRecords(deps, ctx, {
      relationType: 'many_many',
      fromRecordId: target.people[1]!,
      toRecordId: target.companies[1]!,
      reason: 'unlink triple',
    })
    expect(byTriple.ended_links).toEqual([second.link.id])
    expect(await db.recordLink.count({ where: { ...target.tenant, activeUntil: null } })).toBe(0)
  })
})
