import { z } from 'zod'

export const PrincipalSchema = z.object({
  app: z.string().describe('app key name'),
  uoaUserId: z.string(),
  uoaOrgId: z.string(),
  uoaTeamId: z.string(),
  role: z.enum(['owner', 'admin', 'member']).nullable()
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
})
export type Principal = z.infer<typeof PrincipalSchema>

export type ActorContext = {
  /** local ids, resolved 1:1 from UOA ids */
  tenant: { organizationId: string; teamId: string }
  /** immediate caller — the agent binding is agent:<app>:<agentId> (R23) */
  app: string
  /** upstream hops, into audit rows verbatim */
  actChain: Array<{ sub: string; product: string }>
  /** agent when agentId present, else human */
  actor: { type: 'human' | 'agent' | 'system'; id: string }
  /** the human + resolved role (null = no role, no gated access) */
  onBehalfOf: { uoaUserId: string; role: 'owner' | 'admin' | 'member' | null }
  provenance: Principal['provenance']
  requestId: string
  now: Date
}
