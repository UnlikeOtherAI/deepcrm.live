import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import type { ChangeIntent } from './changes.js'
import { canonicalJsonValue, type JsonValue } from './json.js'
import type { RecordTx } from '../schema/tx.js'

export type RecordMetadataInput = {
  owner?: { type: 'human' | 'agent'; id: string } | null
  visibility?: 'team' | 'users' | 'private'
  visibleTo?: readonly string[]
  origin?: string
}

type CurrentRecord = {
  id: string; version: number; ownerType: 'human' | 'agent' | 'system' | null; ownerId: string | null
  visibility: 'team' | 'users' | 'private'; origin: string | null
}

export type MetadataPlan = {
  changed: boolean
  data: { ownerType?: 'human' | 'agent' | null; ownerId?: string | null; visibility?: 'team' | 'users' | 'private'; origin?: string }
  visibleTo?: readonly string[]
  changes: readonly ChangeIntent[]
}

export function requestedVisibility(input: RecordMetadataInput): 'team' | 'users' | 'private' | undefined {
  if (input.visibleTo !== undefined) return 'users'
  return input.visibility
}

export async function replaceVisibilityGrants(
  tx: RecordTx, recordId: string, visibleTo: readonly string[] | undefined,
): Promise<void> {
  if (visibleTo === undefined) return
  await tx.recordVisibilityGrant.deleteMany({ where: { recordId } })
  await tx.recordVisibilityGrant.createMany({
    data: [...new Set(visibleTo)].map((uoaUserId) => ({ recordId, uoaUserId })),
  })
}

function value(system: string, state: JsonValue): JsonValue {
  return canonicalJsonValue({ system, value: state })
}

function intent(
  record: CurrentRecord, system: string, oldValue: JsonValue, newValue: JsonValue, groupId: string,
): ChangeIntent {
  return {
    recordId: record.id, kind: 'set', attributeSlug: null, relationTypeId: null, linkId: null, groupId,
    oldValue: value(system, oldValue), newValue: value(system, newValue), snapshot: null,
    resultingVersion: record.version + 1, reason: null,
  }
}

export async function planRecordMetadata(
  tx: RecordTx, record: CurrentRecord, input: RecordMetadataInput,
): Promise<MetadataPlan> {
  const changes: ChangeIntent[] = []
  const data: MetadataPlan['data'] = {}
  const groupId = crypto.randomUUID()
  if (input.owner !== undefined) {
    const oldValue = record.ownerType === null || record.ownerId === null
      ? null
      : { type: record.ownerType, id: record.ownerId }
    const newValue = input.owner
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      data.ownerType = newValue?.type ?? null; data.ownerId = newValue?.id ?? null
      changes.push(intent(record, 'owner', oldValue, newValue, groupId))
    }
  }
  const nextVisibility = input.visibleTo === undefined ? input.visibility : 'users'
  if (nextVisibility !== undefined && nextVisibility !== record.visibility) {
    data.visibility = nextVisibility
    changes.push(intent(record, 'visibility', record.visibility, nextVisibility, groupId))
  }
  if (input.origin !== undefined && input.origin !== record.origin) {
    if (record.origin !== null) throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Origin is set once')
    data.origin = input.origin
    changes.push(intent(record, 'origin', record.origin, input.origin, groupId))
  }
  let visibleTo: readonly string[] | undefined
  if (input.visibleTo !== undefined || input.visibility === 'team' || input.visibility === 'private') {
    const before = await tx.recordVisibilityGrant.findMany({ where: { recordId: record.id }, select: { uoaUserId: true }, orderBy: { uoaUserId: 'asc' } })
    const next = input.visibleTo === undefined ? [] : [...new Set(input.visibleTo)].sort()
    const old = before.map((item) => item.uoaUserId)
    if (JSON.stringify(old) !== JSON.stringify(next)) {
      visibleTo = next
      changes.push(intent(record, 'visible_to', old, next, groupId))
    }
  }
  return { changed: changes.length > 0, data, ...(visibleTo === undefined ? {} : { visibleTo }), changes }
}
