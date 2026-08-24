import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'

const MAX_TOKEN_TTL_SECONDS = 300
const MAX_ACT_CHAIN_DEPTH = 16
const remoteJwksByUrl = new Map<string, JWTVerifyGetKey>()

export type ActorClaim = {
  sub: string
  product: string
  act?: ActorClaim
}

const ActorClaimSchema: z.ZodType<ActorClaim> = z.lazy(() => z.object({
  sub: z.string().min(1),
  product: z.string().min(1),
  act: ActorClaimSchema.optional(),
}).strict())

const OrgClaimSchema = z.object({
  org_id: z.string().min(1),
  org_role: z.string().min(1).optional(),
  team_roles: z.record(z.string(), z.string().min(1)),
}).passthrough()

const ActiveClaimSchema = z.object({
  orgId: z.string().min(1),
  teamId: z.string().min(1),
}).strict()

const DelegationClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  sub: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(1),
  org: OrgClaimSchema,
  active: ActiveClaimSchema,
  source_domain: z.string().min(1),
  azp: z.string().min(1),
  product: z.string().min(1),
  tv: z.number().int().nonnegative().optional(),
  act: ActorClaimSchema.optional(),
  scope: z.string().min(1),
}).passthrough()

export type UoaDelegation = z.infer<typeof DelegationClaimsSchema>

export type UoaDelegationOptions = {
  jwks?: JWTVerifyGetKey
  jwksUrl?: string | URL
  issuer: string
  audience: string
  now: Date
}

function resolveJwks(options: UoaDelegationOptions): JWTVerifyGetKey {
  if (options.jwks !== undefined) return options.jwks
  if (options.jwksUrl === undefined) throw new Error('A UOA JWKS resolver or URL is required')
  const url = new URL(options.jwksUrl).href
  const existing = remoteJwksByUrl.get(url)
  if (existing !== undefined) return existing
  const created = createRemoteJWKSet(new URL(url))
  remoteJwksByUrl.set(url, created)
  return created
}

function enforceLifetime(iat: number, exp: number): void {
  if (exp <= iat || exp - iat > MAX_TOKEN_TTL_SECONDS) throw new Error('Delegation lifetime exceeds 300 seconds')
}

export async function verifyUoaDelegation(
  token: string,
  options: UoaDelegationOptions,
): Promise<UoaDelegation> {
  const verified = await jwtVerify(token, resolveJwks(options), {
    algorithms: ['RS256'],
    issuer: options.issuer,
    audience: options.audience,
    currentDate: options.now,
  })
  const claims = DelegationClaimsSchema.parse(verified.payload)
  enforceLifetime(claims.iat, claims.exp)
  if (claims.iat > Math.floor(options.now.getTime() / 1000)) throw new Error('Delegation issued in the future')
  if (claims.active.orgId !== claims.org.org_id) throw new Error('Active organisation does not match delegation')
  if (!claims.scope.split(/\s+/u).includes('ai.invoke')) throw new Error('Delegation lacks ai.invoke scope')
  return claims
}

export function resolveRole(
  org: UoaDelegation['org'],
  active: UoaDelegation['active'],
): 'owner' | 'admin' | 'member' | null {
  if (org.org_role === 'owner') return 'owner'
  const role = org.team_roles[active.teamId] ?? org.org_role
  if (role === 'admin' || role === 'member') return role
  return null
}

export function flattenActChain(act: ActorClaim | undefined): Array<{ sub: string; product: string }> {
  const chain: Array<{ sub: string; product: string }> = []
  let current = act
  while (current !== undefined && chain.length < MAX_ACT_CHAIN_DEPTH) {
    chain.push({ sub: current.sub, product: current.product })
    current = current.act
  }
  if (current !== undefined) throw new Error('Delegation actor chain is too deep')
  return chain
}
