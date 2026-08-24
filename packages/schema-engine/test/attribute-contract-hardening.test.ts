import { describe, expect, it } from 'vitest'

import { attributeTypes } from '../src/attribute-types/index.js'

describe('attribute registry contract hardening', () => {
  it('uses exact select and status option contracts', () => {
    expect(attributeTypes.select.configSchema.safeParse({
      options: [{ id: 'BAD ID', label: 'Bad' }],
    }).success).toBe(false)
    expect(attributeTypes.select.configSchema.safeParse({
      options: [{ id: 'valid_id', label: 'x'.repeat(121) }],
    }).success).toBe(false)
    expect(attributeTypes.select.configSchema.safeParse({
      options: [{ id: 'valid_id', label: 'Valid', color: 'x'.repeat(33) }],
    }).success).toBe(false)
    expect(attributeTypes.select.configSchema.safeParse({
      options: [{ id: 'valid_id', label: 'Valid', color: '' }],
    }).success).toBe(false)

    const statusConfig = {
      options: [
        { id: 'new_stage', label: 'New', color: 'blue', category: 'open', position: 0 },
        { id: 'won_stage', label: 'Won', color: 'green', category: 'won', position: 1 },
      ],
    }
    expect(attributeTypes.status.configSchema.safeParse(statusConfig).success).toBe(true)
    expect(attributeTypes.status.configSchema.safeParse({
      options: [
        { id: 'BAD ID', label: 'New', category: 'open', position: 0 },
        { id: 'won_stage', label: 'Won', category: 'won', position: 1 },
      ],
    }).success).toBe(false)
    expect(attributeTypes.select.filterOps).toContain('starts_with')
  })

  it('accepts only complete international phone input with whitespace formatting', () => {
    const schema = attributeTypes.phone.valueSchema({})
    expect(schema.parse('+44 20 7183 8750')).toBe('+442071838750')
    expect(schema.safeParse('020 7183 8750').success).toBe(false)
    expect(schema.safeParse('+44-20-7183-8750').success).toBe(false)
    expect(schema.safeParse('+44 20 7183 8750 ext. 123').success).toBe(false)
    expect(schema.safeParse('+442071838750 junk').success).toBe(false)
  })

  it('strips Markdown structure without destroying literal punctuation', () => {
    const markdown = '## State-of-the-art C#\n\nSee [docs](https://example.com) and `x-y`. ~literal~'
    expect(attributeTypes.rich_text.toSearchText(markdown, {}))
      .toBe('State-of-the-art C# See docs and x-y. ~literal~')
  })

  it('accepts only assigned ISO 4217 currencies and enforces a fixed currency', () => {
    expect(attributeTypes.currency.configSchema.safeParse({ defaultCurrency: 'USD' }).success).toBe(true)
    expect(attributeTypes.currency.configSchema.safeParse({ defaultCurrency: 'ZZZ' }).success).toBe(false)
    expect(attributeTypes.currency.valueSchema({}).safeParse({ amount: '1', currency: 'ZZZ' }).success).toBe(false)
    expect(attributeTypes.currency.valueSchema({ fixedCurrency: 'GBP' })
      .parse({ amount: '12.3400', currency: 'GBP' })).toEqual({ amount: '12.34', currency: 'GBP' })
    expect(attributeTypes.currency.valueSchema({ fixedCurrency: 'GBP' })
      .safeParse({ amount: '12.34', currency: 'USD' }).success).toBe(false)
  })

  it('parses one complete RFC 5322 mailbox or name-address', () => {
    const schema = attributeTypes.email.valueSchema({})
    expect(schema.parse('"Quoted Local"@Example.com')).toBe('"quoted local"@example.com')
    expect(schema.parse('Ada Lovelace<ADA@Example.com>')).toBe('ada@example.com')
    expect(schema.parse('Ada(comment)@Example.com')).toBe('ada@example.com')
    expect(schema.parse('user@[192.0.2.1]')).toBe('user@[192.0.2.1]')
    expect(schema.safeParse('ada@example.com trailing').success).toBe(false)
    expect(schema.safeParse('ada@example.com, grace@example.com').success).toBe(false)
  })

  it('validates host syntax for both domain input forms', () => {
    const schema = attributeTypes.domain.valueSchema({})
    expect(schema.parse('WWW.Example.CO.UK')).toBe('example.co.uk')
    expect(schema.parse('https://sub.Example.COM/path')).toBe('example.com')
    expect(schema.parse('bücher.de')).toBe('xn--bcher-kva.de')
    expect(schema.safeParse('foo_bar.example.com').success).toBe(false)
    expect(schema.safeParse('https://foo_bar.example.com/path').success).toBe(false)
  })

  it('enforces location fields and includes line two in search text', () => {
    const schema = attributeTypes.location.valueSchema({})
    expect(schema.parse({
      line1: '1 Main Street', line2: 'Suite 2', city: 'London', region: 'London',
      country: 'gb', postal: 'SW1A 1AA', lat: 51.5, lng: -0.12,
    })).toEqual({
      line1: '1 Main Street', line2: 'Suite 2', city: 'London', region: 'London',
      country: 'GB', postal: 'SW1A 1AA', lat: 51.5, lng: -0.12,
    })
    expect(attributeTypes.location.toSearchText({
      line1: '1 Main Street', line2: 'Suite 2', city: 'London', country: 'gb',
    }, {})).toBe('1 Main Street Suite 2 London GB')
    for (const [field, maximum] of [
      ['line1', 200], ['line2', 200], ['city', 120], ['region', 120], ['postal', 32],
    ] as const) {
      expect(schema.safeParse({ [field]: 'x'.repeat(maximum + 1) }).success).toBe(false)
    }
  })

  it('enforces personal-name limits while deriving a canonical full name', () => {
    const schema = attributeTypes.personal_name.valueSchema({})
    expect(schema.parse({ first: '  Ada  ', last: ' Lovelace ' }))
      .toEqual({ first: 'Ada', last: 'Lovelace', full: 'Ada Lovelace' })
    expect(schema.safeParse({ first: 'x'.repeat(121) }).success).toBe(false)
    expect(schema.safeParse({ last: 'x'.repeat(121) }).success).toBe(false)
    expect(schema.safeParse({ full: 'x'.repeat(251) }).success).toBe(false)
    expect(schema.safeParse({ first: '', last: '' }).success).toBe(false)
  })
})
