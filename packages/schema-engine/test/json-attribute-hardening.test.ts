import { describe, expect, it } from 'vitest'

import {
  json,
  jsonValidatorCacheStats,
  resetJsonValidatorCacheForTests,
} from '../src/attribute-types/json.js'

function valueSchema(schema: object) {
  return json.valueSchema({ schema })
}

describe('json attribute hardening', () => {
  it('rejects cycles, depth, unsafe values, accessors, and sparse arrays without throwing', () => {
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    const deep: unknown[] = []
    let cursor = deep
    for (let index = 0; index <= 100; index += 1) {
      const child: unknown[] = []
      cursor.push(child)
      cursor = child
    }
    const accessor = {}
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'unsafe' })
    const sparse = new Array<unknown>(1)
    const schema = json.valueSchema({})

    for (const value of [cycle, deep, accessor, sparse, new Date(), Number.NaN, Infinity, () => null]) {
      expect(() => schema.safeParse(value)).not.toThrow()
      expect(schema.safeParse(value).success).toBe(false)
    }
  })

  it('enforces the exact UTF-8 byte boundary', () => {
    const schema = json.valueSchema({})
    expect(schema.safeParse('x'.repeat(65_534)).success).toBe(true)
    expect(schema.safeParse('x'.repeat(65_535)).success).toBe(false)
    expect(schema.safeParse('£'.repeat(32_768)).success).toBe(false)
  })

  it('accepts local references and literal reference-looking const values', () => {
    const local = {
      $defs: { name: { type: 'string' } },
      type: 'object',
      properties: { name: { $ref: '#/$defs/name' } },
      required: ['name'],
    }
    expect(json.configSchema.safeParse({ schema: local }).success).toBe(true)
    expect(valueSchema(local).safeParse({ name: 'Ada' }).success).toBe(true)
    expect(valueSchema(local).safeParse({ name: 1 }).success).toBe(false)
    expect(json.configSchema.safeParse({
      schema: { const: { $ref: 'https://literal.example/schema' } },
    }).success).toBe(true)
  })

  it('rejects actual external reference keywords and external id bases', () => {
    for (const schema of [
      { $ref: 'https://example.com/schema' },
      { $dynamicRef: 'https://example.com/schema#node' },
      { $recursiveRef: 'urn:example:node' },
      { $id: 'https://example.com/schema', type: 'object' },
    ]) {
      expect(() => json.configSchema.safeParse({ schema })).not.toThrow()
      expect(json.configSchema.safeParse({ schema }).success).toBe(false)
    }
  })

  it('uses a mutation-safe bounded canonical validator cache', () => {
    resetJsonValidatorCacheForTests()
    const name = { type: 'string' }
    const first: { type: string; properties: Record<string, { type: string }> } = {
      type: 'object',
      properties: { name },
    }
    const reordered = { properties: { name: { type: 'string' } }, type: 'object' }
    valueSchema(first)
    expect(jsonValidatorCacheStats()).toEqual({ size: 1, compilations: 1 })
    name.type = 'number'
    expect(valueSchema(reordered).safeParse({ name: 'Ada' }).success).toBe(true)
    expect(jsonValidatorCacheStats()).toEqual({ size: 1, compilations: 1 })

    for (let index = 0; index < 110; index += 1) {
      valueSchema({ type: 'object', properties: { [`field_${index}`]: { type: 'string' } } })
    }
    expect(jsonValidatorCacheStats().size).toBe(100)
  })

  it('keeps JSON opaque to the filter grammar', () => {
    expect(json.filterOps).toEqual([])
  })
})
