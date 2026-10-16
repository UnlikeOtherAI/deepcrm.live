import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'

const CLOCK_TOLERANCE_SECONDS = 30
const MAX_TOKEN_TTL_SECONDS = 300
const remoteJwksByUrl = new Map<string, JWTVerifyGetKey>()
const Sha256Hex = z.string().regex(/^[a-fA-F0-9]{64}$/).transform((value) => value.toLowerCase())

const ContextClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  sub: z.string().min(1).optional(),
  iat: z.number().int(),
  exp: z.number().int(),
  actor: z.enum(['agent', 'human', 'subject']).optional(),
  agentId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  requestId: z.string().min(1),
  delegation_jti: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  args_sha256: Sha256Hex.optional(),
}).passthrough()

// A subject attestation stands alone: no delegation and no person, so the
// workspace and the exact invocation are named by the app itself.
const SubjectClaimsSchema = z.object({
  org: z.string().min(1),
  team: z.string().min(1),
  tool: z.string().min(1),
  args_sha256: Sha256Hex,
}).passthrough()

/** What a delegated context commits to: the delegation it rides on and the call it names. */
export type ContextBinding = {
  delegationJti: string | null
  tool: string | null
  argsSha256: string | null
}

/**
 * What the calling app's signed context says about who is acting.
 *
 * An agent call names the agent and its run (`agentId`, `runId`,
 * `toolCallId`). A person acting in the app's own UI is attested positively
 * with `actor: "human"` and names no agent or run: the app never invents
 * agent provenance for a click, and a context that merely omits the agent is
 * refused rather than read as a human (auth-and-tenancy §1, R20). Both ride
 * on a UOA delegation for the same `sub`.
 */
export type DelegatedContext = {
  kind: 'delegated'
  sub: string
  agentId: string | null
  provenance: {
    runId: string
    toolCallId: string
    requestId: string
  } | null
  binding: ContextBinding
}

/**
 * The data subject's own act (`actor: "subject"`): no `sub`, no delegation,
 * the UOA organisation and team ids, and the one tool call with its argument
 * hash. Accepted only for tools the app's registry entry allowlists.
 */
export type SubjectContext = {
  kind: 'subject'
  org: string
  team: string
  tool: string
  argsSha256: string
  requestId: string
}

export type NessieContext = DelegatedContext | SubjectContext

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

type ContextClaims = z.infer<typeof ContextClaimsSchema>

function subjectContext(claims: ContextClaims): SubjectContext {
  if (
    claims.sub !== undefined || claims.delegation_jti !== undefined
    || claims.agentId !== undefined || claims.runId !== undefined || claims.toolCallId !== undefined
  ) throw new Error('A subject context names no person, delegation, agent or run')
  const subject = SubjectClaimsSchema.parse(claims)
  return {
    kind: 'subject',
    org: subject.org,
    team: subject.team,
    tool: subject.tool,
    argsSha256: subject.args_sha256,
    requestId: claims.requestId,
  }
}

function delegatedContext(claims: ContextClaims): DelegatedContext {
  if (claims.sub === undefined) throw new Error('A delegated context names its UOA subject')
  const binding: ContextBinding = {
    delegationJti: claims.delegation_jti ?? null,
    tool: claims.tool ?? null,
    argsSha256: claims.args_sha256 ?? null,
  }
  if (claims.actor === 'human') {
    if (claims.agentId !== undefined || claims.runId !== undefined || claims.toolCallId !== undefined) {
      throw new Error('A human context names no agent or run')
    }
    return { kind: 'delegated', sub: claims.sub, agentId: null, provenance: null, binding }
  }
  if (claims.agentId === undefined || claims.runId === undefined || claims.toolCallId === undefined) {
    throw new Error('An agent context names its agent, run and tool call')
  }
  return {
    kind: 'delegated',
    sub: claims.sub,
    agentId: claims.agentId,
    provenance: {
      runId: claims.runId,
      toolCallId: claims.toolCallId,
      requestId: claims.requestId,
    },
    binding,
  }
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
  return claims.actor === 'subject' ? subjectContext(claims) : delegatedContext(claims)
}

/** True when a delegated context commits to exactly this delegation and invocation (R21). */
export function bindsInvocation(
  binding: ContextBinding,
  expected: { delegationJti: string; tool: string; argsSha256: string },
): boolean {
  return binding.delegationJti === expected.delegationJti
    && binding.tool === expected.tool
    && binding.argsSha256 === expected.argsSha256
}
