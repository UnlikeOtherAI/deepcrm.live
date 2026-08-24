import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'

const CLOCK_TOLERANCE_SECONDS = 30
const MAX_TOKEN_TTL_SECONDS = 300
const remoteJwksByUrl = new Map<string, JWTVerifyGetKey>()

const ContextClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  sub: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  agentId: z.string().min(1),
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  requestId: z.string().min(1),
}).passthrough()

export type NessieContext = {
  sub: string
  agentId: string
  provenance: {
    runId: string
    toolCallId: string
    requestId: string
  }
}

export type NessieContextOptions = {
  jwks?: JWTVerifyGetKey
  jwksUrl?: string | URL
  audience: string
  issuer: string
  now: Date
}

function resolveJwks(options: NessieContextOptions): JWTVerifyGetKey {
  if (options.jwks !== undefined) return options.jwks
  if (options.jwksUrl === undefined) throw new Error('A context JWKS resolver or URL is required')
  const url = new URL(options.jwksUrl).href
  const existing = remoteJwksByUrl.get(url)
  if (existing !== undefined) return existing
  const created = createRemoteJWKSet(new URL(url))
  remoteJwksByUrl.set(url, created)
  return created
}

export async function verifyNessieContext(
  token: string,
  options: NessieContextOptions,
): Promise<NessieContext> {
  const verified = await jwtVerify(token, resolveJwks(options), {
    algorithms: ['RS256'],
    issuer: options.issuer,
    audience: options.audience,
    currentDate: options.now,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
  })
  const claims = ContextClaimsSchema.parse(verified.payload)
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TOKEN_TTL_SECONDS) {
    throw new Error('Context lifetime exceeds 300 seconds')
  }
  const now = Math.floor(options.now.getTime() / 1000)
  if (claims.iat > now + CLOCK_TOLERANCE_SECONDS) throw new Error('Context issued in the future')

  return {
    sub: claims.sub,
    agentId: claims.agentId,
    provenance: {
      runId: claims.runId,
      toolCallId: claims.toolCallId,
      requestId: claims.requestId,
    },
  }
}
