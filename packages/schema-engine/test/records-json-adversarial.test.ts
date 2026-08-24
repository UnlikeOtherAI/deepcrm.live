import fc from 'fast-check'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'
import { describe, expect, it } from 'vitest'

import { canonicalJson, canonicalJsonValue } from '../src/records/json.js'

function expectInvalid(value: unknown): void {
  try {
    canonicalJson(value)
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError)
    if (error instanceof ServiceError) expect(error.code).toBe(ErrorCode.VALIDATION_FAILED)
    return
  }
  throw new Error('Expected invalid JSON to be rejected')
}

describe('record JSON canonicalization', () => {
  it('returns a sorted NFC canonical copy without mutating the input or reordering arrays', () => {
    const input = { z: ['last', { b: 'e\u0301', a: 1 }], a: 'first' }
    const before = structuredClone(input)
    expect(canonicalJson(input)).toBe('{"a":"first","z":["last",{"a":1,"b":"é"}]}')
    expect(canonicalJsonValue(input)).toEqual({ a: 'first', z: ['last', { a: 1, b: 'é' }] })
    expect(input).toEqual(before)
  })

  it('rejects unsafe, cyclic, nonplain, sparse, accessor, and NFC-colliding values with structured errors', () => {
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    const sparse = new Array<unknown>(1)
    const accessor = {}
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'unsafe' })
    const symbolKey = { value: 1 }
    Object.defineProperty(symbolKey, Symbol('unsafe'), { enumerable: true, value: 2 })
    const duplicateNfc = { 'é': 1, 'e\u0301': 2 }
    const trapped = new Proxy({}, { getPrototypeOf: () => { throw new Error('trap') } })
    for (const value of [
      undefined, Number.NaN, Infinity, 1n, () => null, cycle, sparse, accessor, symbolKey,
      duplicateNfc, new Date(), trapped,
    ]) expectInvalid(value)
  })

  it('caps depth and is idempotent for arbitrary finite JSON data', () => {
    const deep: unknown[] = []
    let cursor = deep
    for (let index = 0; index <= 100; index += 1) {
      const child: unknown[] = []
      cursor.push(child)
      cursor = child
    }
    expectInvalid(deep)
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      const canonical = canonicalJson(value)
      expect(canonicalJson(canonicalJsonValue(value))).toBe(canonical)
    }), { numRuns: 100 })
  })
})
