import { ErrorCode, ServiceError } from '@deepcrm/schemas'

type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type CanonicalValue = { value: JsonValue; text: string }

const MAX_DEPTH = 100

function invalidJson(): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Invalid JSON value')
}

function arrayIndex(key: string, length: number): boolean {
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

function canonicalize(value: unknown, ancestors: WeakSet<object>, depth: number): CanonicalValue {
  if (depth > MAX_DEPTH) invalidJson()
  if (value === null) return { value, text: 'null' }
  if (typeof value === 'string') {
    const normalized = value.normalize('NFC')
    return { value: normalized, text: JSON.stringify(normalized) }
  }
  if (typeof value === 'boolean') return { value, text: JSON.stringify(value) }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidJson()
    return { value, text: JSON.stringify(value) }
  }
  if (typeof value !== 'object') invalidJson()
  if (ancestors.has(value)) invalidJson()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return canonicalArray(value, ancestors, depth)
    return canonicalObject(value, ancestors, depth)
  } finally {
    ancestors.delete(value)
  }
}

function canonicalArray(value: unknown[], ancestors: WeakSet<object>, depth: number): CanonicalValue {
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue
    if (typeof key !== 'string' || !arrayIndex(key, value.length)) invalidJson()
  }
  const result: JsonValue[] = []
  const text: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalidJson()
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !('value' in descriptor)) invalidJson()
    const child = canonicalize(descriptor.value, ancestors, depth + 1)
    result.push(child.value)
    text.push(child.text)
  }
  return { value: result, text: `[${text.join(',')}]` }
}

function canonicalObject(value: object, ancestors: WeakSet<object>, depth: number): CanonicalValue {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalidJson()
  const entries: Array<readonly [string, CanonicalValue]> = []
  const keys = new Set<string>()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalidJson()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) invalidJson()
    const normalizedKey = key.normalize('NFC')
    if (keys.has(normalizedKey)) invalidJson()
    keys.add(normalizedKey)
    entries.push([normalizedKey, canonicalize(descriptor.value, ancestors, depth + 1)])
  }
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  const result: { [key: string]: JsonValue } = {}
  for (const [key, child] of entries) {
    Object.defineProperty(result, key, {
      value: child.value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return {
    value: result,
    text: `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${child.text}`).join(',')}}`,
  }
}

function run(value: unknown): CanonicalValue {
  try {
    return canonicalize(value, new WeakSet(), 0)
  } catch (error) {
    if (error instanceof ServiceError) throw error
    return invalidJson()
  }
}

export function canonicalJson(value: unknown): string {
  return run(value).text
}

export function canonicalJsonValue(value: unknown): JsonValue {
  return run(value).value
}
