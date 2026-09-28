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
  actor: z.enum(['agent', 'human']).optional(),
  agentId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  requestId: z.string().min(1),
  delegation_jti: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  args_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
}).passthrough()

export type ExpectedContextBinding = {
  delegationJti: string
  tool: string
  argsSha256: string
}

/**
 * What the calling app's signed context says about who is acting.
 *
 * An agent call names the agent and its run (`agentId`, `runId`,
 * `toolCallId`). A person acting in the app's own UI is attested positively
 * with `actor: "human"` and names no agent or run: the app never invents
 * agent provenance for a click, and a context that merely omits the agent is
 * refused rather than read as a human (auth-and-tenancy §1, R20).
 */
export type NessieContext = {
  sub: string
  agentId: string | null
  provenance: {
    runId: string
    toolCallId: string
    requestId: string
  } | null
}

export type NessieContextOptions = {
  jwks?: JWTVerifyGetKey
  jwksUrl?: string | URL
  audience: string
  issuer: string
  now: Date
  expectedBinding?: ExpectedContextBinding
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
  const expected = options.expectedBinding
  if (expected !== undefined) {
    if (
      claims.delegation_jti !== expected.delegationJti
      || claims.tool !== expected.tool
      || claims.args_sha256?.toLowerCase() !== expected.argsSha256
    ) throw new Error('Context binding does not match invocation')
  }

  if (claims.actor === 'human') {
    if (claims.agentId !== undefined || claims.runId !== undefined || claims.toolCallId !== undefined) {
      throw new Error('A human context names no agent or run')
    }
    return { sub: claims.sub, agentId: null, provenance: null }
  }
  if (claims.agentId === undefined || claims.runId === undefined || claims.toolCallId === undefined) {
    throw new Error('An agent context names its agent, run and tool call')
  }
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
