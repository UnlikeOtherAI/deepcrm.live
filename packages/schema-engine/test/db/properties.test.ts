import { createDb, dropTenant, seedTenant, type TenantRef } from '@deepcrm/db'
import type { ActorContext } from '@deepcrm/schemas'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'

import {
  createProjectionLinkWriter,
  createRecord,
  applyTemplate,
  defineAttribute,
  defineObjectType,
  deleteRecord,
  executeMerge,
  executeUnmerge,
  loadSchema,
  projectLinksIntoData,
  restoreRecord,
  updateRecord,
  type LoadedSchema,
  type RecordWriteResult,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for property tests')
const db = createDb(databaseUrl)

type ExtraKind = 'text' | 'number' | 'boolean'
type ExtraAttribute = { slug: string; kind: ExtraKind }
type CreateOperation = { kind: 'create'; value: number; targets: number[] }
type UpdateOperation = {
  kind: 'update'; record: number; field: number; value: number; targets: number[]; unset: boolean; changeEmail: boolean
}
type DeleteOperation = { kind: 'delete'; record: number }
type RestoreOperation = { kind: 'restore'; record: number }
type Operation = CreateOperation | UpdateOperation | DeleteOperation | RestoreOperation
type Scenario = { schemaSeed: number; extraKinds: ExtraKind[]; operations: Operation[] }
type TrackedRecord = { id: string; version: number; data: Record<string, unknown> }

const targets = fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 6 })
const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({ kind: fc.constant('create'), value: fc.nat(), targets }),
  fc.record({
    kind: fc.constant('update'), record: fc.nat(), field: fc.nat(), value: fc.nat(), targets,
    unset: fc.boolean(), changeEmail: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('delete'), record: fc.nat() }),
  fc.record({ kind: fc.constant('restore'), record: fc.nat() }),
)
const scenarioArbitrary: fc.Arbitrary<Scenario> = fc.record({
  schemaSeed: fc.integer({ min: 0, max: 999_999 }),
  extraKinds: fc.array(fc.constantFrom<ExtraKind>('text', 'number', 'boolean'), { minLength: 1, maxLength: 4 }),
  operations: fc.array(operationArbitrary, { minLength: 20, maxLength: 60 }),
})

function actor(): { type: 'system'; id: string; onBehalfOf: null; requestId: string } {
  return { type: 'system', id: 'property-test', onBehalfOf: null, requestId: crypto.randomUUID() }
}

function context(tenant: TenantRef, step: number): ActorContext {
  return {
    tenant, app: 'property-test', actor: { type: 'system', id: 'property-test' },
    onBehalfOf: { uoaUserId: 'uoa_property_test', role: 'owner' }, provenance: null,
    actChain: [], requestId: crypto.randomUUID(), now: new Date(Date.now() + step),
  }
}

function scope(tenant: TenantRef): TenantRef {
  return { organizationId: tenant.organizationId, teamId: tenant.teamId }
}

function objectData(value: unknown): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected object data')
  return Object.fromEntries(Object.entries(value))
}

function field(value: unknown, slug: string): unknown {
  return Object.entries(objectData(value)).find(([key]) => key === slug)?.[1]
}

function choose<T>(values: T[], selector: number): T {
  const value = values[selector % values.length]
  if (value === undefined) throw new Error('Cannot choose from an empty collection')
  return value
}

function remove<T>(values: T[], selector: number): T {
  const index = selector % values.length
  const value = values[index]
  if (value === undefined) throw new Error('Cannot remove from an empty collection')
  values.splice(index, 1)
  return value
}

function referenceIds(selectors: number[], companyIds: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const selector of selectors) {
    const id = choose(companyIds, selector)
    if (!seen.has(id)) { seen.add(id); result.push(id) }
  }
  return result
}

function extraValue(attribute: ExtraAttribute, value: number): string | number | boolean {
  if (attribute.kind === 'text') return `value-${value}`
  if (attribute.kind === 'number') return value % 1_000_000
  return value % 2 === 0
}

function attributeConfig(kind: ExtraKind): Record<string, unknown> {
  if (kind === 'text') return { type: 'text', maxLength: 100 }
  if (kind === 'number') return { type: 'number', precision: 0, min: 0, max: 999_999 }
  return { type: 'boolean' }
}

async function defineRandomSchema(
  tenant: TenantRef, objectSlug: string, extras: ExtraAttribute[],
): Promise<LoadedSchema> {
  await db.$transaction(async (tx) => {
    await defineObjectType(tx, tenant, actor(), {
      slug: 'company', singularName: 'Company', pluralName: 'Companies', description: 'Property target',
    })
    await defineAttribute(tx, tenant, actor(), {
      objectType: 'company', slug: 'name', name: 'Name', description: 'Company name', type: 'text',
      config: { type: 'text', maxLength: 100 }, is_multi: false, is_required: true,
      is_unique: false, is_indexed: true, sensitivity: 'internal',
    })
    await defineObjectType(tx, tenant, actor(), {
      slug: objectSlug, singularName: 'Property record', pluralName: 'Property records', description: 'Generated schema',
    })
    await defineAttribute(tx, tenant, actor(), {
      objectType: objectSlug, slug: 'email', name: 'Email', description: 'Unique identity', type: 'email',
      config: { type: 'email' }, is_multi: false, is_required: true,
      is_unique: true, is_indexed: true, sensitivity: 'internal',
    })
    await defineAttribute(tx, tenant, actor(), {
      objectType: objectSlug, slug: 'companies', name: 'Companies', description: 'Ordered references',
      type: 'record_reference', config: { type: 'record_reference', objectTypes: ['company'] },
      is_multi: true, is_required: false, is_unique: false, is_indexed: true, sensitivity: 'internal',
    })
    for (const extra of extras) await defineAttribute(tx, tenant, actor(), {
      objectType: objectSlug, slug: extra.slug, name: extra.slug, description: 'Generated attribute',
      type: extra.kind, config: attributeConfig(extra.kind), is_multi: false, is_required: false,
      is_unique: false, is_indexed: false, sensitivity: 'internal',
    })
  })
  return loadSchema(db, tenant)
}

function remember(result: RecordWriteResult): TrackedRecord {
  return { id: result.record.id, version: result.record.version, data: objectData(result.record.data) }
}

async function applyOperations(
  tenant: TenantRef, schema: LoadedSchema, objectSlug: string, extras: ExtraAttribute[],
  companyIds: string[], operations: Operation[], committedSequences: number[],
): Promise<void> {
  const links = createProjectionLinkWriter()
  const live: TrackedRecord[] = []
  const deleted: TrackedRecord[] = []
  for (const [step, operation] of operations.entries()) {
    const ctx = context(tenant, step)
    if (operation.kind === 'create' || (live.length === 0 && deleted.length === 0)) {
      const input = operation.kind === 'create' ? operation : { kind: 'create', value: step, targets: [] }
      const data: Record<string, unknown> = {
        email: `p-${tenant.teamId}-${step}-${input.value}@example.test`,
        companies: referenceIds(input.targets, companyIds),
      }
      for (const extra of extras) data[extra.slug] = extraValue(extra, input.value + step)
      const result = await db.$transaction((tx) => createRecord(
        tx, ctx, schema, { objectType: objectSlug, data }, links,
      ))
      live.push(remember(result)); committedSequences.push(...result.sequences)
      continue
    }
    if (operation.kind === 'restore' || live.length === 0) {
      if (deleted.length === 0) {
        const data: Record<string, unknown> = {
          email: `fallback-${tenant.teamId}-${step}@example.test`, companies: [],
        }
        for (const extra of extras) data[extra.slug] = extraValue(extra, step)
        const result = await db.$transaction((tx) => createRecord(
          tx, ctx, schema, { objectType: objectSlug, data }, links,
        ))
        live.push(remember(result)); committedSequences.push(...result.sequences)
        continue
      }
      const record = remove(deleted, operation.record)
      const result = await db.$transaction((tx) => restoreRecord(tx, ctx, schema, record.id, record.version, links))
      live.push(remember(result)); committedSequences.push(...result.sequences)
      continue
    }
    if (operation.kind === 'delete') {
      const record = remove(live, operation.record)
      const result = await db.$transaction((tx) => deleteRecord(tx, ctx, schema, record.id, record.version, links))
      deleted.push(remember(result)); committedSequences.push(...result.sequences)
      continue
    }
    const record = choose(live, operation.record)
    const extra = choose(extras, operation.field)
    const patch: Record<string, unknown> = {
      companies: referenceIds(operation.targets, companyIds),
      [extra.slug]: operation.unset && Object.hasOwn(record.data, extra.slug)
        ? null : extraValue(extra, operation.value + step),
    }
    if (operation.changeEmail) patch['email'] = `u-${tenant.teamId}-${step}-${operation.value}@example.test`
    const result = await db.$transaction((tx) => updateRecord(tx, ctx, schema, {
      recordId: record.id, expectedVersion: record.version, data: patch,
    }, links))
    Object.assign(record, remember(result)); committedSequences.push(...result.sequences)
  }
}

async function assertDataReplay(tenant: TenantRef): Promise<void> {
  const records = await db.record.findMany({ where: scope(tenant), select: { id: true, data: true } })
  const changes = await db.recordChange.findMany({
    where: scope(tenant), orderBy: { seq: 'asc' }, select: { recordId: true, kind: true, attributeSlug: true, newValue: true },
  })
  const replay = new Map<string, Record<string, unknown>>()
  for (const record of records) replay.set(record.id, {})
  for (const change of changes) {
    if (change.recordId === null || change.attributeSlug === null) continue
    const data = replay.get(change.recordId)
    if (data === undefined) throw new Error('Change references an unknown record')
    if (change.kind === 'set') data[change.attributeSlug] = change.newValue
    if (change.kind === 'unset') delete data[change.attributeSlug]
  }
  for (const record of records) expect(record.data).toEqual(replay.get(record.id))
}

async function assertReferences(
  tenant: TenantRef, schema: LoadedSchema, objectSlug: string, objectTypeId: string,
): Promise<void> {
  const relation = schema.resolveBackingRelation(objectSlug, 'companies')
  if (relation === undefined) throw new Error('Missing generated backing relation')
  const records = await db.record.findMany({
    where: { ...scope(tenant), objectTypeId }, select: { id: true, data: true },
  })
  const active = await db.recordLink.findMany({
    where: { ...scope(tenant), relationTypeId: relation.id, activeUntil: null },
    select: { fromRecordId: true, relationTypeId: true, toRecordId: true, position: true },
    orderBy: [{ fromRecordId: 'asc' }, { position: 'asc' }],
  })
  for (const record of records) {
    expect(Object.hasOwn(objectData(record.data), 'companies')).toBe(false)
    const rows = active.filter((link) => link.fromRecordId === record.id)
    const expected = rows.length === 0 ? {} : { companies: rows.map((link) => link.toRecordId) }
    expect(projectLinksIntoData(schema, objectSlug, rows)).toEqual(expected)
    expect(rows.map((link) => link.position)).toEqual(rows.map((_, index) => index))
    expect(new Set(rows.map((link) => link.position)).size).toBe(rows.length)
  }
}

async function assertUniqueKeys(tenant: TenantRef, objectTypeId: string, emailAttributeId: string): Promise<void> {
  const live = await db.record.findMany({
    where: { ...scope(tenant), objectTypeId, deletedAt: null }, select: { id: true, data: true }, orderBy: { id: 'asc' },
  })
  const expected = live.map((record) => {
    const email = field(record.data, 'email')
    if (typeof email !== 'string') throw new Error('Live generated record is missing its email')
    return { recordId: record.id, normalizedValue: email.toLocaleLowerCase() }
  }).sort((left, right) => left.recordId.localeCompare(right.recordId))
  const actual = await db.recordUniqueKey.findMany({
    where: { ...scope(tenant), attributeId: emailAttributeId }, select: { recordId: true, normalizedValue: true },
    orderBy: { recordId: 'asc' },
  })
  expect(actual).toEqual(expected)
}

async function assertFeedAndVersions(tenant: TenantRef, committedSequences: number[]): Promise<void> {
  const changes = await db.recordChange.findMany({
    where: scope(tenant), orderBy: { seq: 'asc' },
    select: { recordId: true, kind: true, requestId: true, resultingVersion: true, seq: true },
  })
  const sequences = changes.map((change) => Number(change.seq))
  expect(sequences).toEqual(committedSequences)
  for (let index = 1; index < sequences.length; index += 1) {
    expect(sequences[index]).toBeGreaterThan(sequences[index - 1] ?? 0)
  }
  expect(changes.every((change) => change.recordId !== null && change.resultingVersion > 0)).toBe(true)
  const records = await db.record.findMany({
    where: scope(tenant), select: { id: true, objectTypeId: true, deletedAt: true, version: true },
  })
  for (const record of records) {
    const last = changes.filter((change) => change.recordId === record.id).at(-1)
    expect(
      last?.resultingVersion,
      JSON.stringify({
        record,
        changes: changes.filter((change) => change.recordId === record.id).map((change) => ({
          ...change, seq: Number(change.seq),
        })),
      }),
    ).toBe(record.version)
    const createMarker = changes.find((change) => change.recordId === record.id && change.kind === 'create')
    expect(createMarker).toBeDefined()
    const createRows = changes.filter((change) => (
      change.recordId === record.id && change.requestId === createMarker?.requestId
    ))
    expect(createRows.every((change) => change.resultingVersion === 1)).toBe(true)
  }
}

async function runScenario(scenario: Scenario): Promise<void> {
  const tenant = await seedTenant(db)
  try {
    const objectSlug = `generated_${scenario.schemaSeed}`
    const extras = scenario.extraKinds.map((kind, index) => ({ slug: `field_${index}`, kind }))
    const schema = await defineRandomSchema(tenant, objectSlug, extras)
    const links = createProjectionLinkWriter()
    const committedSequences: number[] = []
    const companyIds: string[] = []
    for (let index = 0; index < 4; index += 1) {
      const result = await db.$transaction((tx) => createRecord(tx, context(tenant, -10 + index), schema, {
        objectType: 'company', data: { name: `Company ${index}` },
      }, links))
      companyIds.push(result.record.id); committedSequences.push(...result.sequences)
    }
    await applyOperations(tenant, schema, objectSlug, extras, companyIds, scenario.operations, committedSequences)
    const objectType = schema.objectTypesBySlug.get(objectSlug)
    const email = objectType?.attributes.find((attribute) => attribute.slug === 'email')
    if (objectType === undefined || email === undefined) throw new Error('Generated schema did not load')
    await assertDataReplay(tenant)
    await assertReferences(tenant, schema, objectSlug, objectType.id)
    await assertUniqueKeys(tenant, objectType.id, email.id)
    await assertFeedAndVersions(tenant, committedSequences)
  } finally {
    await dropTenant(db, tenant.organizationId)
  }
}

afterAll(async () => db.$disconnect())

describe('schema engine database properties', () => {
  it('satisfies merge/unmerge invariant (d)', async () => {
    await fc.assert(fc.asyncProperty(
      fc.tuple(fc.uuid(), fc.uuid()).filter(([left, right]) => left !== right),
      async ([left, right]) => {
        const tenant = await seedTenant(db)
        try {
          const ctx = context(tenant, 0)
          await db.$transaction((tx) => applyTemplate(tx, tenant, actor(), 'standard_crm'))
          const schema = await loadSchema(db, tenant)
          const links = createProjectionLinkWriter()
          const company = (await db.$transaction((tx) => createRecord(tx, ctx, schema, {
            objectType: 'company', data: { name: `Company ${left}` },
          }, links))).record
          const survivor = (await db.$transaction((tx) => createRecord(tx, ctx, schema, {
            objectType: 'person',
            data: { name: { full: `Survivor ${left}` }, emails: [`${left}@property.test`], company: company.id },
          }, links))).record
          const loser = (await db.$transaction((tx) => createRecord(tx, ctx, schema, {
            objectType: 'person',
            data: { name: { full: `Loser ${right}` }, emails: [`${right}@property.test`], company: company.id },
          }, links))).record
          await db.$transaction((tx) => createRecord(tx, ctx, schema, {
            objectType: 'deal', data: { name: `Deal ${right}`, contacts: [loser.id] },
          }, links))
          const ids = [survivor.id, loser.id]
          const beforeRecords = await db.record.findMany({
            where: { ...scope(tenant), id: { in: ids } },
            select: { id: true, data: true }, orderBy: { id: 'asc' },
          })
          const beforeLinks = await db.recordLink.findMany({
            where: {
              ...scope(tenant), activeUntil: null,
              OR: [{ fromRecordId: { in: ids } }, { toRecordId: { in: ids } }],
            },
            select: {
              id: true, relationTypeId: true, fromRecordId: true, toRecordId: true, position: true,
            },
            orderBy: { id: 'asc' },
          })
          const beforeMatch = await db.recordMatchLookupKey.findMany({
            where: { ...scope(tenant), recordId: { in: ids } },
            select: { matchingRuleId: true, normalizedHash: true, recordId: true },
            orderBy: [{ recordId: 'asc' }, { matchingRuleId: 'asc' }, { normalizedHash: 'asc' }],
          })
          expect(beforeMatch.length).toBeGreaterThan(0)
          const merged = await db.$transaction((tx) => executeMerge(tx, ctx, schema, {
            survivorId: survivor.id, mergedIds: [loser.id], reason: 'property merge',
          }))
          const result = await db.$transaction((tx) => executeUnmerge(
            tx, context(tenant, 1), schema,
            { mergeChangeId: merged.mergeChangeId, reason: 'property unmerge' },
          ))
          expect(result.conflicts).toEqual([])
          expect(await db.record.findMany({
            where: { ...scope(tenant), id: { in: ids } },
            select: { id: true, data: true }, orderBy: { id: 'asc' },
          })).toEqual(beforeRecords)
          expect(await db.recordLink.findMany({
            where: {
              ...scope(tenant), activeUntil: null,
              OR: [{ fromRecordId: { in: ids } }, { toRecordId: { in: ids } }],
            },
            select: {
              id: true, relationTypeId: true, fromRecordId: true, toRecordId: true, position: true,
            },
            orderBy: { id: 'asc' },
          })).toEqual(beforeLinks)
          expect(await db.recordMatchLookupKey.findMany({
            where: { ...scope(tenant), recordId: { in: ids } },
            select: { matchingRuleId: true, normalizedHash: true, recordId: true },
            orderBy: [{ recordId: 'asc' }, { matchingRuleId: 'asc' }, { normalizedHash: 'asc' }],
          })).toEqual(beforeMatch)
        } finally {
          await dropTenant(db, tenant.organizationId)
        }
      },
    ), { numRuns: 5 })
  }, 120_000)

  it('does not advance an empty replacement and records a projection reorder', async () => {
    await runScenario({
      schemaSeed: 1,
      extraKinds: ['boolean'],
      operations: [
        { kind: 'delete', record: 0 },
        {
          kind: 'update', record: 0, field: 0, value: 1, targets: [], unset: false, changeEmail: false,
        },
      ],
    })
    await runScenario({
      schemaSeed: 2,
      extraKinds: ['boolean'],
      operations: [
        { kind: 'create', value: 0, targets: [0, 1] },
        {
          kind: 'update', record: 0, field: 0, value: 1, targets: [1, 0], unset: false, changeEmail: false,
        },
      ],
    })
  })

  it('preserves record, link, unique-key, feed, version, and position invariants', async () => {
    await fc.assert(fc.asyncProperty(scenarioArbitrary, runScenario), { numRuns: 25 })
  }, 360_000)
})
