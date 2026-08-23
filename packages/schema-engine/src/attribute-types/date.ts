import { z } from 'zod'

import { orderedFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/u

function isGregorianDate(value: string): boolean {
  const match = datePattern.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= days
}

export const date: AttributeTypeDef = {
  type: 'date',
  configSchema,
  valueSchema: () => z.string().refine(isGregorianDate, 'must be a real Gregorian YYYY-MM-DD date'),
  normalize: (value) => z.string().refine(isGregorianDate).parse(value),
  toSearchText: (value) => z.string().refine(isGregorianDate).parse(value),
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: true,
  filterOps: orderedFilterOps,
}
