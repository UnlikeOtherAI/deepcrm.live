import Ajv2020 from 'ajv/dist/2020.js'
import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

type JsonPrimitive = boolean | number | string | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value).every(isJsonValue)
}

function hasExternalReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExternalReference)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([key, child]) => {
    if (key === '$ref' && typeof child === 'string') return !child.startsWith('#')
    return hasExternalReference(child)
  })
}

const jsonSchema = z.record(z.unknown()).superRefine((value, context) => {
  if (hasExternalReference(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'JSON Schema must not contain external references' })
    return
  }
  try {
    new Ajv2020({ allErrors: true, strict: true }).compile(value)
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'invalid Draft 2020-12 JSON Schema',
    })
  }
})

const configSchema = z.object({ schema: jsonSchema.optional() }).strict()

function jsonValueSchema(config: unknown) {
  const parsedConfig = configSchema.parse(config)
  const validate = parsedConfig.schema === undefined
    ? undefined
    : new Ajv2020({ allErrors: true, strict: true }).compile(parsedConfig.schema)
  return z.unknown().superRefine((value, context) => {
    if (!isJsonValue(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a JSON value' })
      return
    }
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 65_536) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'must not exceed 64 KiB' })
      return
    }
    if (validate !== undefined && !validate(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: validate.errors?.map((error) => error.message ?? error.instancePath).join('; ') ?? 'schema mismatch',
      })
    }
  })
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
  filterOps: equalityFilterOps,
}
