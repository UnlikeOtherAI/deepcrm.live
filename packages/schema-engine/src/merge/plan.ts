import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import { getAttributeType } from '../attribute-types/index.js'
import { canonicalJson, canonicalJsonValue, type JsonValue } from '../records/json.js'
import { keyHash } from '../records/unique-keys.js'
import type { LoadedAttribute } from '../schema/load.js'

export type MergeAttribute = Pick<
  LoadedAttribute,
  'id' | 'slug' | 'type' | 'config' | 'isMulti' | 'isUnique' | 'archivedAt'
>
export type MergeSchema = {
  attributesByObjectTypeId: ReadonlyMap<string, ReadonlyMap<string, MergeAttribute>>
}
export type MergeObjectType = {
  id: string
  attributes: readonly MergeAttribute[]
}
export type MergeRecord = {
  id: string
  data: Readonly<Record<string, JsonValue>>
}
export type MergeLastSetAt = ReadonlyMap<string, ReadonlyMap<string, Date>>
export type UniqueKeyMove = {
  attributeId: string
  attributeSlug: string
  normalizedHash: string
  normalizedValue: string
  fromRecordId: string
}
export type MergePlan = {
  data: Record<string, JsonValue>
  uniqueKeyMoves: UniqueKeyMove[]
  fieldSources: Record<string, string[]>
}

function validation(detail: string, path = ''): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Merge plan is invalid', {
    issues: [{ path, message: detail }],
  })
}

function schemaConflict(detail: string): never {
  throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema metadata is inconsistent', { detail })
}

function canonicalData(value: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  const canonical = canonicalJsonValue(value)
  if (canonical === null || Array.isArray(canonical) || typeof canonical !== 'object') {
    return schemaConflict('invalid_merge_record_data')
  }
  return canonical
}

function normalized(attribute: MergeAttribute, value: JsonValue): string {
  return getAttributeType(attribute.type).normalize(value, attribute.config) ?? canonicalJson(value)
}

function orderedUnion(
  attribute: MergeAttribute,
  records: readonly MergeRecord[],
): { values: JsonValue[]; sources: string[] } {
  const seen = new Set<string>()
  const values: JsonValue[] = []
  const sources: string[] = []
  for (const record of records) {
    const stored = record.data[attribute.slug]
    if (stored === undefined) continue
    if (!Array.isArray(stored)) return schemaConflict('invalid_multi_merge_value')
    let contributed = false
    for (const value of stored) {
      const key = normalized(attribute, value)
      if (seen.has(key)) continue
      seen.add(key)
      values.push(value)
      contributed = true
    }
    if (contributed) sources.push(record.id)
  }
  return { values, sources }
}

function newest(
  records: readonly MergeRecord[],
  slug: string,
  lastSetAt: MergeLastSetAt,
): MergeRecord | undefined {
  let selected: MergeRecord | undefined
  let selectedAt = Number.NEGATIVE_INFINITY
  for (const record of records) {
    const value = record.data[slug]
    if (value === undefined || value === null) continue
    const timestamp = lastSetAt.get(record.id)?.get(slug)?.getTime() ?? Number.NEGATIVE_INFINITY
    if (selected === undefined || timestamp > selectedAt) {
      selected = record
      selectedAt = timestamp
    }
  }
  return selected
}

function selectedValue(
  attribute: MergeAttribute,
  survivor: MergeRecord,
  losers: readonly MergeRecord[],
  choice: string | undefined,
  recordsById: ReadonlyMap<string, MergeRecord>,
  lastSetAt: MergeLastSetAt,
): { value: JsonValue | undefined; sources: string[] } {
  if (choice !== undefined) {
    const selected = recordsById.get(choice)
    if (selected === undefined) return validation('Chosen record is outside the merge set', `/field_choices/${attribute.slug}`)
    const value = selected.data[attribute.slug]
    if (attribute.isMulti && value !== undefined && !Array.isArray(value)) {
      return schemaConflict('invalid_multi_merge_value')
    }
    return { value, sources: value === undefined ? [] : [selected.id] }
  }
  if (attribute.isMulti) {
    const union = orderedUnion(attribute, [survivor, ...losers])
    return { value: union.values.length === 0 ? undefined : union.values, sources: union.sources }
  }
  const survivorValue = survivor.data[attribute.slug]
  if (survivorValue !== undefined && survivorValue !== null) {
    return { value: survivorValue, sources: [survivor.id] }
  }
  const selected = newest(losers, attribute.slug, lastSetAt)
  const value = selected?.data[attribute.slug]
  return { value, sources: selected === undefined || value === undefined ? [] : [selected.id] }
}

function uniqueValues(attribute: MergeAttribute, record: MergeRecord): Array<{
  normalizedHash: string
  normalizedValue: string
}> {
  const stored = record.data[attribute.slug]
  if (stored === undefined) return []
  const values = attribute.isMulti ? stored : [stored]
  if (!Array.isArray(values)) return schemaConflict('invalid_multi_merge_value')
  return values.map((value) => {
    const normalizedValue = normalized(attribute, value)
    return { normalizedHash: keyHash(normalizedValue), normalizedValue }
  })
}

function plannedUniqueKeyMoves(
  attributes: readonly MergeAttribute[],
  data: Readonly<Record<string, JsonValue>>,
  losers: readonly MergeRecord[],
): UniqueKeyMove[] {
  const moves: UniqueKeyMove[] = []
  for (const attribute of attributes) {
    if (!attribute.isUnique || attribute.type === 'record_reference') continue
    const planned = new Set(uniqueValues(attribute, { id: '', data }).map((key) => key.normalizedHash))
    for (const loser of losers) {
      for (const key of uniqueValues(attribute, loser)) {
        if (!planned.has(key.normalizedHash)) continue
        moves.push({
          attributeId: attribute.id,
          attributeSlug: attribute.slug,
          normalizedHash: key.normalizedHash,
          normalizedValue: key.normalizedValue,
          fromRecordId: loser.id,
        })
      }
    }
  }
  return moves.sort((left, right) => (
    `${left.attributeId}:${left.normalizedHash}:${left.fromRecordId}`
      .localeCompare(`${right.attributeId}:${right.normalizedHash}:${right.fromRecordId}`)
  ))
}

export function planMerge(
  schema: MergeSchema,
  objectType: MergeObjectType,
  survivor: MergeRecord,
  losers: readonly MergeRecord[],
  lastSetAt: MergeLastSetAt,
  fieldChoices: Readonly<Record<string, string>> = {},
): MergePlan {
  const ids = [survivor.id, ...losers.map((record) => record.id)]
  if (losers.length === 0 || new Set(ids).size !== ids.length) {
    validation('Merge records must be distinct and include at least one loser')
  }
  const attributes = schema.attributesByObjectTypeId.get(objectType.id)
  if (attributes === undefined) return schemaConflict('merge_object_type_not_loaded')
  const active = objectType.attributes.filter((attribute) => attribute.archivedAt === null)
  const activeBySlug = new Map(active.map((attribute) => [attribute.slug, attribute]))
  const recordsById = new Map([survivor, ...losers].map((record) => [record.id, record]))
  for (const [slug, recordId] of Object.entries(fieldChoices)) {
    const attribute = activeBySlug.get(slug)
    if (attribute === undefined || attribute.type === 'record_reference') {
      validation('Field choice attribute is not mergeable', `/field_choices/${slug}`)
    }
    if (!recordsById.has(recordId)) {
      validation('Chosen record is outside the merge set', `/field_choices/${slug}`)
    }
  }
  const data = canonicalData(survivor.data)
  const fieldSources: Record<string, string[]> = {}
  for (const attribute of active) {
    if (attribute.type === 'record_reference') continue
    const selected = selectedValue(
      attribute, survivor, losers, fieldChoices[attribute.slug], recordsById, lastSetAt,
    )
    if (selected.value === undefined || selected.value === null) delete data[attribute.slug]
    else data[attribute.slug] = canonicalJsonValue(selected.value)
    fieldSources[attribute.slug] = selected.sources
  }
  return {
    data,
    uniqueKeyMoves: plannedUniqueKeyMoves(active, data, losers),
    fieldSources,
  }
}
