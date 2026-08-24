import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { ErrorCode } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'
import {
  archiveObjectType,
  defineAttribute,
  defineObjectType,
  defineRelationType,
  loadSchema,
  setMatchingRules,
  updateObjectType,
  updateRelationType,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for schema tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const actor = () => ({ type: 'system' as const, id: 'test', onBehalfOf: null, requestId: crypto.randomUUID() })

async function tenant() {
  const value = await seedTenant(db)
  organizations.push(value.organizationId)
  return value
}

function objectInput(slug: string) {
  return { slug, singularName: `${slug} singular`, pluralName: `${slug} plural`, description: 'test object' }
}

function attributeInput(
  objectType: string,
  slug: string,
  type: 'text' | 'record_reference' | 'status' | 'json' = 'text',
) {
  return {
    objectType,
    slug,
    name: slug,
    description: 'test attribute',
    type,
    config: type === 'text' ? { type: 'text', maxLength: 100 } : { type },
    is_multi: false,
    is_required: false,
    is_unique: false,
    is_indexed: false,
    sensitivity: 'internal' as const,
  }
}

afterAll(async () => {
  await Promise.all(organizations.map((id) => dropTenant(db, id)))
  await db.$disconnect()
})

describe('schema metadata', () => {
  it('isolates same slugs between tenants', async () => {
    const left = await tenant(); const right = await tenant()
    await db.$transaction((tx) => defineObjectType(tx, left, actor(), { slug: 'company', singularName: 'Company', pluralName: 'Companies', description: 'x' }))
    const leftSchema = await loadSchema(db, left); const rightSchema = await loadSchema(db, right)
    expect(leftSchema.objectTypesBySlug.has('company')).toBe(true)
    expect(rightSchema.objectTypesBySlug.has('company')).toBe(false)
  })

  it('keeps an identically named object and attribute isolated across a tenant pair', async () => {
    const left = await tenant(); const right = await tenant()
    await db.$transaction(async (tx) => {
      await defineObjectType(tx, left, actor(), objectInput('company'))
      await defineObjectType(tx, right, actor(), objectInput('company'))
      await defineAttribute(tx, left, actor(), attributeInput('company', 'name'))
      await defineAttribute(tx, right, actor(), attributeInput('company', 'name'))
    })
    const [leftAttribute, rightAttribute] = await Promise.all([
      db.attribute.findFirstOrThrow({ where: { organizationId: left.organizationId, teamId: left.teamId, slug: 'name' } }),
      db.attribute.findFirstOrThrow({ where: { organizationId: right.organizationId, teamId: right.teamId, slug: 'name' } }),
    ])
    expect(leftAttribute.id).not.toBe(rightAttribute.id)
    expect(leftAttribute.teamId).toBe(left.teamId)
    expect(rightAttribute.teamId).toBe(right.teamId)
  })

  it('maps duplicate metadata slugs to typed schema conflicts', async () => {
    const value = await tenant()
    await db.$transaction((tx) => defineObjectType(tx, value, actor(), objectInput('company')))
    await expect(db.$transaction((tx) => defineObjectType(tx, value, actor(), objectInput('company'))))
      .rejects.toMatchObject({ code: ErrorCode.SCHEMA_CONFLICT })
  })

  it('maps duplicate attributes and relations to typed schema conflicts', async () => {
    const value = await tenant()
    await db.$transaction(async (tx) => {
      await defineObjectType(tx, value, actor(), objectInput('company'))
      await defineAttribute(tx, value, actor(), attributeInput('company', 'name'))
      await defineRelationType(tx, value, actor(), {
        slug: 'company_related',
        fromObjectType: 'company',
        toObjectType: null,
        forwardName: 'related',
        inverseName: 'related',
        cardinality: 'many_to_many',
      })
    })
    await expect(db.$transaction((tx) => defineAttribute(
      tx,
      value,
      actor(),
      attributeInput('company', 'name'),
    ))).rejects.toMatchObject({ code: ErrorCode.SCHEMA_CONFLICT })
    await expect(db.$transaction((tx) => defineRelationType(tx, value, actor(), {
      slug: 'company_related',
      fromObjectType: 'company',
      toObjectType: null,
      forwardName: 'related',
      inverseName: 'related',
      cardinality: 'many_to_many',
    }))).rejects.toMatchObject({ code: ErrorCode.SCHEMA_CONFLICT })
  })

  it('increments schema version once and writes its audit after a successful mutation', async () => {
    const value = await tenant()
    const before = await db.team.findFirstOrThrow({ where: { id: value.teamId, organizationId: value.organizationId } })
    const beforeAuditCount = await db.auditLog.count({ where: { organizationId: value.organizationId, teamId: value.teamId } })
    await db.$transaction((tx) => defineObjectType(tx, value, actor(), objectInput('company')))
    const after = await db.team.findFirstOrThrow({ where: { id: value.teamId, organizationId: value.organizationId } })
    const audits = await db.auditLog.findMany({
      where: { organizationId: value.organizationId, teamId: value.teamId },
      orderBy: { createdAt: 'desc' },
      take: 1,
    })
    expect(after.schemaVersion).toBe(before.schemaVersion + 1)
    expect(await db.auditLog.count({ where: { organizationId: value.organizationId, teamId: value.teamId } }))
      .toBe(beforeAuditCount + 1)
    expect(audits[0]).toMatchObject({ action: 'define', resourceType: 'object_type', outcome: 'success' })
  })

  it('rolls back metadata, version, and audit when backing-relation validation fails', async () => {
    const value = await tenant()
    await db.$transaction((tx) => defineObjectType(tx, value, actor(), objectInput('person')))
    const before = await db.team.findFirstOrThrow({ where: { id: value.teamId, organizationId: value.organizationId } })
    const beforeAuditCount = await db.auditLog.count({ where: { organizationId: value.organizationId, teamId: value.teamId } })
    await expect(db.$transaction((tx) => defineAttribute(tx, value, actor(), {
      ...attributeInput('person', 'company', 'record_reference'),
      config: { type: 'record_reference', objectTypes: ['missing'] },
    }))).rejects.toBeDefined()
    expect(await db.attribute.count({ where: { organizationId: value.organizationId, teamId: value.teamId } })).toBe(0)
    expect((await db.team.findFirstOrThrow({ where: { id: value.teamId, organizationId: value.organizationId } })).schemaVersion)
      .toBe(before.schemaVersion)
    expect(await db.auditLog.count({ where: { organizationId: value.organizationId, teamId: value.teamId } }))
      .toBe(beforeAuditCount)
  })

  it('invalidates a cached schema after archive while retaining the archived row', async () => {
    const value = await tenant()
    await db.$transaction((tx) => defineObjectType(tx, value, actor(), objectInput('company')))
    expect((await loadSchema(db, value)).objectTypesBySlug.has('company')).toBe(true)
    await db.$transaction((tx) => archiveObjectType(tx, value, actor(), 'company'))
    const archived = await db.objectType.findFirstOrThrow({ where: { organizationId: value.organizationId, teamId: value.teamId, slug: 'company' } })
    expect(archived.archivedAt).not.toBeNull()
    expect((await loadSchema(db, value)).objectTypesBySlug.has('company')).toBe(false)
  })

  it('claims a supplied compatible relation for a record reference', async () => {
    const value = await tenant()
    await db.$transaction(async (tx) => {
      await defineObjectType(tx, value, actor(), { slug: 'person', singularName: 'Person', pluralName: 'People', description: 'x' })
      await defineObjectType(tx, value, actor(), { slug: 'company', singularName: 'Company', pluralName: 'Companies', description: 'x' })
      await defineRelationType(tx, value, actor(), { slug: 'person_company', fromObjectType: 'person', toObjectType: 'company', forwardName: 'works at', inverseName: 'employs', cardinality: 'many_to_one' })
      await defineAttribute(tx, value, actor(), { objectType: 'person', slug: 'company', name: 'Company', description: 'x', type: 'record_reference', config: { type: 'record_reference', objectTypes: ['company'], relationTypeSlug: 'person_company' }, is_multi: false, is_required: false, is_unique: false, is_indexed: false, sensitivity: 'internal' })
    })
    const relation = await db.relationType.findFirstOrThrow({ where: { organizationId: value.organizationId, teamId: value.teamId, slug: 'person_company' } })
    expect(relation.projectionAttributeSlug).toBe('company')
  })

  it('creates open-target multi-reference relations and rejects incompatible supplied ownership', async () => {
    const value = await tenant()
    await db.$transaction(async (tx) => {
      await defineObjectType(tx, value, actor(), objectInput('deal'))
      await defineObjectType(tx, value, actor(), objectInput('person'))
      await defineObjectType(tx, value, actor(), objectInput('company'))
      await defineAttribute(tx, value, actor(), {
        ...attributeInput('deal', 'parties', 'record_reference'),
        config: { type: 'record_reference', objectTypes: ['person', 'company'] },
        is_multi: true,
        is_indexed: true,
      })
    })
    const relation = await db.relationType.findFirstOrThrow({ where: { organizationId: value.organizationId, teamId: value.teamId, slug: 'deal_parties' } })
    expect(relation).toMatchObject({ cardinality: 'many_to_many', toObjectTypeId: null, projectionAttributeSlug: 'parties' })
    await expect(db.$transaction((tx) => defineAttribute(tx, value, actor(), {
      ...attributeInput('deal', 'other_party', 'record_reference'),
      config: { type: 'record_reference', objectTypes: ['person', 'company'], relationTypeSlug: 'deal_parties' },
      is_multi: true,
    }))).rejects.toBeDefined()
  })

  it('enforces capability flags, primary safety, and typed edge attributes', async () => {
    const value = await tenant()
    await db.$transaction(async (tx) => {
      await defineObjectType(tx, value, actor(), objectInput('company'))
      await defineAttribute(tx, value, actor(), attributeInput('company', 'name'))
      await updateObjectType(tx, value, actor(), 'company', { primaryAttribute: 'name' })
    })
    const objectType = await db.objectType.findFirstOrThrow({ where: { organizationId: value.organizationId, teamId: value.teamId, slug: 'company' } })
    expect(objectType.primaryAttributeId).not.toBeNull()
    await expect(db.$transaction((tx) => defineAttribute(tx, value, actor(), {
      ...attributeInput('company', 'state', 'status'),
      config: { type: 'status', options: [{ id: 'open', label: 'Open', category: 'open', position: 0 }, { id: 'done', label: 'Done', category: 'won', position: 1 }] },
      is_multi: true,
    }))).rejects.toBeDefined()
    await expect(db.$transaction((tx) => defineRelationType(tx, value, actor(), {
      slug: 'company_related', fromObjectType: 'company', toObjectType: null, forwardName: 'related', inverseName: 'related', cardinality: 'many_to_many',
      edgeAttributes: [{
        slug: 'state', name: 'State', description: 'invalid multi status edge', type: 'status',
        config: { type: 'status', options: [{ id: 'open', label: 'Open', category: 'open', position: 0 }, { id: 'done', label: 'Done', category: 'won', position: 1 }] },
        is_multi: true, is_required: false, is_unique: false, is_indexed: false, sensitivity: 'internal',
      }],
    }))).rejects.toBeDefined()
  })

  it('validates relation edge updates with the same capability contract', async () => {
    const value = await tenant()
    await db.$transaction(async (tx) => {
      await defineObjectType(tx, value, actor(), objectInput('company'))
      await defineRelationType(tx, value, actor(), {
        slug: 'company_related',
        fromObjectType: 'company',
        toObjectType: null,
        forwardName: 'related',
        inverseName: 'related',
        cardinality: 'many_to_many',
      })
    })
    await expect(db.$transaction((tx) => updateRelationType(tx, value, actor(), 'company_related', {
      edgeAttributes: [{
        ...attributeInput('company', 'state', 'status'),
        config: {
          type: 'status',
          options: [
            { id: 'open', label: 'Open', category: 'open', position: 0 },
            { id: 'won', label: 'Won', category: 'won', position: 1 },
          ],
        },
        is_multi: true,
      }],
    }))).rejects.toMatchObject({ code: ErrorCode.SCHEMA_CONFLICT })
    const relation = await db.relationType.findFirstOrThrow({
      where: { organizationId: value.organizationId, teamId: value.teamId, slug: 'company_related' },
    })
    expect(relation.edgeAttributes).toEqual([])
  })

  it('keeps backing-relation ownership internal and structural shape immutable', async () => {
    const value = await tenant()
    const externalProjection = {
      slug: 'external_claim',
      fromObjectType: null,
      toObjectType: null,
      forwardName: 'external',
      inverseName: 'external',
      cardinality: 'many_to_many' as const,
      projectionAttributeSlug: 'not_allowed',
    }
    await expect(db.$transaction((tx) => defineRelationType(
      tx,
      value,
      actor(),
      externalProjection,
    ))).rejects.toMatchObject({ code: ErrorCode.SCHEMA_CONFLICT })
    await db.$transaction(async (tx) => {
      await defineObjectType(tx, value, actor(), objectInput('person'))
      await defineObjectType(tx, value, actor(), objectInput('company'))
      await defineAttribute(tx, value, actor(), {
        ...attributeInput('person', 'company', 'record_reference'),
        config: { type: 'record_reference', objectTypes: ['company'] },
      })
    })
    await expect(db.$transaction((tx) => updateRelationType(
      tx,
      value,
      actor(),
      'person_company',
      { cardinality: 'many_to_many' },
    ))).rejects.toMatchObject({ code: ErrorCode.SCHEMA_CONFLICT })
  })

  it('replaces matching rules atomically after validation', async () => {
    const value = await tenant()
    await db.$transaction(async (tx) => {
      await defineObjectType(tx, value, actor(), objectInput('company'))
      await defineAttribute(tx, value, actor(), attributeInput('company', 'name'))
      await defineAttribute(tx, value, actor(), attributeInput('company', 'payload', 'json'))
      await setMatchingRules(tx, value, actor(), 'company', [{ attributes: ['name'], method: 'exact', action: 'warn' }])
    })
    await expect(db.$transaction((tx) => setMatchingRules(tx, value, actor(), 'company', [
      { attributes: ['missing'], method: 'exact', action: 'warn' },
    ]))).rejects.toBeDefined()
    const rules = await db.matchingRule.findMany({ where: { organizationId: value.organizationId, teamId: value.teamId } })
    expect(rules).toHaveLength(1)
    expect(rules[0]?.attributeSlugs).toEqual(['name'])
    await expect(db.$transaction((tx) => setMatchingRules(tx, value, actor(), 'company', [
      { attributes: ['payload'], method: 'normalized', action: 'block' },
    ]))).rejects.toBeDefined()
  })
})
