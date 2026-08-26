import { enqueue } from '@deepcrm/queue'
import { refreshDerivedFromSources } from '@deepcrm/schema-engine'
import { z } from 'zod'

import type { JobHandler } from '../index.js'

export const DERIVED_REFRESH_JOB = 'derived.refresh'

const DerivedRefreshPayload = z.object({
  organizationId: z.string().uuid(),
  teamId: z.string().uuid(),
  sourceRecordIds: z.array(z.string().uuid()).min(1).max(500),
  actorContext: z.object({
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
  }),
}).strict()

export const derivedRefreshHandler: JobHandler = async (input) => {
  const payload = DerivedRefreshPayload.parse(input.job.payload)
  if (payload.organizationId !== input.job.organizationId || payload.teamId !== input.job.teamId) {
    throw new Error('derived.refresh tenant payload mismatch')
  }
  const now = input.clock()
  const result = await refreshDerivedFromSources(input.db, payload, {
    tenant: { organizationId: payload.organizationId, teamId: payload.teamId },
    app: payload.actorContext.app,
    actChain: payload.actorContext.actChain,
    actor: payload.actorContext.actor,
    onBehalfOf: payload.actorContext.onBehalfOf,
    provenance: payload.actorContext.provenance,
    requestId: payload.actorContext.requestId,
    now,
  }, payload.sourceRecordIds, now)
  for (const recordId of result.changedRecords) {
    await enqueue(input.db, {
      organizationId: payload.organizationId,
      teamId: payload.teamId,
      type: 'record.reindex',
      payload: { organizationId: payload.organizationId, teamId: payload.teamId, recordId },
      idempotencyKey: `reindex:${recordId}:derived:${input.job.id}`,
      priority: 100,
    })
  }
}
