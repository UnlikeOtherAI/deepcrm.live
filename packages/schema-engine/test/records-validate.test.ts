import type { Attribute, ObjectType, RelationType } from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'
import { describe, expect, it } from 'vitest'

import { loadSchemaFromSource, type LoadedSchema } from '../src/schema/load.js'
import { canonicalJsonValue } from '../src/records/json.js'
import { validateRecordData } from '../src/records/validate.js'
import standardCrmJson from '../src/templates/standard_crm.json' with { type: 'json' }
import { TemplateSchema } from '../src/templates/types.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const teamId = '00000000-0000-4000-8000-000000000002'
const personId = '00000000-0000-4000-8000-000000000003'
const companyId = '00000000-0000-4000-8000-000000000004'
const personCompanyId = '00000000-0000-4000-8000-000000000005'
const dealContactsId = '00000000-0000-4000-8000-000000000006'
const firstTarget = '00000000-0000-4000-8000-000000000007'
const secondTarget = '00000000-0000-4000-8000-000000000008'
const now = new Date('2026-01-01T00:00:00.000Z')
const standardCrm = TemplateSchema.parse(standardCrmJson)

function standardPersonTemplate() {
  const value = standardCrm.object_types.find((item) => item.slug === 'person')
  if (value === undefined) throw new Error('standard CRM person template is required')
  return value
}

const standardPerson = standardPersonTemplate()

function attribute(input: Pick<Attribute, 'id' | 'objectTypeId' | 'slug' | 'type'> & Partial<Attribute>): Attribute {
  return {
    id: input.id,
    organizationId,
    teamId,
    objectTypeId: input.objectTypeId,
    listId: null,
    slug: input.slug,
    name: input.slug,
    description: '',
    type: input.type,
    config: input.config ?? {},
    isMulti: input.isMulti ?? false,
    isRequired: input.isRequired ?? false,
    isUnique: false,
    isSystem: input.isSystem ?? false,
    isIndexed: false,
    sensitivity: 'internal',
    defaultValue: input.defaultValue ?? null,
    position: 0,
    archivedAt: input.archivedAt ?? null,
    createdAt: now,
    updatedAt: now,
  }
}

function templateAttribute(id: string, slug: string, input: Partial<Attribute> = {}): Attribute {
  const spec = standardPerson.attributes.find((item) => item.slug === slug)
  if (spec === undefined) throw new Error(`standard CRM attribute ${slug} is required`)
  const config = spec.config === undefined
    ? {}
    : canonicalJsonValue(Object.fromEntries(
      Object.entries(spec.config).filter(([key]) => key !== 'type'),
    ))
  return attribute({
    id,
    objectTypeId: personId,
    slug,
    type: spec.type,
    config,
    isMulti: spec.is_multi,
    isRequired: spec.is_required,
    isUnique: spec.is_unique,
    isIndexed: spec.is_indexed,
    isSystem: spec.is_system ?? false,
    sensitivity: spec.sensitivity,
    ...input,
  })
}

function object(input: Pick<ObjectType, 'id' | 'slug'>, attributes: Attribute[]): ObjectType & { attributes: Attribute[] } {
  return {
    id: input.id,
    organizationId,
    teamId,
    slug: input.slug,
    singularName: input.slug,
    pluralName: `${input.slug}s`,
    description: '',
    icon: null,
    kind: 'standard',
    templateSlug: 'standard_crm',
    primaryAttributeId: null,
    archivedAt: null,
    createdByType: 'system',
    createdById: 'template',
    createdAt: now,
    updatedAt: now,
    attributes,
  }
}

function relation(input: Pick<RelationType, 'id' | 'slug' | 'fromObjectTypeId' | 'toObjectTypeId' | 'cardinality' | 'projectionAttributeSlug'>): RelationType {
  return {
    id: input.id,
    organizationId,
    teamId,
    slug: input.slug,
    fromObjectTypeId: input.fromObjectTypeId,
    toObjectTypeId: input.toObjectTypeId,
    forwardName: input.slug,
    inverseName: input.slug,
    description: '',
    cardinality: input.cardinality,
    onDelete: 'unlink',
    edgeAttributes: [],
    projectionAttributeSlug: input.projectionAttributeSlug,
    isSystem: false,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

type SchemaOptions = {
  requiredReferences?: boolean
  companyCardinality?: RelationType['cardinality']
  schemaVersion?: number
}

async function schema(options: SchemaOptions = {}): Promise<LoadedSchema> {
  const person = object({ id: personId, slug: 'person' }, [
    templateAttribute('00000000-0000-4000-8000-000000000011', 'name'),
    templateAttribute('00000000-0000-4000-8000-000000000012', 'emails'),
    templateAttribute('00000000-0000-4000-8000-000000000013', 'title'),
    templateAttribute('00000000-0000-4000-8000-000000000014', 'company', {
      isRequired: options.requiredReferences ?? false,
    }),
    attribute({
      id: '00000000-0000-4000-8000-000000000015', objectTypeId: personId, slug: 'contacts',
      type: 'record_reference', config: { objectTypes: ['company'] }, isMulti: true,
      isRequired: options.requiredReferences ?? false,
    }),
    attribute({ id: '00000000-0000-4000-8000-000000000016', objectTypeId: personId, slug: 'last_activity_at', type: 'timestamp_system', config: { source: 'last_activity_at' } }),
    attribute({ id: '00000000-0000-4000-8000-000000000017', objectTypeId: personId, slug: 'notes', type: 'rich_text', isMulti: true }),
    attribute({ id: '00000000-0000-4000-8000-000000000018', objectTypeId: personId, slug: 'source', type: 'text', defaultValue: 'website' }),
    attribute({ id: '00000000-0000-4000-8000-000000000019', objectTypeId: personId, slug: 'default_email', type: 'email', defaultValue: 'Ada <ADA@Example.COM>' }),
    attribute({ id: '00000000-0000-4000-8000-000000000020', objectTypeId: personId, slug: 'amounts', type: 'currency', config: {}, isMulti: true }),
    attribute({ id: '00000000-0000-4000-8000-000000000023', objectTypeId: personId, slug: 'former_title', type: 'text', archivedAt: now }),
  ])
  const company = object({ id: companyId, slug: 'company' }, [])
  return loadSchemaFromSource({
    readVersion: async () => ({ id: teamId, schemaVersion: options.schemaVersion ?? 1 }),
    readMetadata: async () => ({
      objectTypes: [person, company],
      relationTypes: [
        relation({
          id: personCompanyId,
          slug: 'person_company',
          fromObjectTypeId: personId,
          toObjectTypeId: companyId,
          cardinality: options.companyCardinality ?? 'many_to_one',
          projectionAttributeSlug: 'company',
        }),
        relation({ id: dealContactsId, slug: 'person_contacts', fromObjectTypeId: personId, toObjectTypeId: companyId, cardinality: 'many_to_many', projectionAttributeSlug: 'contacts' }),
      ],
      matchingRules: [],
    }),
  }, { organizationId, teamId })
}

function failure(action: () => void): ServiceError {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError)
    return error instanceof ServiceError ? error : new ServiceError(ErrorCode.INTERNAL, 'Unexpected error')
  }
  throw new Error('Expected a ServiceError')
}

describe('record validation', () => {
  it('uses the parsed standard CRM contract and transforms defaults only on create', async () => {
    expect(standardCrm.slug).toBe('standard_crm')
    expect(standardPerson.attributes.some((item) => item.slug === 'emails')).toBe(true)
    const loaded = await schema()
    const person = loaded.objectTypesBySlug.get('person')
    if (person === undefined) throw new Error('person fixture missing')
    const result = validateRecordData(loaded, person, { title: 'Founder', emails: ['old@example.com'] }, {
      emails: ['Ada <ADA@Example.COM>', 'ada@example.com', 'bob@example.com'],
      title: null,
    }, 'update')
    expect(result.data).toEqual({ emails: ['ada@example.com', 'bob@example.com'] })
    expect(result.linkOps).toEqual([])
    expect(failure(() => validateRecordData(loaded, person, {}, { name: null }, 'create')).details).toEqual({
      issues: [{ path: '/name', message: 'Invalid attribute value' }],
    })
    expect(validateRecordData(loaded, person, { emails: ['a@example.com'] }, { emails: [] }, 'update').data)
      .toEqual({ emails: [] })
    expect(validateRecordData(loaded, person, {}, { name: { full: 'Ada Lovelace' } }, 'create').data)
      .toEqual({ default_email: 'ada@example.com', name: { full: 'Ada Lovelace' }, source: 'website' })
    expect(validateRecordData(loaded, person, { name: { full: 'Ada' } }, {}, 'update').data)
      .toEqual({ name: { full: 'Ada' } })
  })

  it('extracts reference intents deterministically without storing reference data', async () => {
    const loaded = await schema()
    const person = loaded.objectTypesBySlug.get('person')
    if (person === undefined) throw new Error('person fixture missing')
    const forward = validateRecordData(loaded, person, { title: 'Founder' }, {
      company: firstTarget,
      contacts: [firstTarget, firstTarget.toUpperCase(), secondTarget],
    }, 'update')
    const reversed = validateRecordData(loaded, person, { title: 'Founder' }, {
      contacts: [firstTarget, firstTarget.toUpperCase(), secondTarget],
      company: firstTarget,
    }, 'update')
    expect(forward.data).toEqual({ title: 'Founder' })
    expect(forward).toEqual(reversed)
    expect(forward.linkOps).toEqual([
      { kind: 'record_reference', attributeSlug: 'company', relationTypeId: personCompanyId, cardinality: 'many_to_one', targetIds: [firstTarget] },
      { kind: 'record_reference', attributeSlug: 'contacts', relationTypeId: dealContactsId, cardinality: 'many_to_many', targetIds: [firstTarget, secondTarget] },
    ])
    expect(validateRecordData(loaded, person, {}, { contacts: [] }, 'update').linkOps[0]?.targetIds).toEqual([])
    expect(failure(() => validateRecordData(loaded, person, {}, { company: [] }, 'update')).code)
      .toBe(ErrorCode.VALIDATION_FAILED)
  })

  it('enforces required reference creation and clear semantics', async () => {
    const loaded = await schema({ requiredReferences: true, schemaVersion: 2 })
    const person = loaded.objectTypesBySlug.get('person')
    if (person === undefined) throw new Error('person fixture missing')
    expect(failure(() => validateRecordData(loaded, person, {}, {
      name: { full: 'Ada' },
    }, 'create')).details).toEqual({
      issues: [
        { path: '/company', message: 'Invalid attribute value' },
        { path: '/contacts', message: 'Invalid attribute value' },
      ],
    })
    expect(failure(() => validateRecordData(loaded, person, {}, { company: null }, 'update')).details)
      .toEqual({ issues: [{ path: '/company', message: 'Invalid attribute value' }] })
    expect(failure(() => validateRecordData(loaded, person, {}, { contacts: [] }, 'update')).details)
      .toEqual({ issues: [{ path: '/contacts', message: 'Invalid attribute value' }] })
    expect(validateRecordData(loaded, person, {}, {
      name: { full: 'Ada' }, company: firstTarget, contacts: [secondTarget],
    }, 'create').linkOps).toHaveLength(2)
  })

  it('reports archived, read-only, and unknown patch attributes exactly', async () => {
    const loaded = await schema()
    const person = loaded.objectTypesBySlug.get('person')
    if (person === undefined) throw new Error('person fixture missing')
    expect(failure(() => validateRecordData(loaded, person, {}, {
      former_title: 'Founder',
    }, 'update'))).toMatchObject({
      code: ErrorCode.ATTRIBUTE_ARCHIVED,
      details: { attribute: 'former_title' },
    })
    for (const slug of ['id', 'last_activity_at']) {
      expect(failure(() => validateRecordData(loaded, person, {}, {
        [slug]: '2026-01-01T00:00:00Z',
      }, 'update'))).toMatchObject({
        code: ErrorCode.ATTRIBUTE_READ_ONLY,
        details: { attribute: slug },
      })
    }
    expect(failure(() => validateRecordData(loaded, person, {}, { unknown: 'x' }, 'update')))
      .toMatchObject({ code: ErrorCode.UNKNOWN_ATTRIBUTE, details: { attribute: 'unknown' } })
    expect(validateRecordData(loaded, person, {}, { name: { full: 'System field' } }, 'create').data)
      .toMatchObject({ name: { full: 'System field' } })
  })

  it('rejects unsafe or impossible current data with sorted RFC 6901 issues', async () => {
    const loaded = await schema()
    const person = loaded.objectTypesBySlug.get('person')
    if (person === undefined) throw new Error('person fixture missing')
    expect(failure(() => validateRecordData(loaded, person, {
      zeta: 'x', 'a/b~c': 'x',
    }, {}, 'update')).details).toEqual({
      issues: [
        { path: '/a~1b~0c', message: 'Invalid attribute value' },
        { path: '/zeta', message: 'Invalid attribute value' },
      ],
    })
    expect(failure(() => validateRecordData(loaded, person, {
      company: firstTarget, id: firstTarget, unknown: 'x',
    }, {}, 'update')).details).toEqual({
      issues: [
        { path: '/company', message: 'Invalid attribute value' },
        { path: '/id', message: 'Invalid attribute value' },
        { path: '/unknown', message: 'Invalid attribute value' },
      ],
    })
    for (const currentData of [{ title: undefined }, { title: Number.NaN }]) {
      expect(failure(() => validateRecordData(loaded, person, currentData, {}, 'update')).details)
        .toEqual({ issues: [{ path: '', message: 'Invalid record data' }] })
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(failure(() => validateRecordData(loaded, person, cyclic, {}, 'update')).details)
      .toEqual({ issues: [{ path: '', message: 'Invalid record data' }] })
    expect(validateRecordData(loaded, person, { former_title: 'Legacy' }, {}, 'update').data)
      .toEqual({ former_title: 'Legacy' })
  })

  it('does not mutate inputs and catches malformed patch values as issues', async () => {
    const loaded = await schema()
    const person = loaded.objectTypesBySlug.get('person')
    if (person === undefined) throw new Error('person fixture missing')
    const currentData = { title: 'Founder', emails: ['old@example.com'] }
    const patch = { emails: ['Ada <ADA@Example.COM>'], title: 'CTO' }
    const currentBefore = structuredClone(currentData)
    const patchBefore = structuredClone(patch)
    validateRecordData(loaded, person, currentData, patch, 'update')
    expect(currentData).toEqual(currentBefore)
    expect(patch).toEqual(patchBefore)
    expect(failure(() => validateRecordData(loaded, person, {}, { title: Number.NaN }, 'update')).details)
      .toEqual({ issues: [{ path: '/title', message: 'Invalid attribute value' }] })
  })

  it('uses canonical fallback de-duplication and enforces the exact UTF-8 byte boundary', async () => {
    const loaded = await schema()
    const person = loaded.objectTypesBySlug.get('person')
    if (person === undefined) throw new Error('person fixture missing')
    expect(validateRecordData(loaded, person, {}, {
      amounts: [
        { currency: 'USD', amount: '1.0' },
        { amount: '1.00', currency: 'USD' },
      ],
      notes: ['**same**', '**same**', 'same'],
    }, 'update').data).toEqual({
      amounts: [{ amount: '1', currency: 'USD' }],
      notes: ['**same**', 'same'],
    })

    const first = 'a'.repeat(90_000)
    const second = 'b'.repeat(90_000)
    const exactRemainder = 'c'.repeat(82_124)
    expect(validateRecordData(loaded, person, {}, {
      notes: [first, second, exactRemainder],
    }, 'update').issues).toEqual([])
    expect(failure(() => validateRecordData(loaded, person, {}, {
      notes: [first, second, `${exactRemainder}x`],
    }, 'update'))).toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
      details: { issues: [{ path: '', message: 'Record data exceeds the maximum size' }] },
    })
  })

  it('fails closed when the backing relation cardinality is inconsistent', async () => {
    const loaded = await schema({ companyCardinality: 'one_to_many', schemaVersion: 3 })
    const person = loaded.objectTypesBySlug.get('person')
    if (person === undefined) throw new Error('person fixture missing')
    expect(failure(() => validateRecordData(loaded, person, {}, {
      company: firstTarget,
    }, 'update'))).toMatchObject({
      code: ErrorCode.SCHEMA_CONFLICT,
      details: { detail: 'invalid_backing_relation' },
    })
  })
})
