import {
  BulkAssertPayload,
  BulkAssertResult,
  ErrorCode,
  isServiceError,
  type ActorContext,
} from '@deepcrm/schemas'

import type { JobHandler, JobHandlerInput } from '../index.js'
import type { BulkAssertRecordPort } from '../bulk-assert-port.js'

export const BULK_ASSERT_JOB = 'records.bulk_assert'
const BATCH_SIZE = 100

function context(input: JobHandlerInput, payload: ReturnType<typeof BulkAssertPayload.parse>): ActorContext {
  return { ...payload.actorContext, now: input.clock() }
}

function assertJobScope(
  input: JobHandlerInput,
  payload: ReturnType<typeof BulkAssertPayload.parse>,
): void {
  if (
    input.job.type !== BULK_ASSERT_JOB
    || input.job.organizationId !== payload.organizationId
    || input.job.teamId !== payload.teamId
    || payload.actorContext.tenant.organizationId !== payload.organizationId
    || payload.actorContext.tenant.teamId !== payload.teamId
  ) {
    throw new Error('Bulk assert payload tenant does not match the claimed job')
  }
}

async function stillRunning(input: JobHandlerInput): Promise<boolean> {
  const job = await input.db.queueJob.findFirst({
    where: {
      id: input.job.id,
      organizationId: input.job.organizationId,
      teamId: input.job.teamId,
      type: BULK_ASSERT_JOB,
    },
    select: { status: true },
  })
  return job?.status === 'running'
}

function failedRow(index: number, error: unknown) {
  if (!isServiceError(error)) throw error
  if (error.code === ErrorCode.INTERNAL || error.code === ErrorCode.IDEMPOTENCY_IN_PROGRESS) {
    throw error
  }
  return { index, code: error.code, message: error.message }
}

export function createBulkAssertHandler(recordAssert: BulkAssertRecordPort): JobHandler {
  return async (input) => {
    const payload = BulkAssertPayload.parse(input.job.payload)
    assertJobScope(input, payload)
    const ctx = context(input, payload)
    let created = 0
    let updated = 0
    const failed: Array<ReturnType<typeof failedRow>> = []

    for (let offset = 0; offset < payload.rows.length; offset += BATCH_SIZE) {
      if (!await stillRunning(input)) return
      const batch = payload.rows.slice(offset, offset + BATCH_SIZE)
      for (let relative = 0; relative < batch.length; relative += 1) {
        const row = batch[relative]
        if (row === undefined) throw new Error('Bulk assert batch row is missing')
        const index = offset + relative
        try {
          const result = await recordAssert(ctx, {
            objectType: payload.objectType,
            matchAttribute: payload.matchAttribute,
            data: row.data,
            ...(row.links === undefined ? {} : { links: row.links.map((link) => ({
              relationType: link.relation_type,
              toRecordId: link.to_record_id,
              ...(link.data === undefined ? {} : { data: link.data }),
              ...(link.label === undefined ? {} : { label: link.label }),
            })) }),
            ...(payload.reason === undefined ? {} : { reason: payload.reason }),
            idempotencyKey: row.idempotencyKey,
          })
          if (result.created) created += 1
          else updated += 1
        } catch (error) {
          failed.push(failedRow(index, error))
        }
      }
      if (!await input.progress({
        done: Math.min(offset + BATCH_SIZE, payload.rows.length),
        total: payload.rows.length,
      })) return
    }

    return input.db.$transaction(async (tx) => {
      const completed = await input.terminalize(tx, BulkAssertResult.parse({
        created,
        updated,
        failed,
      }))
      return completed ? { terminalized: true } : undefined
    })
  }
}
