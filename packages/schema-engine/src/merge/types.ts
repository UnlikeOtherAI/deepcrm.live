import type { JsonValue } from '../records/json.js'

export type MergeUniqueKeySnapshot = {
  attributeId: string
  normalizedHash: string
  normalizedValue: string
}

export type MergeSnapshot = {
  survivorBefore: Record<string, JsonValue>
  losers: Array<{
    id: string
    data: Record<string, JsonValue>
    uniqueKeys: MergeUniqueKeySnapshot[]
  }>
  repointedLinks: Array<{ linkId: string; originalFrom: string; originalTo: string }>
  endedLinks: string[]
  movedKeys: Array<{ attributeId: string; normalizedHash: string; fromRecordId: string }>
  droppedKeys: Array<{ attributeId: string; normalizedHash: string; fromRecordId: string }>
  movedEntries: Array<{ listId: string; recordId: string }>
}

export type ExecuteMergeInput = {
  survivorId: string
  mergedIds: readonly string[]
  fieldChoices?: Readonly<Record<string, string>>
  reason: string
}

export type MergePlanAuthorization = {
  objectTypeId: string
  changedAttributeSlugs: readonly string[]
}

export type MergePlanAuthorizer = (plan: MergePlanAuthorization) => Promise<void>

export type MergeRecordResult = {
  id: string
  version: number
  data: Record<string, JsonValue>
  displayName: string
  deletedAt: Date | null
}

export type ExecuteMergeResult = {
  record: MergeRecordResult
  mergeChangeId: string
  repointedLinks: number
  endedLinks: readonly string[]
  sequences: readonly number[]
  touchedRecordIds: readonly string[]
}
