import { z } from 'zod'
import { ErrorCode, ServiceError } from './errors.js'

const Role = z.enum(['owner', 'admin', 'member'])
export type Role = z.infer<typeof Role>

/** A caller acting for a person: a UOA delegation names the human and the workspace. */
export const DelegatedPrincipalSchema = z.object({
  kind: z.literal('delegated'),
  app: z.string().describe('app key name'),
  uoaUserId: z.string(),
  uoaOrgId: z.string(),
  uoaTeamId: z.string(),
  role: Role.nullable()
    .describe('resolved per uoa-integration §3.2; unknown role ⇒ null, never member'),
  sourceDomain: z.string().describe('delegation source_domain (immediate caller)'),
  product: z.string().describe("delegation product ('direct' for public-profile clients)"),
  actChain: z.array(z.object({ sub: z.string(), product: z.string() })).describe('upstream hops, verbatim'),
  agentId: z.string().nullable().describe('null for direct human clients'),
  tokenVersion: z.number().int().nonnegative().nullable(),
  provenance: z.object({
    runId: z.string(),
    toolCallId: z.string(),
    requestId: z.string(),
  }).nullable(),
}).strict()
export type DelegatedPrincipal = z.infer<typeof DelegatedPrincipalSchema>

/**
 * The data subject's own act, attested by the calling app with no person
 * signed in (auth-and-tenancy §1): no human, no role, one named tool call.
 */
export const SubjectPrincipalSchema = z.object({
  kind: z.literal('subject'),
  app: z.string().describe('app key name; the app registry allowlists the tools it may attest'),
  uoaOrgId: z.string().describe('UOA organisation id the app attests'),
  uoaTeamId: z.string().describe('UOA team id the app attests'),
  sourceDomain: z.string().describe('the app registration sourceDomain'),
  product: z.string().describe('the app registration product'),
  tool: z.string().min(1).describe('the one tool this request may run'),
  argsSha256: z.string().regex(/^[a-f0-9]{64}$/).describe('canonical-JSON hash of the attested arguments'),
  requestId: z.string().min(1).describe('the attested request id; the replay seen-set key'),
}).strict()
export type SubjectPrincipal = z.infer<typeof SubjectPrincipalSchema>

export const PrincipalSchema = z.discriminatedUnion('kind', [DelegatedPrincipalSchema, SubjectPrincipalSchema])
export type Principal = z.infer<typeof PrincipalSchema>

/** The human a call acts for, with their resolved role (null = no role, no gated access). */
export type OnBehalfOf = { uoaUserId: string; role: Role | null }

export type ActorContext = {
  /** local ids, resolved 1:1 from UOA ids */
  tenant: { organizationId: string; teamId: string }
  /** immediate caller — the agent binding is agent:<app>:<agentId> (R23) */
  app: string
  /** upstream hops, into audit rows verbatim */
  actChain: Array<{ sub: string; product: string }>
  /** agent when agentId present; human for a person; system `subject:<app>` for a subject-attested call */
  actor: { type: 'human' | 'agent' | 'system'; id: string }
  /** the human + resolved role; null only for a subject-attested call, where no person acts */
  onBehalfOf: OnBehalfOf | null
  provenance: DelegatedPrincipal['provenance']
  requestId: string
  now: Date
}

/** The actor id of a subject-attested call made through `app`. */
export function subjectActorId(app: string): string {
  return `subject:${app}`
}

/** True for the context of a subject-attested call: no person, the app's subject actor. */
export function isSubjectActor(ctx: Pick<ActorContext, 'actor' | 'app' | 'onBehalfOf'>): boolean {
  return ctx.onBehalfOf === null && ctx.actor.type === 'system' && ctx.actor.id === subjectActorId(ctx.app)
}

/** The UOA user a call acts for, for attribution columns that allow no person. */
export function onBehalfOfUserId(ctx: Pick<ActorContext, 'onBehalfOf'>): string | null {
  return ctx.onBehalfOf === null ? null : ctx.onBehalfOf.uoaUserId
}

/** The person a call acts for; an operation that needs one refuses a call made for nobody. */
export function requireOnBehalfOf(ctx: Pick<ActorContext, 'onBehalfOf'>): OnBehalfOf {
  if (ctx.onBehalfOf === null) {
    throw new ServiceError(ErrorCode.POLICY_DENIED, 'This operation acts for a person')
  }
  return ctx.onBehalfOf
}
