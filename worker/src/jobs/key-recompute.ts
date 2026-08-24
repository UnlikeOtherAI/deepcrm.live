import { Prisma, tenantWhere } from '@deepcrm/db'
import {
  loadSchema,
  refreshMatchingRecords,
  syncUniqueKeys,
} from '@deepcrm/schema-engine'
import { UuidSchema } from '@deepcrm/schemas'
import { z } from 'zod'

import type { JobHandler } from '../index.js'

export const KEY_RECOMPUTE_JOB = 'schema.key_recompute'
const BATCH_SIZE = 500

const KeyRecomputePayload = z.object({
  organizationId: UuidSchema,
  teamId: UuidSchema,
  objectTypeId: UuidSchema,
  attributeId: UuidSchema,
}).strict()

type EngineRecordData = Parameters<typeof syncUniqueKeys>[4]
type EngineJsonValue = EngineRecordData[string]

function jsonValue(value: Prisma.JsonValue): EngineJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(jsonValue)
  const result: EngineRecordData = {}
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) result[key] = jsonValue(child)
  }
  return result
}

function storedData(value: Prisma.JsonValue): EngineRecordData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Stored record data is invalid')
  }
  const result: EngineRecordData = {}
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) result[key] = jsonValue(child)
  }
  return result
}

export const keyRecomputeHandler: JobHandler = async (input) => {
  const payload = KeyRecomputePayload.parse(input.job.payload)
  if (payload.organizationId !== input.job.organizationId || payload.teamId !== input.job.teamId) {
    throw new Error('schema.key_recompute tenant payload mismatch')
  }
  const tenant = { organizationId: payload.organizationId, teamId: payload.teamId }
  const schema = await loadSchema(input.db, tenant)
  const objectType = schema.objectTypesById.get(payload.objectTypeId)
  const attribute = objectType?.attributes.find((item) => item.id === payload.attributeId)
  if (objectType === undefined || attribute === undefined) return
  let after = ''
  let processed = 0
  for (;;) {
    const records = await input.db.record.findMany({
      where: {
        ...tenantWhere(tenant),
        objectTypeId: payload.objectTypeId,
        id: after === '' ? undefined : { gt: after },
        deletedAt: null,
        mergedIntoId: null,
        erasedAt: null,
        data: { path: [attribute.slug], not: Prisma.JsonNull },
      },
      select: { id: true, data: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    })
    if (records.length === 0) break
    await input.db.$transaction(async (tx) => {
      for (const record of records) {
        await syncUniqueKeys(tx, schema, objectType, record.id, storedData(record.data))
      }
      await refreshMatchingRecords(tx, tenant, schema, records.map((record) => record.id))
    })
    processed += records.length
    await input.progress({ processed })
    const last = records.at(-1)
    if (last === undefined) break
    after = last.id
  }
}
