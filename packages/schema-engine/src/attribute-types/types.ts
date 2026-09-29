import type { AttributeType } from '@deepcrm/db'
import type { z } from 'zod'

export const filterOpValues = [
  'eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null', 'contains', 'starts_with',
  'gt', 'gte', 'lt', 'lte', 'between',
] as const

export type FilterOp = (typeof filterOpValues)[number]

/** A JSON value an agent can copy: what one attribute value looks like on the wire. */
export type ExampleValue = boolean | number | string | null | ExampleValue[] | { [key: string]: ExampleValue }

export type AttributeTypeDef = {
  type: AttributeType
  configSchema: z.ZodType
  valueSchema: (config: unknown) => z.ZodType
  /** One single (never multi-wrapped) value that `valueSchema(config)` accepts. */
  example: (config: unknown) => ExampleValue
  normalize: (value: unknown, config: unknown) => string | null
  toSearchText: (value: unknown, config: unknown) => string | null
  supportsMulti: boolean
  supportsUnique: boolean
  supportsIndexed: boolean
  filterOps: FilterOp[]
}

export const equalityFilterOps: FilterOp[] = ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null']

export const orderedFilterOps: FilterOp[] = [
  ...equalityFilterOps,
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
]

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}
