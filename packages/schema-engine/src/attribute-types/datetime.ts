import { z } from 'zod'

import { orderedFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()
const datetimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u

export function canonicalDateTime(value: string): string {
  const match = datetimePattern.exec(value)
  if (match === null) throw new Error('must be an RFC3339 datetime with Z or an explicit offset')
  const date = `${match[1]}-${match[2]}-${match[3]}`
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offset = match[8]
  if (!isRealDate(date) || hour > 23 || minute > 59 || second > 59 || !isOffset(offset)) {
    throw new Error('must be a valid RFC3339 datetime')
  }
  const milliseconds = Date.parse(value)
  if (Number.isNaN(milliseconds)) throw new Error('must be a valid RFC3339 datetime')
  return new Date(milliseconds).toISOString()
}

function isRealDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function isOffset(value: string | undefined): boolean {
  if (value === 'Z') return true
  if (value === undefined) return false
  const match = /^[+-](\d{2}):(\d{2})$/u.exec(value)
  return match !== null && Number(match[1]) <= 23 && Number(match[2]) <= 59
}

const datetimeValueSchema = z.string().transform((value, context) => {
  try {
    return canonicalDateTime(value)
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'invalid datetime' })
    return z.NEVER
  }
})

export const datetime: AttributeTypeDef = {
  type: 'datetime',
  configSchema,
  valueSchema: () => datetimeValueSchema,
  normalize: (value) => datetimeValueSchema.parse(value),
  toSearchText: (value) => datetimeValueSchema.parse(value),
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: true,
  filterOps: orderedFilterOps,
}
