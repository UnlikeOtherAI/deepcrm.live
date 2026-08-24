import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { ErrorCode } from '@deepcrm/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  applyTemplate,
  loadSchema,
  matchingTupleHash,
  matchingTuples,
  validateMatchingRule,
  type LoadedSchema,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for matching key tests')
const db = createDb(databaseUrl)
let organizationId = ''
let schema: LoadedSchema

beforeAll(async () => {
  const tenant = await seedTenant(db)
  organizationId = tenant.organizationId
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'matching_keys_test', onBehalfOf: null, requestId: crypto.randomUUID(),
  }, 'standard_crm'))
  schema = await loadSchema(db, tenant)
})

afterAll(async () => {
  if (organizationId !== '') await dropTenant(db, organizationId)
  await db.$disconnect()
})

function personFixture() {
  const person = schema.objectTypesBySlug.get('person')
  if (person === undefined) throw new Error('Person schema is missing')
  const emailRule = schema.matchingRulesByObjectTypeId.get(person.id)?.find((rule) => (
    rule.attributeSlugs.length === 1 && rule.attributeSlugs[0] === 'emails'
  ))
  if (emailRule === undefined) throw new Error('Email matching rule is missing')
  return { person, emailRule }
}

describe('matching key canonicalization', () => {
  it('distinguishes exact from normalized values and ignores missing values', () => {
    const { person, emailRule } = personFixture()
    const exactRule = { ...emailRule, method: 'exact' as const }
    expect(matchingTuples(schema, person, emailRule, { emails: ['ADA@Example.COM'] }))
      .toEqual([['ada@example.com']])
    expect(matchingTuples(schema, person, exactRule, { emails: ['ADA@Example.COM'] }))
      .toEqual([['ADA@Example.COM']])
    expect(matchingTuples(schema, person, emailRule, {})).toEqual([])
    expect(matchingTuples(schema, person, emailRule, { emails: null })).toEqual([])
    expect(matchingTuples(schema, person, emailRule, { emails: [] })).toEqual([])
  })

  it('hashes canonical tuples without delimiter ambiguity', () => {
    expect(matchingTupleHash(['a|b', 'c'])).not.toBe(matchingTupleHash(['a', 'b|c']))
    expect(matchingTupleHash([{ b: 2, a: 1 }])).toBe(matchingTupleHash([{ a: 1, b: 2 }]))
  })

  it('allows exactly 256 Cartesian tuples and rejects the next one', () => {
    const { person, emailRule } = personFixture()
    const compound = {
      ...emailRule,
      method: 'exact' as const,
      action: 'warn' as const,
      attributeSlugs: ['emails', 'phones'],
    }
    const values = (size: number, prefix: string) => (
      Array.from({ length: size }, (_, index) => `${prefix}-${index}`)
    )
    expect(matchingTuples(schema, person, compound, {
      emails: values(16, 'email'), phones: values(16, 'phone'),
    })).toHaveLength(256)
    expect(() => matchingTuples(schema, person, compound, {
      emails: values(17, 'email'), phones: values(16, 'phone'),
    })).toThrow(expect.objectContaining({ code: ErrorCode.LIMIT_EXCEEDED, details: { limit: 256 } }))
  })

  it('rejects block rules for non-unique-capable references and invalid fuzzy definitions', () => {
    const { person } = personFixture()
    const attributes = schema.attributesByObjectTypeId.get(person.id)
    const company = attributes?.get('company')
    const name = attributes?.get('name')
    if (company === undefined || name === undefined) throw new Error('Matching attributes are missing')
    expect(() => validateMatchingRule(person, [company], {
      attributes: ['company'], method: 'exact', action: 'block',
    })).toThrow(expect.objectContaining({ details: { detail: 'blocking_matching_rule_requires_unique_capability' } }))
    expect(() => validateMatchingRule(person, [name], {
      attributes: ['name'], method: 'fuzzy', threshold: 0.49, action: 'warn',
    })).toThrow(expect.objectContaining({ details: { detail: 'invalid_fuzzy_matching_rule' } }))
  })
})
