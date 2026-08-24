import Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import { z } from 'zod'

import { type AttributeTypeDef } from './types.js'

type JsonPrimitive = boolean | number | string | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

const MAX_JSON_BYTES = 65_536
const MAX_JSON_DEPTH = 100
const MAX_VALIDATORS = 100
const validators = new Map<string, ValidateFunction>()
let compilationCount = 0

type Inspection = { value: JsonValue; canonical: string } | { reason: string }

function isFailure(inspection: Inspection): inspection is { reason: string } {
  return 'reason' in inspection
}

function inspectJsonUnsafe(value: unknown): Inspection {
  const ancestors = new WeakSet<object>()
  const stack: Array<{ value: unknown; depth: number; leave: boolean }> = [{ value, depth: 0, leave: false }]

  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) continue
    const current = frame.value
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return { reason: 'must contain only finite JSON numbers' }
      continue
    }
    if (typeof current !== 'object') return { reason: 'must be a JSON value' }
    if (frame.leave) {
      ancestors.delete(current)
      continue
    }
    if (frame.depth > MAX_JSON_DEPTH) return { reason: 'must not exceed the JSON nesting limit' }
    if (ancestors.has(current)) return { reason: 'must not contain a cycle' }
    ancestors.add(current)
    stack.push({ value: current, depth: frame.depth, leave: true })

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (!Object.hasOwn(current, index)) return { reason: 'must not contain sparse arrays' }
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
        if (descriptor === undefined || !('value' in descriptor)) return { reason: 'must not contain accessors' }
        stack.push({ value: descriptor.value, depth: frame.depth + 1, leave: false })
      }
      if (Reflect.ownKeys(current).some((key) => key !== 'length' && !/^\d+$/u.test(String(key)))) {
        return { reason: 'must not contain non-JSON array properties' }
      }
      continue
    }
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) return { reason: 'must contain plain objects only' }
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string') return { reason: 'must not contain symbol keys' }
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return { reason: 'must not contain accessors or hidden properties' }
      }
      stack.push({ value: descriptor.value, depth: frame.depth + 1, leave: false })
    }
  }

  const json = value as JsonValue
  const canonical = canonicalJson(json)
  if (Buffer.byteLength(canonical, 'utf8') > MAX_JSON_BYTES) return { reason: 'must not exceed 64 KiB' }
  return { value: json, canonical }
}

function inspectJson(value: unknown): Inspection {
  try {
    return inspectJsonUnsafe(value)
  } catch {
    return { reason: 'must be a safe JSON value' }
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => {
    const child = value[key]
    if (child === undefined) throw new Error('validated JSON object property is missing')
    return `${JSON.stringify(key)}:${canonicalJson(child)}`
  }).join(',')}}`
}

function validateReference(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('#')
}

function schemaHasExternalReference(schema: JsonValue): boolean {
  const schemaObjectKeys = new Set(['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas'])
  const singleSchemaKeys = new Set([
    'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'items',
  ])
  const schemaArrayKeys = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
  const stack: JsonValue[] = [schema]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || current === null || Array.isArray(current) || typeof current !== 'object') continue
    for (const refKey of ['$ref', '$dynamicRef', '$recursiveRef']) {
      if (Object.hasOwn(current, refKey) && !validateReference(current[refKey])) return true
    }
    if (Object.hasOwn(current, '$id') && !validateReference(current.$id)) return true
    for (const [key, child] of Object.entries(current)) {
      if (schemaObjectKeys.has(key) && child !== null && !Array.isArray(child) && typeof child === 'object') {
        for (const candidate of Object.values(child)) stack.push(candidate)
      } else if (singleSchemaKeys.has(key)) {
        stack.push(child)
      } else if (schemaArrayKeys.has(key) && Array.isArray(child)) {
        stack.push(...child)
      }
    }
  }
  return false
}

function createAjv(): Ajv2020 {
  return new Ajv2020({ allErrors: true, strict: true, loadSchema: undefined })
}

function compiledValidator(canonical: string): ValidateFunction {
  const cached = validators.get(canonical)
  if (cached !== undefined) {
    validators.delete(canonical)
    validators.set(canonical, cached)
    return cached
  }
  const clonedSchema = JSON.parse(canonical)
  const validator = createAjv().compile(clonedSchema)
  compilationCount += 1
  validators.set(canonical, validator)
  if (validators.size > MAX_VALIDATORS) {
    const oldest = validators.keys().next().value
    if (oldest !== undefined) validators.delete(oldest)
  }
  return validator
}

const jsonSchema = z.unknown().superRefine((value, context) => {
  const inspected = inspectJson(value)
  if (isFailure(inspected) || inspected.value === null || Array.isArray(inspected.value) || typeof inspected.value !== 'object') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: isFailure(inspected) ? inspected.reason : 'JSON Schema must be an object',
    })
    return
  }
  try {
    if (schemaHasExternalReference(inspected.value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'JSON Schema must not contain external references' })
      return
    }
    compiledValidator(inspected.canonical)
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid Draft 2020-12 JSON Schema' })
  }
})

const configSchema = z.object({ schema: jsonSchema.optional() }).strict()

function jsonValueSchema(config: unknown) {
  const parsedConfig = configSchema.parse(config)
  const inspectedSchema = parsedConfig.schema === undefined ? undefined : inspectJson(parsedConfig.schema)
  const validate = inspectedSchema === undefined || isFailure(inspectedSchema)
    ? undefined
    : compiledValidator(inspectedSchema.canonical)

  return z.unknown().superRefine((value, context) => {
    const inspected = inspectJson(value)
    if (isFailure(inspected)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: inspected.reason })
      return
    }
    if (validate !== undefined && !validate(inspected.value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'JSON Schema validation failed' })
    }
  })
}

export function jsonValidatorCacheStats(): { size: number; compilations: number } {
  return { size: validators.size, compilations: compilationCount }
}

export function resetJsonValidatorCacheForTests(): void {
  validators.clear()
  compilationCount = 0
}

export const json: AttributeTypeDef = {
  type: 'json',
  configSchema,
  valueSchema: jsonValueSchema,
  normalize: () => null,
  toSearchText: () => null,
  supportsMulti: true,
  supportsUnique: false,
  supportsIndexed: false,
  filterOps: [],
}
