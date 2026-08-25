import { z } from 'zod'

import { refreshDynamicListMembership } from '@deepcrm/schema-engine'
import type { JobHandler } from '../index.js'

export const LIST_REFRESH_JOB = 'list.refresh'

const ActorContextPayload = z.object({
  app: z.string().min(1),
  actChain: z.array(z.object({ sub: z.string(), product: z.string() })),
  actor: z.object({ type: z.enum(['human', 'agent', 'system']), id: z.string().min(1) }),
  onBehalfOf: z.object({
    uoaUserId: z.string().min(1),
    role: z.enum(['owner', 'admin', 'member']).nullable(),
  }),
  provenance: z.object({
    runId: z.string(),
    toolCallId: z.string(),
    requestId: z.string(),
  }).nullable(),
  requestId: z.string().min(1),
})

const Payload = z.object({
  organizationId: z.string().uuid(),
  teamId: z.string().uuid(),
  listId: z.string().uuid(),
  evaluationVersion: z.number().int().nonnegative(),
  actorContext: ActorContextPayload,
}).strict()

export const listRefreshHandler: JobHandler = async ({ db, job, clock, writeAudit }) => {
  const payload = Payload.parse(job.payload)
  if (payload.organizationId !== job.organizationId || payload.teamId !== job.teamId) {
    throw new Error('tenant_mismatch')
  }
  const now = clock()
  const result = await refreshDynamicListMembership(
    db,
    { organizationId: payload.organizationId, teamId: payload.teamId },
    {
      tenant: { organizationId: payload.organizationId, teamId: payload.teamId },
      app: payload.actorContext.app,
      actChain: payload.actorContext.actChain,
      actor: payload.actorContext.actor,
      onBehalfOf: payload.actorContext.onBehalfOf,
      provenance: payload.actorContext.provenance,
      requestId: payload.actorContext.requestId,
      now,
    },
    payload.listId,
    payload.evaluationVersion,
    now,
    writeAudit,
  )
  await db.queueJob.updateMany({
    where: { id: job.id, organizationId: job.organizationId, teamId: job.teamId },
    data: { result: { listId: result.listId, evaluationVersion: result.evaluationVersion, members: result.members } },
  })
}
