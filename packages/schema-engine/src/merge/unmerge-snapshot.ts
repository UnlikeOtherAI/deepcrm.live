import { ErrorCode, ServiceError } from '@deepcrm/schemas'
import { z } from 'zod'

import { canonicalJsonValue, type JsonValue } from '../records/json.js'
import type { MergeSnapshot } from './types.js'

const uuid = z.string().uuid()
const uniqueKey = z.object({
  attributeId: uuid,
  normalizedHash: z.string().min(1),
  normalizedValue: z.string(),
}).strict()

const snapshotSchema = z.object({
  survivorBefore: z.record(z.string(), z.unknown()),
  losers: z.array(z.object({
    id: uuid,
    data: z.record(z.string(), z.unknown()),
    uniqueKeys: z.array(uniqueKey),
  }).strict()).min(1).max(10),
  repointedLinks: z.array(z.object({
    linkId: uuid,
    originalFrom: uuid,
    originalTo: uuid,
  }).strict()),
  endedLinks: z.array(uuid),
  movedKeys: z.array(z.object({
    attributeId: uuid,
    normalizedHash: z.string().min(1),
    fromRecordId: uuid,
  }).strict()),
  droppedKeys: z.array(z.object({
    attributeId: uuid,
    normalizedHash: z.string().min(1),
    fromRecordId: uuid,
  }).strict()),
  movedEntries: z.array(z.object({ listId: uuid, recordId: uuid }).strict()),
}).strict()

function data(value: Record<string, unknown>): Record<string, JsonValue> {
  let parsed: JsonValue
  try {
    parsed = canonicalJsonValue(value)
  } catch {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Merge snapshot data is invalid')
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Merge snapshot data is invalid')
  }
  return parsed
}

function invalid(detail: string): never {
  throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Merge snapshot is invalid', { detail })
}

function validateProvenance(snapshot: MergeSnapshot): void {
  const loserIds = snapshot.losers.map((loser) => loser.id)
  if (new Set(loserIds).size !== loserIds.length) invalid('duplicate_loser')
  const expectedKeys = snapshot.losers.flatMap((loser) => loser.uniqueKeys.map((key) => (
    `${loser.id}:${key.attributeId}:${key.normalizedHash}`
  )))
  const partition = [...snapshot.movedKeys, ...snapshot.droppedKeys].map((key) => (
    `${key.fromRecordId}:${key.attributeId}:${key.normalizedHash}`
  ))
  if (new Set(partition).size !== partition.length
    || [...expectedKeys].sort().join('\n') !== [...partition].sort().join('\n')) {
    invalid('unique_key_partition')
  }
  const loserSet = new Set(loserIds)
  if (snapshot.movedEntries.some((entry) => !loserSet.has(entry.recordId))) {
    invalid('list_entry_record')
  }
  const repointed = snapshot.repointedLinks.map((link) => link.linkId)
  if (new Set(repointed).size !== repointed.length
    || new Set(snapshot.endedLinks).size !== snapshot.endedLinks.length
    || snapshot.endedLinks.some((id) => repointed.includes(id))) {
    invalid('link_partition')
  }
}

export function parseMergeSnapshot(value: unknown): MergeSnapshot {
  const parsed = snapshotSchema.safeParse(value)
  if (!parsed.success) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Merge snapshot is invalid', {
      detail: parsed.error.issues[0]?.message ?? 'invalid_snapshot',
    })
  }
  const snapshot: MergeSnapshot = {
    survivorBefore: data(parsed.data.survivorBefore),
    losers: parsed.data.losers.map((loser) => ({ ...loser, data: data(loser.data) })),
    repointedLinks: parsed.data.repointedLinks,
    endedLinks: parsed.data.endedLinks,
    movedKeys: parsed.data.movedKeys,
    droppedKeys: parsed.data.droppedKeys,
    movedEntries: parsed.data.movedEntries,
  }
  validateProvenance(snapshot)
  return snapshot
}
