import Decimal from 'decimal.js'
import { z } from 'zod'

import { orderedFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({
  precision: z.number().int().min(0).max(10).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
}).strict().superRefine((config, context) => {
  if (config.min !== undefined && config.max !== undefined && config.min > config.max) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'min must not exceed max', path: ['min'] })
  }
})

function checkedDecimal(decimal: Decimal, config: unknown): string {
  const parsedConfig = configSchema.parse(config)
  if (parsedConfig.precision !== undefined && decimal.decimalPlaces() > parsedConfig.precision) {
    throw new Error(`number has more than ${parsedConfig.precision} decimal places`)
  }
  if (parsedConfig.min !== undefined && decimal.lessThan(parsedConfig.min)) {
    throw new Error('number is below min')
  }
  if (parsedConfig.max !== undefined && decimal.greaterThan(parsedConfig.max)) {
    throw new Error('number is above max')
  }
  return decimal.toFixed()
}

function canonicalDecimal(value: number, config: unknown): string {
  const input = z.number().finite().parse(value)
  return checkedDecimal(new Decimal(input.toString()), config)
}

function storedDecimal(value: unknown, config: unknown): string {
  if (typeof value === 'number') return canonicalDecimal(value, config)
  if (typeof value !== 'string') throw new Error('number must be canonical decimal text')
  return checkedDecimal(new Decimal(value), config)
}

export const number: AttributeTypeDef = {
  type: 'number',
  configSchema,
  valueSchema: (config) => z.number().finite().transform((value, context) => {
    try {
      return canonicalDecimal(value, config)
    } catch (error) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'invalid number' })
      return z.NEVER
    }
  }),
  normalize: (value, config) => canonicalDecimal(z.number().finite().parse(value), config),
  toSearchText: (value, config) => storedDecimal(value, config),
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: true,
  filterOps: orderedFilterOps,
}
