import { createDb, dropTenant, seedTenant, tenantWhere } from '@deepcrm/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { computeDisplayName } from '../src/records/display-name.js'
import { loadSchema, type LoadedObjectType, type LoadedSchema } from '../src/schema/load.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for record display/load tests')

const db = createDb(databaseUrl)
let organizationId = ''
let teamId = ''
let schema: LoadedSchema

function objectType(slug: string): LoadedObjectType {
  const result = schema.objectTypesBySlug.get(slug)
  if (result === undefined) throw new Error(`fixture object type ${slug} was not loaded`)
  return result
}

beforeAll(async () => {
  const seeded = await seedTenant(db)
  organizationId = seeded.organizationId
  teamId = seeded.teamId
  const tenant = { organizationId, teamId }

  await db.$transaction(async (tx) => {
    const person = await tx.objectType.create({
      data: {
        ...tenantWhere(tenant),
        slug: 'person',
        singularName: 'Person',
        pluralName: 'People',
        description: 'A person',
        kind: 'custom',
        createdByType: 'system',
        createdById: 'records_display_test',
      },
    })
    const personName = await tx.attribute.create({
      data: {
        ...tenantWhere(tenant),
        objectTypeId: person.id,
        slug: 'name',
        name: 'Name',
        description: 'Structured display name',
        type: 'personal_name',
        config: {},
        isSystem: true,
        position: 0,
      },
    })
    const archived = await tx.attribute.create({
      data: {
        ...tenantWhere(tenant),
        objectTypeId: person.id,
        slug: 'former_title',
        name: 'Former title',
        description: 'Archived fixture attribute',
        type: 'text',
        config: {},
        archivedAt: new Date(),
        position: 1,
      },
    })
    await tx.objectType.update({
      where: { id: person.id },
      data: { primaryAttributeId: personName.id },
    })

    const company = await tx.objectType.create({
      data: {
        ...tenantWhere(tenant),
        slug: 'company',
        singularName: 'Company',
        pluralName: 'Companies',
        description: 'A company',
        kind: 'custom',
        createdByType: 'system',
        createdById: 'records_display_test',
      },
    })
    const companyName = await tx.attribute.create({
      data: {
        ...tenantWhere(tenant),
        objectTypeId: company.id,
        slug: 'name',
        name: 'Name',
        description: 'Text display name',
        type: 'text',
        config: {},
        position: 0,
      },
    })
    await tx.objectType.update({
      where: { id: company.id },
      data: { primaryAttributeId: companyName.id },
    })

    const document = await tx.objectType.create({
      data: {
        ...tenantWhere(tenant),
        slug: 'document',
        singularName: 'Document',
        pluralName: 'Documents',
        description: 'A document',
        kind: 'custom',
        createdByType: 'system',
        createdById: 'records_display_test',
      },
    })
    const payload = await tx.attribute.create({
      data: {
        ...tenantWhere(tenant),
        objectTypeId: document.id,
        slug: 'payload',
        name: 'Payload',
        description: 'Non-display JSON',
        type: 'json',
        config: {},
        position: 0,
      },
    })
    await tx.objectType.update({
      where: { id: document.id },
      data: { primaryAttributeId: payload.id },
    })

    expect(archived.archivedAt).not.toBeNull()
  })

  schema = await loadSchema(db, { organizationId, teamId })
})

afterAll(async () => {
  if (organizationId !== '') await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('T12 loaded schema and display names', () => {
  it('keeps archived slugs distinguishable without exposing archived attributes as active', () => {
    const person = objectType('person')
    const active = schema.attributesByObjectTypeId.get(person.id)
    const archived = schema.archivedAttributeSlugsByObjectTypeId.get(person.id)

    expect(person.attributes.map((attribute) => attribute.slug)).toEqual(['name'])
    expect(active?.has('name')).toBe(true)
    expect(active?.has('former_title')).toBe(false)
    expect([...schema.attributesById.values()].some((attribute) => attribute.slug === 'former_title'))
      .toBe(false)
    expect(archived?.has('former_title')).toBe(true)
    expect(archived?.has('never_defined')).toBe(false)
    expect(archived === undefined ? 'missing' : 'add' in archived).toBe(false)
  })

  it('uses active structured and text primary attributes regardless of isSystem', () => {
    expect(computeDisplayName(schema, objectType('person'), {
      name: { first: 'Ada', last: 'Lovelace', full: 'Ada Lovelace' },
    })).toBe('Ada Lovelace')
    expect(computeDisplayName(schema, objectType('company'), {
      name: '  ACME   Labs ',
    })).toBe('acme labs')
  })

  it('returns an empty display name for missing, null, or non-textual values', () => {
    const person = objectType('person')
    expect(computeDisplayName(schema, person, {})).toBe('')
    expect(computeDisplayName(schema, person, { name: null })).toBe('')
    expect(computeDisplayName(schema, objectType('document'), { payload: { title: 'Internal' } }))
      .toBe('')
  })
})
