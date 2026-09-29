import type { AttributeType } from '@deepcrm/db'
import { describe, expect, it } from 'vitest'

import { attributeExample, attributeTypes } from '../src/attribute-types/index.js'

// Representative configs per type: defaults, bounds that move the example, and archived options.
const representativeConfigs: Record<AttributeType, readonly Record<string, unknown>[]> = {
  text: [{}, { maxLength: 200 }, { maxLength: 5 }, { maxLength: 1 }],
  rich_text: [{}],
  number: [
    {}, { precision: 0 }, { precision: 2, min: 100, max: 200 }, { min: -10, max: -5 },
    { min: 0.25, max: 0.75, precision: 2 }, { max: 10 }, { min: 42.5, precision: 0 },
  ],
  currency: [
    {}, { defaultCurrency: 'EUR' }, { fixedCurrency: 'GBP' }, { defaultCurrency: 'JPY', fixedCurrency: 'JPY' },
  ],
  percent: [{}],
  boolean: [{}],
  date: [{}],
  datetime: [{}],
  select: [
    { options: [{ id: 'lead', label: 'Lead' }] },
    { options: [{ id: 'retired', label: 'Retired', archived: true }, { id: 'active', label: 'Active' }] },
  ],
  status: [
    { options: [
      { id: 'won', label: 'Won', category: 'won', position: 1 },
      { id: 'open', label: 'Open', category: 'open', position: 0 },
    ] },
    { options: [
      { id: 'draft', label: 'Draft', category: 'open', position: 0, archived: true },
      { id: 'sent', label: 'Sent', category: 'open', position: 1 },
      { id: 'paid', label: 'Paid', category: 'won', position: 2 },
    ] },
  ],
  rating: [{}, { max: 3 }, { max: 1 }, { max: 10 }],
  email: [{}],
  phone: [{}],
  url: [{}],
  domain: [{}],
  registry_id: [{}, { jurisdiction: 'GB' }],
  location: [{}],
  personal_name: [{}],
  actor_reference: [{}, { allow: ['agent'] }, { allow: ['human'], role: 'owner' }, { allow: ['agent', 'human'] }],
  record_reference: [
    { objectTypes: ['company'] }, { objectTypes: ['person', 'company'], relationTypeSlug: 'works_at' },
  ],
  timestamp_system: [{ source: 'created_at' }, { source: 'last_activity_at' }],
  json: [
    {},
    { schema: {
      type: 'object', required: ['plan', 'seats'],
      properties: { plan: { type: 'string', enum: ['pro', 'team'] }, seats: { type: 'integer', minimum: 1 } },
    } },
    { schema: { type: 'array', minItems: 2, items: { type: 'string', minLength: 10 } } },
    { schema: {
      type: 'object', examples: [{ tier: 'gold' }], required: ['tier'], properties: { tier: { type: 'string' } },
    } },
    { schema: { anyOf: [{ type: 'number', exclusiveMinimum: 5 }, { type: 'null' }] } },
  ],
}

function cases() {
  return Object.values(attributeTypes).flatMap((definition) => (
    representativeConfigs[definition.type].map((config) => ({ definition, config }))
  ))
}

describe('attribute type examples', () => {
  it('covers every registered type with at least one representative config', () => {
    for (const definition of Object.values(attributeTypes)) {
      expect(representativeConfigs[definition.type].length, definition.type).toBeGreaterThan(0)
      for (const config of representativeConfigs[definition.type]) {
        expect(definition.configSchema.safeParse(config).success, `${definition.type} ${JSON.stringify(config)}`)
          .toBe(true)
      }
    }
  })

  it('offers a single example that the type\'s own valueSchema accepts', () => {
    for (const { definition, config } of cases()) {
      const example = definition.example(config)
      const label = `${definition.type} ${JSON.stringify(config)} -> ${JSON.stringify(example)}`
      expect(definition.valueSchema(config).safeParse(example).success, label).toBe(true)
      expect(attributeExample({ type: definition.type, config, isMulti: false }), label).toEqual(example)
    }
  })

  it('wraps the example in an array for multi attributes and that array validates element-wise', () => {
    for (const { definition, config } of cases()) {
      if (!definition.supportsMulti) continue
      const multi = attributeExample({ type: definition.type, config, isMulti: true })
      const label = `${definition.type} ${JSON.stringify(config)}`
      expect(multi, label).toEqual([definition.example(config)])
      expect(definition.valueSchema(config).array().min(1).safeParse(multi).success, label).toBe(true)
    }
  })

  it('pins the shapes agents copy most', () => {
    expect(attributeTypes.personal_name.example({})).toEqual({ full: 'Ada Lovelace' })
    expect(attributeTypes.select.example(representativeConfigs.select[1])).toBe('active')
    expect(attributeTypes.status.example(representativeConfigs.status[0])).toBe('open')
    expect(attributeTypes.status.example(representativeConfigs.status[1])).toBe('sent')
    expect(attributeTypes.currency.example({ fixedCurrency: 'GBP' })).toEqual({ amount: '1250.50', currency: 'GBP' })
    expect(attributeTypes.currency.example({ defaultCurrency: 'EUR' })).toEqual({ amount: '1250.50', currency: 'EUR' })
    expect(attributeTypes.number.example({ min: -10, max: -5 })).toBe(-5)
    expect(attributeTypes.number.example({ min: 42.5, precision: 0 })).toBe(43)
    expect(attributeTypes.record_reference.example({ objectTypes: ['company'] }))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(attributeTypes.actor_reference.example({ allow: ['agent'] }))
      .toEqual({ type: 'agent', id: 'agent:<app>:<agent id>' })
    expect(attributeTypes.json.example(representativeConfigs.json[1])).toEqual({ plan: 'pro', seats: 1 })
  })

  it('offers no example when the config admits no value or does not parse', () => {
    const impossible: Array<{ type: AttributeType; config: Record<string, unknown> }> = [
      { type: 'select', config: { options: [{ id: 'gone', label: 'Gone', archived: true }] } },
      { type: 'status', config: { options: [
        { id: 'a', label: 'A', category: 'open', position: 0, archived: true },
        { id: 'b', label: 'B', category: 'won', position: 1, archived: true },
      ] } },
      { type: 'number', config: { min: 0.5, max: 0.7, precision: 0 } },
      { type: 'json', config: { schema: { type: 'string', pattern: '^z+$' } } },
      { type: 'text', config: { maxLength: 0 } },
    ]
    for (const { type, config } of impossible) {
      expect(attributeExample({ type, config, isMulti: false }), `${type} ${JSON.stringify(config)}`).toBeUndefined()
      expect(attributeExample({ type, config, isMulti: true }), `${type} ${JSON.stringify(config)}`).toBeUndefined()
    }
  })
})
