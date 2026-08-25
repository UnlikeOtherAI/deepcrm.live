import { enqueue } from '@deepcrm/queue'
import { refreshDerivedFromSources } from '@deepcrm/schema-engine'
import { z } from 'zod'

import type { JobHandler } from '../index.js'

export const DERIVED_REFRESH_JOB = 'derived.refresh'

const DerivedRefreshPayload = z.object({
  organizationId: z.string().uuid(),
  teamId: z.string().uuid(),
  sourceRecordIds: z.array(z.string().uuid()).min(1).max(500),
}).strict()

export const derivedRefreshHandler: JobHandler = async (input) => {
  const payload = DerivedRefreshPayload.parse(input.job.payload)
  if (payload.organizationId !== input.job.organizationId || payload.teamId !== input.job.teamId) {
    throw new Error('derived.refresh tenant payload mismatch')
  }
  const result = await refreshDerivedFromSources(input.db, payload, payload.sourceRecordIds, input.clock())
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
