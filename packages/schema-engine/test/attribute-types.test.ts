import { describe, expect, it } from 'vitest'

import { attributeTypes, getAttributeType } from '../src/attribute-types/index.js'

const expectedTypes = [
  'text', 'rich_text', 'number', 'currency', 'percent', 'boolean', 'date', 'datetime', 'select',
  'status', 'rating', 'email', 'phone', 'url', 'domain', 'registry_id', 'location', 'personal_name',
  'actor_reference', 'record_reference', 'timestamp_system', 'json',
] as const

const capabilityMatrix: Record<(typeof expectedTypes)[number], readonly [boolean, boolean, boolean]> = {
  text: [true, true, true],
  rich_text: [true, false, false],
  number: [true, true, true],
  currency: [true, false, false],
  percent: [true, false, true],
  boolean: [true, true, true],
  date: [true, true, true],
  datetime: [true, true, true],
  select: [true, true, true],
  status: [false, false, true],
  rating: [true, false, true],
  email: [true, true, true],
  phone: [true, true, true],
  url: [true, true, true],
  domain: [true, true, true],
  registry_id: [true, true, true],
  location: [true, false, false],
  personal_name: [true, true, false],
  actor_reference: [true, true, false],
  record_reference: [true, false, true],
  timestamp_system: [false, false, false],
  json: [true, false, false],
}

describe('attribute type registry', () => {
  it('contains exactly every supported attribute type', () => {
    expect(Object.keys(attributeTypes).sort()).toEqual([...expectedTypes].sort())
    for (const type of expectedTypes) expect(getAttributeType(type)).toBe(attributeTypes[type])
  })

  it('implements the full capability matrix', () => {
    for (const type of expectedTypes) {
      const definition = attributeTypes[type]
      expect([definition.supportsMulti, definition.supportsUnique, definition.supportsIndexed])
        .toEqual(capabilityMatrix[type])
    }
  })

  it('normalizes text, rich text, email, phone, URLs, domains, and registry identifiers', () => {
    expect(attributeTypes.text.normalize('  Ada\tLOVELACE  ', {})).toBe('ada lovelace')
    expect(attributeTypes.rich_text.toSearchText('## Hello, [world](https://example.com)', {})).toBe('Hello, world')
    expect(attributeTypes.email.valueSchema({}).parse('Ada <ADA@Example.COM>')).toBe('ada@example.com')
    expect(attributeTypes.phone.valueSchema({}).parse('+44 20 7183 8750')).toBe('+442071838750')
    expect(attributeTypes.phone.valueSchema({}).safeParse('020 7183 8750').success).toBe(false)
    expect(attributeTypes.url.valueSchema({}).parse('HTTPS://EXAMPLE.COM:443/?utm=source'))
      .toBe('https://example.com?utm=source')
    expect(attributeTypes.url.valueSchema({}).parse('https://example.com/path/')).toBe('https://example.com/path/')
    expect(attributeTypes.domain.valueSchema({}).parse('WWW.Example.CO.UK')).toBe('example.co.uk')
    expect(attributeTypes.domain.valueSchema({}).parse('https://sub.Example.COM/a?b=c')).toBe('example.com')
    expect(attributeTypes.domain.valueSchema({}).safeParse('ftp://example.com').success).toBe(false)
    expect(attributeTypes.registry_id.valueSchema({}).parse('00 ab-12. 3')).toBe('AB123')
  })

  it('uses canonical reject-not-round decimals and fixed ISO currency values', () => {
    expect(attributeTypes.number.valueSchema({ precision: 2 }).parse(12.3)).toBe('12.3')
    expect(attributeTypes.number.valueSchema({ precision: 2 }).safeParse(12.345).success).toBe(false)
    expect(attributeTypes.number.configSchema.safeParse({ min: 2, max: 1 }).success).toBe(false)
    expect(attributeTypes.currency.valueSchema({ fixedCurrency: 'GBP' }).parse({ amount: '12.3400', currency: 'GBP' }))
      .toEqual({ amount: '12.34', currency: 'GBP' })
    expect(attributeTypes.currency.valueSchema({}).safeParse({ amount: '1e3', currency: 'USD' }).success).toBe(false)
    expect(attributeTypes.currency.valueSchema({ fixedCurrency: 'GBP' }).safeParse({ amount: '1', currency: 'USD' }).success)
      .toBe(false)
    expect(attributeTypes.percent.valueSchema({}).safeParse(101).success).toBe(false)
    expect(attributeTypes.rating.valueSchema({ max: 3 }).safeParse(4).success).toBe(false)
  })

  it('accepts only real dates and canonical RFC3339 offset datetimes', () => {
    expect(attributeTypes.date.valueSchema({}).parse('2024-02-29')).toBe('2024-02-29')
    expect(attributeTypes.date.valueSchema({}).safeParse('2023-02-29').success).toBe(false)
    expect(attributeTypes.datetime.valueSchema({}).parse('2024-01-01T01:02:03+01:00'))
      .toBe('2024-01-01T00:02:03.000Z')
    expect(attributeTypes.datetime.valueSchema({}).safeParse('2024-01-01T01:02:03').success).toBe(false)
  })

  it('checks select and status option identity and order', () => {
    expect(attributeTypes.select.configSchema.safeParse({
      options: [{ id: 'new', label: 'New' }, { id: 'new', label: 'Again' }],
    }).success).toBe(false)
    expect(attributeTypes.select.valueSchema({ options: [{ id: 'new', label: 'New' }] }).parse('new')).toBe('new')
    expect(attributeTypes.select.valueSchema({ options: [{ id: 'new', label: 'New' }] }).safeParse('old').success).toBe(false)
    expect(attributeTypes.status.configSchema.safeParse({ options: [
      { id: 'new', label: 'New', category: 'open', position: 0 },
      { id: 'won', label: 'Won', category: 'won', position: 2 },
    ] }).success).toBe(false)
    expect(attributeTypes.status.configSchema.safeParse({ options: [
      { id: 'new', label: 'New', category: 'open', position: 0 },
      { id: 'won', label: 'Won', category: 'won', position: 1 },
    ] }).success).toBe(true)
  })

  it('validates each remaining structured type', () => {
    expect(attributeTypes.boolean.normalize(true, {})).toBe('true')
    expect(attributeTypes.location.valueSchema({}).parse({ country: 'gb', lat: 51.5, lng: -0.12 }))
      .toEqual({ country: 'GB', lat: 51.5, lng: -0.12 })
    expect(attributeTypes.personal_name.valueSchema({}).parse({ first: 'Ada', last: 'Lovelace' }))
      .toEqual({ first: 'Ada', last: 'Lovelace', full: 'Ada Lovelace' })
    expect(attributeTypes.personal_name.normalize({ full: ' Ada  Lovelace ' }, {})).toBe('ada lovelace')
    expect(attributeTypes.actor_reference.valueSchema({ allow: ['human'] }).parse({ type: 'human', id: 'uoa_1' }))
      .toEqual({ type: 'human', id: 'uoa_1' })
    expect(attributeTypes.actor_reference.valueSchema({ allow: ['human'] }).safeParse({ type: 'agent', id: 'a_1' }).success)
      .toBe(false)
    expect(attributeTypes.record_reference.valueSchema({ objectTypes: ['company'] })
      .parse('D1C7E8A4-5D0A-4BB3-9F5E-8641F770E509')).toBe('d1c7e8a4-5d0a-4bb3-9f5e-8641f770e509')
    expect(attributeTypes.timestamp_system.configSchema.safeParse({ source: 'created_at' }).success).toBe(true)
    expect(attributeTypes.timestamp_system.valueSchema({ source: 'created_at' }).safeParse('2024-01-01T00:00:00Z').success)
      .toBe(true)
  })

  it('uses Draft 2020-12 JSON Schema without external references and enforces the byte cap', () => {
    const config = {
      schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    }
    expect(attributeTypes.json.valueSchema(config).parse({ name: 'Ada' })).toEqual({ name: 'Ada' })
    expect(attributeTypes.json.valueSchema(config).safeParse({ name: 1 }).success).toBe(false)
    expect(attributeTypes.json.configSchema.safeParse({ schema: { $ref: 'https://example.com/schema.json' } }).success)
      .toBe(false)
    expect(attributeTypes.json.valueSchema({}).safeParse('x'.repeat(65_536)).success).toBe(false)
  })
})
