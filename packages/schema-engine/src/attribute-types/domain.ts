import { domainToASCII } from 'node:url'
import { getDomain } from 'tldts'
import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()

function hostnameFor(value: string): string {
  const trimmed = value.trim()
  let hostname: string
  if (/^https?:\/\//iu.test(trimmed)) {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('must use http or https')
    hostname = url.hostname
  } else {
    if (trimmed.includes('://')) throw new Error('must be a hostname or absolute http(s) URL')
    hostname = domainToASCII(trimmed)
  }
  const withoutRootDot = hostname.replace(/\.$/u, '')
  const labels = withoutRootDot.split('.')
  const valid = withoutRootDot.length <= 253 && labels.every((label) => (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label)
  ))
  if (!valid) {
    throw new Error('must be a hostname or absolute http(s) URL')
  }
  return withoutRootDot
}

function canonicalDomain(value: string): string {
  const domain = getDomain(hostnameFor(value), { allowPrivateDomains: true })
  if (domain === null) throw new Error('must contain a registrable domain')
  return domain.toLowerCase()
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
