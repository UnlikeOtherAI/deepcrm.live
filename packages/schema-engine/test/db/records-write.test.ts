import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import {
  applyTemplate,
  assertRecord,
  createRecord,
  deleteRecord,
  loadSchema,
  restoreRecord,
  updateRecord,
  type AssertResolvedAction,
  type LinkWriter,
  type LinkWriteResult,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for record write tests')
const db = createDb(databaseUrl)
const organizations: string[] = []

const noLinks: LinkWriter = {
  apply: async (): Promise<LinkWriteResult> => { throw new Error('Link writer must not run for reference-free test input') },
  delete: async () => ({ changes: [], touchedRecordIds: [] }),
  restore: async () => ({ changes: [], touchedRecordIds: [] }),
}

async function allowResolved(_resolution: AssertResolvedAction): Promise<void> {}

async function setup() {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'test', onBehalfOf: null, requestId: crypto.randomUUID(),
  }, 'standard_crm'))
  const schema = await loadSchema(db, tenant)
  const ctx: ActorContext = {
    tenant: { organizationId: tenant.organizationId, teamId: tenant.teamId },
    app: 'test', actor: { type: 'system', id: 'test' },
    onBehalfOf: { uoaUserId: 'uoa_test', role: 'owner' }, provenance: null,
    actChain: [], requestId: crypto.randomUUID(), now: new Date(),
  }
  return { tenant, schema, ctx }
}

afterAll(async () => {
  await Promise.all(organizations.map((organizationId) => dropTenant(db, organizationId)))
  await db.$disconnect()
})

describe('record write engine', () => {
  it('writes a create marker then sorted sets with v1 and feed sequence', async () => {
    const { tenant, schema, ctx } = await setup()
    const result = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'person', data: { name: { full: 'Ada' }, emails: ['Ada <ADA@Example.COM>'] }, reason: 'import',
    }, noLinks))
    expect(result.created).toBe(true)
    expect(result.record.version).toBe(1)
    const changes = await db.recordChange.findMany({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, recordId: result.record.id },
      orderBy: { seq: 'asc' },
    })
    expect(changes.map((change) => `${change.kind}:${change.attributeSlug}`))
      .toEqual(['create:null', 'set:emails', 'set:name'])
    expect(changes.every((change) => change.resultingVersion === 1)).toBe(true)
    expect(changes.every((change) => change.reason === 'import')).toBe(true)
    expect(changes.map((change) => Number(change.seq))).toEqual([1, 2, 3])
  })

  it('updates with optimistic versioning and does not write normalized no-ops', async () => {
    const { tenant, schema, ctx } = await setup()
    const created = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'person', data: { name: { full: 'Ada' }, emails: ['ada@example.com'] },
    }, noLinks))
    const noOp = await db.$transaction((tx) => updateRecord(tx, ctx, schema, {
      recordId: created.record.id, data: { emails: ['ADA@EXAMPLE.COM'] }, expectedVersion: 1,
    }, noLinks))
    expect(noOp.changed).toBe(false)
    await expect(db.$transaction((tx) => updateRecord(tx, ctx, schema, {
      recordId: created.record.id, data: { name: { full: 'Grace' } }, expectedVersion: 9,
    }, noLinks))).rejects.toMatchObject({ code: ErrorCode.VERSION_CONFLICT })
    const updated = await db.$transaction((tx) => updateRecord(tx, ctx, schema, {
      recordId: created.record.id, data: { name: { full: 'Grace' } }, expectedVersion: 1,
    }, noLinks))
    expect(updated.record.version).toBe(2)
    expect(updated.changes.map((change) => change.attributeSlug)).toEqual(['name'])
    expect(await db.recordChange.count({ where: { organizationId: tenant.organizationId, teamId: tenant.teamId } })).toBe(4)
  })

  it('enforces unique keys and releases them on delete while restore detects conflict', async () => {
    const { tenant, schema, ctx } = await setup()
    const first = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'person', data: { name: { full: 'Ada' }, emails: ['ada@example.com'] },
    }, noLinks))
    await expect(db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'person', data: { name: { full: 'Other' }, emails: ['ada@example.com'] },
    }, noLinks))).rejects.toMatchObject({ code: ErrorCode.DUPLICATE_FOUND })
    const deleted = await db.$transaction((tx) => deleteRecord(tx, ctx, schema, first.record.id, 1, noLinks))
    const deletion = await db.recordChange.findFirst({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, recordId: first.record.id, kind: 'delete' },
      select: { snapshot: true },
    })
    expect(deletion?.snapshot).toMatchObject({
      data: { emails: ['ada@example.com'] },
      unique_keys: [{ normalizedValue: 'ada@example.com' }],
      match_keys: expect.any(Array),
    })
    const replacement = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'person', data: { name: { full: 'Other' }, emails: ['ada@example.com'] },
    }, noLinks))
    expect(replacement.created).toBe(true)
    await expect(db.$transaction((tx) => restoreRecord(tx, ctx, schema, first.record.id, deleted.record.version, noLinks)))
      .rejects.toMatchObject({
        code: ErrorCode.RESTORE_CONFLICT,
        details: { attribute: 'emails', held_by: replacement.record.id },
      })
  })

  it('assert updates the existing unique record', async () => {
    const { schema, ctx } = await setup()
    const created = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'person', data: { name: { full: 'Ada' }, emails: ['ada@example.com'] },
    }, noLinks))
    const asserted = await db.$transaction((tx) => assertRecord(tx, ctx, schema, {
      objectType: 'person', matchAttribute: 'emails', data: { name: { full: 'Ada Lovelace' }, emails: ['ada@example.com'] },
    }, noLinks, allowResolved))
    expect(asserted.created).toBe(false)
    expect(asserted.record.id).toBe(created.record.id)
    expect(asserted.record.version).toBe(2)
  })

  it('includes LinkWriter change intents and endpoint ids in the finalized feed', async () => {
    const { tenant, schema, ctx } = await setup()
    const company = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'company', data: { name: 'Analytical Engines' },
    }, noLinks))
    const links: LinkWriter = {
      apply: async (_tx, _ctx, _schema, recordId, linkOps) => ({
        changes: linkOps.map((operation) => ({
          recordId,
          kind: 'link' as const,
          attributeSlug: operation.attributeSlug,
          relationTypeId: operation.relationTypeId,
          linkId: null,
          groupId: null,
          oldValue: null,
          newValue: null,
          snapshot: null,
          resultingVersion: 1,
          reason: null,
        })),
        touchedRecordIds: [company.record.id],
      }),
      delete: async () => ({ changes: [], touchedRecordIds: [] }),
      restore: async () => ({ changes: [], touchedRecordIds: [] }),
    }
    const result = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'person',
      data: { name: { full: 'Ada' }, company: company.record.id },
    }, links))
    expect(result.changes.map((change) => change.kind)).toContain('link')
    expect(result.touchedRecordIds).toEqual([company.record.id, result.record.id].sort())
    expect(await db.recordChange.count({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, recordId: result.record.id },
    })).toBe(3)
  })

  it('passes the canonical delete snapshot to LinkWriter restore', async () => {
    const { schema, ctx } = await setup()
    let snapshot: unknown = null
    const links: LinkWriter = {
      apply: async (): Promise<LinkWriteResult> => { throw new Error('Unexpected link apply') },
      delete: async () => ({ changes: [], touchedRecordIds: [] }),
      restore: async (_tx, _ctx, _schema, _recordId, deleteSnapshot) => {
        snapshot = deleteSnapshot
        return { changes: [], touchedRecordIds: [] }
      },
    }
    const created = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'person', data: { name: { full: 'Ada' }, emails: ['ada@example.com'] },
    }, links))
    const deleted = await db.$transaction((tx) => deleteRecord(tx, ctx, schema, created.record.id, 1, links))
    const restored = await db.$transaction((tx) => restoreRecord(tx, ctx, schema, created.record.id, deleted.record.version, links))
    expect(restored.record.deletedAt).toBeNull()
    expect(snapshot).toMatchObject({ data: { emails: ['ada@example.com'] }, unique_keys: expect.any(Array) })
  })

  it('maps a normalized block-key restore collision to its attribute and holder', async () => {
    const { tenant, ctx } = await setup()
    const person = await db.objectType.findFirstOrThrow({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, slug: 'person' },
      select: { id: true },
    })
    await db.matchingRule.updateMany({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, objectTypeId: person.id, position: 0 },
      data: { attributeSlugs: ['phones'] },
    })
    await db.team.update({ where: { id: tenant.teamId }, data: { schemaVersion: { increment: 1 } } })
    const schema = await loadSchema(db, tenant)
    const first = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'person', data: { name: { full: 'Ada Lovelace' }, emails: ['ada-one@example.com'], phones: ['+44 20 7946 0958'] },
    }, noLinks))
    const deleted = await db.$transaction((tx) => deleteRecord(tx, ctx, schema, first.record.id, 1, noLinks))
    const holder = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'person', data: { name: { full: 'Ada Lovelace' }, emails: ['ada-two@example.com'], phones: ['+442079460958'] },
    }, noLinks))
    expect(await db.recordMatchKey.count({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, recordId: holder.record.id },
    })).toBe(1)
    const holderKey = await db.recordMatchKey.findFirstOrThrow({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, recordId: holder.record.id },
    })
    const firstKey = await db.recordMatchKey.findFirst({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, recordId: first.record.id },
    })
    expect(firstKey).toBeNull()
    expect(holderKey.normalizedHash).toBeDefined()
    await expect(db.$transaction((tx) => restoreRecord(tx, ctx, schema, first.record.id, deleted.record.version, noLinks)))
      .rejects.toMatchObject({ code: ErrorCode.RESTORE_CONFLICT, details: { attribute: 'phones', held_by: holder.record.id } })
  })

  it('serializes concurrent assert resolution to one create then one edit', async () => {
    const { tenant, schema, ctx } = await setup()
    const resolutions: AssertResolvedAction[] = []
    const input = {
      objectType: 'person', matchAttribute: 'emails', data: { name: { full: 'Ada' }, emails: ['ada@example.com'] },
    }
    const results = await Promise.all([
      db.$transaction((tx) => assertRecord(tx, { ...ctx, requestId: crypto.randomUUID() }, schema, input, noLinks, async (resolution) => {
        resolutions.push(resolution)
      })),
      db.$transaction((tx) => assertRecord(tx, { ...ctx, requestId: crypto.randomUUID() }, schema, input, noLinks, async (resolution) => {
        resolutions.push(resolution)
      })),
    ])
    expect(new Set(results.map((result) => result.record.id)).size).toBe(1)
    expect(await db.record.count({ where: { organizationId: tenant.organizationId, teamId: tenant.teamId } })).toBe(1)
    expect(resolutions.map((resolution) => resolution.action).sort()).toEqual(['create', 'edit'])
  })

  it('rolls back tentative assert create when resolved create authorization denies', async () => {
    const { tenant, schema, ctx } = await setup()
    let rowsAtDecision = -1
    await expect(db.$transaction((tx) => assertRecord(tx, ctx, schema, {
      objectType: 'person', matchAttribute: 'emails', data: { name: { full: 'Ada' }, emails: ['ada@example.com'] },
    }, noLinks, async () => {
      rowsAtDecision = await db.record.count({
        where: { organizationId: tenant.organizationId, teamId: tenant.teamId },
      })
      throw new ServiceError(ErrorCode.POLICY_DENIED, 'Create denied')
    }))).rejects.toMatchObject({ code: ErrorCode.POLICY_DENIED })
    expect(rowsAtDecision).toBe(0)
    expect(await db.record.count({ where: { organizationId: tenant.organizationId, teamId: tenant.teamId } })).toBe(0)
    expect(await db.recordChange.count({ where: { organizationId: tenant.organizationId, teamId: tenant.teamId } })).toBe(0)
  })
})
