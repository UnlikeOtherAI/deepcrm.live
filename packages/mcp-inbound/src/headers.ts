import { z } from 'zod'

const BearerSchema = z.string().regex(/^Bearer\s+\S+$/i)

export type InboundHeaders = {
  bearer?: string
  delegation?: string
  appContext?: string
  nessieContext?: string
}

function singleHeader(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0].trim()
  return undefined
}

export function readInboundHeaders(headers: Record<string, unknown>): InboundHeaders {
  const normalized = new Map<string, string>()
  for (const [name, rawValue] of Object.entries(headers)) {
    const value = singleHeader(rawValue)
    if (value !== undefined) normalized.set(name.toLowerCase(), value)
  }

  const authorization = normalized.get('authorization')
  const bearer = authorization !== undefined && BearerSchema.safeParse(authorization).success
    ? authorization.replace(/^Bearer\s+/i, '')
    : undefined

  return {
    bearer,
    delegation: normalized.get('x-uoa-delegation'),
    appContext: normalized.get('x-app-context'),
    nessieContext: normalized.get('x-nessie-context'),
  }
}
