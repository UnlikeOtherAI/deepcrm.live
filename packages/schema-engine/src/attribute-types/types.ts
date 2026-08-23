import type { AttributeType } from '@deepcrm/db'
import type { z } from 'zod'

export const filterOpValues = [
  'eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null', 'contains', 'starts_with',
  'gt', 'gte', 'lt', 'lte', 'between',
] as const

export type FilterOp = (typeof filterOpValues)[number]

export type AttributeTypeDef = {
  type: AttributeType
  configSchema: z.ZodType
  valueSchema: (config: unknown) => z.ZodType
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
