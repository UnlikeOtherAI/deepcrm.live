import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { afterAll, describe, expect, it } from 'vitest'

import {
  defineAttribute,
  defineObjectType,
  loadSchema,
  loadSchemaForMatchingBootstrap,
  setMatchingRules,
} from '../../src/index.js'
import {
  loadSchemaFromSource,
  type SchemaLoadSource,
} from '../../src/schema/load.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for schema loader tests')

const db = createDb(databaseUrl)
const organizationIds: string[] = []
const actor: Parameters<typeof defineObjectType>[2] = {
  type: 'system',
  id: 'schema_loader_test',
  onBehalfOf: null,
  requestId: 'schema_loader_test',
}
type Tenant = { organizationId: string; teamId: string }

async function tenant(): Promise<Tenant> {
  const created = await seedTenant(db)
  organizationIds.push(created.organizationId)
  return created
}

function stableEmptySource(teamId: string): SchemaLoadSource {
  return {
    readVersion: async () => ({ id: teamId, schemaVersion: 0 }),
    readMetadata: async () => ({
      objectTypes: [], relationTypes: [], lists: [], views: [], matchingRules: [],
    }),
  }
}

afterAll(async () => {
  for (const organizationId of organizationIds) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('schema loader', () => {
  it('retries a version mismatch without caching it and bounds repeated mismatches', async () => {
    const versions = [1, 2, 2, 2, 2, 1, 1]
    let metadataReads = 0
    const source: SchemaLoadSource = {
      readVersion: async () => {
        const schemaVersion = versions.shift()
        if (schemaVersion === undefined) throw new Error('unexpected version read')
        return { id: 'retry-team', schemaVersion }
      },
      readMetadata: async () => {
        metadataReads += 1
        return { objectTypes: [], relationTypes: [], lists: [], views: [], matchingRules: [] }
      },
    }
    const target = { organizationId: 'retry-org', teamId: 'retry-team' }

    expect((await loadSchemaFromSource(source, target)).schemaVersion).toBe(2)
    expect(metadataReads).toBe(2)
    expect((await loadSchemaFromSource(source, target)).schemaVersion).toBe(2)
    expect(metadataReads).toBe(2)
    expect((await loadSchemaFromSource(source, target)).schemaVersion).toBe(1)
    expect(metadataReads).toBe(3)

    let mismatchVersion = 0
    const changing: SchemaLoadSource = {
      readVersion: async () => ({ id: 'changing-team', schemaVersion: mismatchVersion++ }),
      readMetadata: async () => ({
        objectTypes: [], relationTypes: [], lists: [], views: [], matchingRules: [],
      }),
    }
    await expect(loadSchemaFromSource(changing, {
      organizationId: 'changing-org',
      teamId: 'changing-team',
    })).rejects.toMatchObject({
      code: 'SCHEMA_CONFLICT',
      details: { detail: 'schema_version_changed_during_load' },
    })
    expect(mismatchVersion).toBe(6)
  })

  it('returns a typed tenant error', async () => {
    const missing: SchemaLoadSource = {
      readVersion: async () => null,
      readMetadata: async () => ({
        objectTypes: [], relationTypes: [], lists: [], views: [], matchingRules: [],
      }),
    }
    await expect(loadSchemaFromSource(missing, {
      organizationId: 'missing-org',
      teamId: 'missing-team',
    })).rejects.toMatchObject({ code: 'TENANT_MISMATCH' })
  })

  it('returns immutable rows, complete maps, matching groups, and a backing-relation resolver', async () => {
    const target = await tenant()
    await db.$transaction(async (tx) => {
      await defineObjectType(tx, target, actor, {
        slug: 'company',
        singularName: 'Company',
        pluralName: 'Companies',
        description: 'A company',
      })
      await defineObjectType(tx, target, actor, {
        slug: 'person',
        singularName: 'Person',
        pluralName: 'People',
        description: 'A person',
      })
      await defineAttribute(tx, target, actor, {
        objectType: 'person',
        slug: 'name',
        name: 'Name',
        description: 'Display name',
        type: 'text',
        config: { type: 'text', maxLength: 120 },
        is_multi: false,
        is_required: true,
        is_unique: false,
        is_indexed: true,
        sensitivity: 'internal',
      })
      await defineAttribute(tx, target, actor, {
        objectType: 'person',
        slug: 'company',
        name: 'Company',
        description: 'Employer',
        type: 'record_reference',
        config: { type: 'record_reference', objectTypes: ['company'] },
        is_multi: false,
        is_required: false,
        is_unique: false,
        is_indexed: true,
        sensitivity: 'internal',
      })
      await setMatchingRules(tx, target, actor, 'person', {
        rules: [{ attributes: ['name'], method: 'exact', action: 'warn' }],
      })
      const person = await tx.objectType.findFirstOrThrow({
        where: { organizationId: target.organizationId, teamId: target.teamId, slug: 'person' },
      })
      const list = await tx.list.create({
        data: {
          organizationId: target.organizationId,
          teamId: target.teamId,
          slug: 'prospects',
          name: 'Prospects',
          objectTypeId: person.id,
          createdByType: 'system',
          createdById: actor.id,
        },
      })
      await tx.attribute.create({
        data: {
          organizationId: target.organizationId,
          teamId: target.teamId,
          listId: list.id,
          slug: 'priority',
          name: 'Priority',
          description: 'Prospect priority',
          type: 'select',
          config: {
            type: 'select',
            options: [
              { id: 'high', label: 'High' },
              { id: 'low', label: 'Low' },
            ],
          },
        },
      })
      await tx.view.create({
        data: {
          organizationId: target.organizationId,
          teamId: target.teamId,
          objectTypeId: person.id,
          slug: 'all_people',
          name: 'All people',
          createdByType: 'system',
          createdById: actor.id,
        },
      })
    })

    const schema = await loadSchema(db, target)
    const person = schema.objectTypesBySlug.get('person')
    const companyAttribute = person === undefined
      ? undefined
      : schema.attributesByObjectTypeId.get(person.id)?.get('company')
    const backingRelation = schema.resolveBackingRelation('person', 'company')

    expect(Object.isFrozen(schema)).toBe(true)
    expect(Object.isFrozen(schema.objectTypes)).toBe(true)
    expect(Object.isFrozen(person)).toBe(true)
    expect(Object.isFrozen(companyAttribute?.config)).toBe(true)
    expect('set' in schema.objectTypesBySlug).toBe(false)
    expect(person).toBe(schema.objectTypesById.get(person?.id ?? 'missing'))
    expect(companyAttribute).toBe(schema.attributesById.get(companyAttribute?.id ?? 'missing'))
    expect(schema.relationTypesBySlug.get('person_company')).toBe(backingRelation)
    expect(schema.relationTypesById.get(backingRelation?.id ?? 'missing')).toBe(backingRelation)
    expect(schema.backingRelationsByAttributeId.get(companyAttribute?.id ?? 'missing'))
      .toBe(backingRelation)
    expect(schema.matchingRulesByObjectTypeId.get(person?.id ?? 'missing')).toHaveLength(1)
    const list = schema.listsBySlug.get('prospects')
    expect(list).toBe(schema.listsById.get(list?.id ?? 'missing'))
    expect(schema.attributesByListId.get(list?.id ?? 'missing')?.get('priority')?.type).toBe('select')
    const view = schema.viewsBySlug.get('all_people')
    expect(view).toBe(schema.viewsById.get(view?.id ?? 'missing'))
    expect(view?.objectTypeId).toBe(person?.id)
    expect(Object.isFrozen(list)).toBe(true)
    expect(Object.isFrozen(list?.attributes)).toBe(true)
    expect(Object.isFrozen(view)).toBe(true)
    expect(schema.resolveBackingRelation('person', 'name')).toBeUndefined()
    expect(schema.resolveBackingRelation('missing', 'company')).toBeUndefined()
    if (person === undefined) throw new Error('person object type must load')
    expect(Reflect.set(person, 'slug', 'changed')).toBe(false)
    expect(schema.objectTypesBySlug.get('person')?.slug).toBe('person')
  })

  it('invalidates by version and evicts the older version for the same team', async () => {
    const target = await tenant()
    expect((await loadSchema(db, target)).objectTypes).toHaveLength(0)
    await db.$transaction((tx) => defineObjectType(tx, target, actor, {
      slug: 'company',
      singularName: 'Company',
      pluralName: 'Companies',
      description: 'A company',
    }))
    const current = await loadSchema(db, target)
    expect(current.schemaVersion).toBe(1)
    expect(current.objectTypesBySlug.has('company')).toBe(true)

    await db.team.updateMany({
      where: { id: target.teamId, organizationId: target.organizationId },
      data: { schemaVersion: 0 },
    })
    const reloaded = await loadSchema(db, target)
    expect(reloaded.schemaVersion).toBe(0)
    expect(reloaded.objectTypesBySlug.has('company')).toBe(true)
  })

  it('fails closed for unready matching keys except in the trusted bootstrap loader', async () => {
    const target = await tenant()
    await db.$transaction(async (tx) => {
      await defineObjectType(tx, target, actor, {
        slug: 'person',
        singularName: 'Person',
        pluralName: 'People',
        description: 'A person',
      })
      await defineAttribute(tx, target, actor, {
        objectType: 'person',
        slug: 'email',
        name: 'Email',
        description: 'Email address',
        type: 'email',
        config: { type: 'email' },
        is_multi: false,
        is_required: false,
        is_unique: true,
        is_indexed: true,
        sensitivity: 'internal',
      })
      await setMatchingRules(tx, target, actor, 'person', {
        rules: [{ attributes: ['email'], method: 'normalized', action: 'block' }],
      })
    })
    const generation = await db.matchingRuleGeneration.findFirstOrThrow({
      where: { organizationId: target.organizationId, teamId: target.teamId, state: 'active' },
      select: { id: true },
    })
    await db.matchingRuleGeneration.update({
      where: { id: generation.id },
      data: { keysReadyAt: null },
    })

    await expect(loadSchema(db, target)).rejects.toMatchObject({
      code: 'SCHEMA_CONFLICT',
      details: { detail: 'matching_keys_not_ready' },
    })
    const trusted = await loadSchemaForMatchingBootstrap(db, target, generation.id)
    expect(trusted.matchingRules).toHaveLength(1)
    await expect(loadSchemaForMatchingBootstrap(db, target, '00000000-0000-0000-0000-000000000000'))
      .rejects.toMatchObject({
        code: 'SCHEMA_CONFLICT',
        details: { detail: 'matching_bootstrap_generation_not_active' },
      })
  })

  it('evicts the least-recently-used entry when the 64-entry cache is full', async () => {
    const target = await tenant()
    expect((await loadSchema(db, target)).objectTypes).toHaveLength(0)
    await db.objectType.create({
      data: {
        organizationId: target.organizationId,
        teamId: target.teamId,
        slug: 'after_cache',
        singularName: 'After cache',
        pluralName: 'After cache',
        description: 'Created without a version bump for eviction proof',
        kind: 'custom',
        createdByType: 'system',
        createdById: 'schema_loader_test',
      },
    })
    expect((await loadSchema(db, target)).objectTypes).toHaveLength(0)

    for (let index = 0; index < 64; index += 1) {
      const teamId = `eviction-team-${index}`
      await loadSchemaFromSource(stableEmptySource(teamId), {
        organizationId: `eviction-org-${index}`,
        teamId,
      })
    }
    expect((await loadSchema(db, target)).objectTypes.map((objectType) => objectType.slug))
      .toEqual(['after_cache'])
  })
})
