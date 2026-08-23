import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()

function canonicalUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('must use http or https')
  if (url.username !== '' || url.password !== '') throw new Error('must not contain credentials')
  if (url.pathname === '/') {
    return `${url.origin}${url.search}${url.hash}`
  }
  return url.toString()
}

const urlValueSchema = z.string().transform((value, context) => {
  try {
    return canonicalUrl(value)
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'invalid URL' })
    return z.NEVER
  }
})

export const url: AttributeTypeDef = {
  type: 'url',
  configSchema,
  valueSchema: () => urlValueSchema,
  normalize: (value) => urlValueSchema.parse(value),
  toSearchText: (value) => urlValueSchema.parse(value),
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: true,
  filterOps: [...equalityFilterOps, 'contains', 'starts_with'],
}
