import { code as findCurrency } from 'currency-codes'
import Decimal from 'decimal.js'
import { z } from 'zod'

import { orderedFilterOps, type AttributeTypeDef } from './types.js'

const currencyCode = z.string()
  .regex(/^[A-Z]{3}$/u, 'must be an ISO 4217 currency code')
  .refine((value) => findCurrency(value) !== undefined, 'must be an ISO 4217 currency code')
const configSchema = z.object({
  defaultCurrency: currencyCode.default('USD'),
  fixedCurrency: currencyCode.optional(),
}).strict()

function canonicalAmount(amount: string): string {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,4})?$/u.test(amount)) {
    throw new Error('amount must be a non-exponent decimal with at most four decimal places')
  }
  return new Decimal(amount).toFixed()
}

function valueFor(config: unknown) {
  const parsedConfig = configSchema.parse(config)
  return z.object({ amount: z.string(), currency: currencyCode }).strict().transform((value, context) => {
    try {
      const amount = canonicalAmount(value.amount)
      if (parsedConfig.fixedCurrency !== undefined && value.currency !== parsedConfig.fixedCurrency) {
        throw new Error(`currency must be ${parsedConfig.fixedCurrency}`)
      }
      return { amount, currency: value.currency }
    } catch (error) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'invalid currency' })
      return z.NEVER
    }
  })
}

export const currency: AttributeTypeDef = {
  type: 'currency',
  configSchema,
  valueSchema: valueFor,
  normalize: () => null,
  toSearchText: (value, config) => {
    const parsed = valueFor(config).parse(value)
    return `${parsed.amount} ${parsed.currency}`
  },
  supportsMulti: true,
  supportsUnique: false,
  supportsIndexed: false,
  filterOps: orderedFilterOps,
}
