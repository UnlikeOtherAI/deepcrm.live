import { getDomain } from 'tldts'
import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()

function hostnameFor(value: string): string {
  const trimmed = value.trim()
  if (/^https?:\/\//iu.test(trimmed)) {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('must use http or https')
    return url.hostname
  }
  if (trimmed.includes('://')) throw new Error('must be a hostname or absolute http(s) URL')
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?$/iu.test(trimmed)) {
    throw new Error('must be a hostname or absolute http(s) URL')
  }
  return trimmed.replace(/\.$/u, '')
}

function canonicalDomain(value: string): string {
  const domain = getDomain(hostnameFor(value), { allowPrivateDomains: true })
  if (domain === null) throw new Error('must contain a registrable domain')
  return domain.toLocaleLowerCase()
}

const domainValueSchema = z.string().transform((value, context) => {
  try {
    return canonicalDomain(value)
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'invalid domain' })
    return z.NEVER
  }
})

export const domain: AttributeTypeDef = {
  type: 'domain',
  configSchema,
  valueSchema: () => domainValueSchema,
  normalize: (value) => domainValueSchema.parse(value),
  toSearchText: (value) => domainValueSchema.parse(value),
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: true,
  filterOps: [...equalityFilterOps, 'contains', 'starts_with'],
}
