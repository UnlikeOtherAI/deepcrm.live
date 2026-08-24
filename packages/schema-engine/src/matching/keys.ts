import { createHash } from 'node:crypto'

import { tenantWhere } from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import { getAttributeType } from '../attribute-types/index.js'
import { canonicalJson, canonicalJsonValue, type JsonValue } from '../records/json.js'
import { lockLinkTopology, lockKeys, lockRecords } from '../records/locks.js'
import { projectLinksIntoData } from '../links/projection.js'
import type { LoadedAttribute, LoadedMatchingRule, LoadedObjectType, LoadedSchema } from '../schema/load.js'
import type { RecordTx } from '../schema/tx.js'
import type { MatchTuple } from './types.js'

const MAX_TUPLES = 256
const exactEligible = new Set([
  'text', 'number', 'boolean', 'date', 'datetime', 'select', 'status', 'email', 'phone', 'url',
  'domain', 'registry_id', 'personal_name', 'actor_reference', 'record_reference',
])

type Data = Record<string, JsonValue>

export type FinalMatchingRecord = Readonly<{
  id: string
  objectType: LoadedObjectType
  data: Data
  displayName: string
}>

function conflict(detail: string): ServiceError {
  return new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Matching rule is invalid', { detail })
}

export function matchingTupleHash(tuple: MatchTuple): string {
  return createHash('sha256').update(canonicalJson(tuple), 'utf8').digest('hex')
}

function scalarValues(attribute: LoadedAttribute, value: JsonValue, method: LoadedMatchingRule['method']): JsonValue[] {
  const values = attribute.isMulti ? value : [value]
  if (!Array.isArray(values)) throw conflict('stored_multi_attribute_is_not_array')
  const normalized = values.map((item) => {
    if (method === 'exact') return canonicalJsonValue(item)
    const result = getAttributeType(attribute.type).normalize(item, attribute.config)
    if (result === null) throw conflict('missing_matching_normalizer')
    return result
  })
  const unique = new Map(normalized.map((item) => [canonicalJson(item), item]))
  return [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, item]) => item)
}

export function validateMatchingRule(
  objectType: Pick<LoadedObjectType, 'primaryAttributeId'>,
  attributes: readonly LoadedAttribute[],
  rule: { attributes: readonly string[]; method: 'exact' | 'normalized' | 'fuzzy'; threshold?: number; action: 'block' | 'warn' },
): void {
  if (rule.attributes.length < 1 || rule.attributes.length > 4) throw conflict('invalid_matching_rule_attribute_count')
  if (new Set(rule.attributes).size !== rule.attributes.length) throw conflict('duplicate_matching_rule_attribute')
  if (attributes.length !== rule.attributes.length) throw conflict('unknown_matching_rule_attribute')
  if (rule.method === 'fuzzy') {
    const primary = objectType.primaryAttributeId
    if (rule.action !== 'warn' || rule.threshold === undefined || rule.threshold < 0.5 || rule.threshold > 1) {
      throw conflict('invalid_fuzzy_matching_rule')
    }
    const attribute = attributes[0]
    if (attributes.length !== 1 || attribute === undefined || attribute.id !== primary || !['text', 'personal_name', 'domain'].includes(attribute.type)) {
      throw conflict('invalid_fuzzy_matching_attribute')
    }
    return
  }
  for (const attribute of attributes) {
    if (!exactEligible.has(attribute.type)) throw conflict('matching_type_not_eligible')
    const definition = getAttributeType(attribute.type)
    if (rule.method === 'normalized' && definition.normalize === undefined) throw conflict('missing_matching_normalizer')
    if (rule.action === 'block' && !definition.supportsUnique) throw conflict('blocking_matching_rule_requires_unique_capability')
  }
}

export function matchingTuples(
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  rule: LoadedMatchingRule,
  data: Data,
): readonly MatchTuple[] {
  if (rule.method === 'fuzzy') return []
  const members = rule.attributeSlugs.map((slug) => {
    const attribute = schema.attributesByObjectTypeId.get(objectType.id)?.get(slug)
    const value = data[slug]
    if (attribute === undefined) throw conflict('unknown_matching_rule_attribute')
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return []
    return scalarValues(attribute, value, rule.method)
  })
  if (members.some((values) => values.length === 0)) return []
  let tuples: JsonValue[][] = [[]]
  for (const values of members) {
    tuples = tuples.flatMap((prefix) => values.map((value) => [...prefix, value]))
    if (tuples.length > MAX_TUPLES) {
      throw new ServiceError(ErrorCode.LIMIT_EXCEEDED, 'Matching key expansion exceeds the limit', { limit: MAX_TUPLES })
    }
  }
  const unique = new Map(tuples.map((tuple) => [canonicalJson(tuple), tuple]))
  return [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, tuple]) => tuple)
}

function activeAndReplacement(schema: LoadedSchema, objectTypeId: string): readonly LoadedMatchingRule[] {
  return [
    ...(schema.matchingRulesByObjectTypeId.get(objectTypeId) ?? []),
    ...(schema.replacementMatchingRulesByObjectTypeId.get(objectTypeId) ?? []),
  ]
}

export async function removeMatchingKeys(
  tx: RecordTx,
  tenant: { organizationId: string; teamId: string },
  recordIds: readonly string[],
): Promise<void> {
  if (recordIds.length === 0) return
  const where = { ...tenantWhere(tenant), recordId: { in: [...new Set(recordIds)].sort() } }
  await tx.recordMatchKey.deleteMany({ where })
  await tx.recordMatchLookupKey.deleteMany({ where })
}

export async function materializeMatchingKeys(
  tx: RecordTx,
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  recordId: string,
  data: Data,
): Promise<void> {
  await removeMatchingKeys(tx, { organizationId: objectType.organizationId, teamId: schema.teamId }, [recordId])
  const rules = activeAndReplacement(schema, objectType.id).filter((rule) => rule.method !== 'fuzzy')
  const entries = rules.flatMap((rule) => matchingTuples(schema, objectType, rule, data).map((tuple) => ({
    rule, normalizedHash: matchingTupleHash(tuple),
  })))
  await lockKeys(tx, schema.teamId, entries.map((entry) => `match:${entry.rule.id}:${entry.normalizedHash}`))
  for (const entry of entries) {
    await tx.recordMatchLookupKey.create({
      data: {
        organizationId: objectType.organizationId, teamId: schema.teamId, matchingRuleId: entry.rule.id,
        normalizedHash: entry.normalizedHash, recordId,
      },
    })
    if (entry.rule.action !== 'block' || entry.rule.generation.state !== 'active') continue
    const winner = await tx.recordMatchKey.findFirst({
      where: {
        ...tenantWhere({ organizationId: objectType.organizationId, teamId: schema.teamId }),
        matchingRuleId: entry.rule.id, normalizedHash: entry.normalizedHash,
      },
      select: { recordId: true },
    })
    if (winner !== null) {
      throw new ServiceError(ErrorCode.DUPLICATE_FOUND, 'A matching record already exists', {
        attribute: entry.rule.attributeSlugs[0] ?? null, record_id: winner.recordId,
      })
    }
    await tx.recordMatchKey.create({
      data: {
        organizationId: objectType.organizationId, teamId: schema.teamId, matchingRuleId: entry.rule.id,
        normalizedHash: entry.normalizedHash, recordId,
      },
    })
  }
}

export async function materializeMatchingRecordBatch(
  tx: RecordTx,
  tenant: { organizationId: string; teamId: string },
  schema: LoadedSchema,
  generationId: string,
  recordIds: readonly string[],
): Promise<{ processed: number }> {
  const ids = [...new Set(recordIds)].sort()
  if (ids.length === 0) return { processed: 0 }
  const generationExists = [...schema.matchingRules, ...schema.replacementMatchingRules]
    .some((rule) => rule.generationId === generationId)
  if (!generationExists) throw conflict('matching_generation_not_loaded')
  return refreshMatchingRecords(tx, tenant, schema, ids)
}

export async function finalMatchingRecords(
  tx: RecordTx,
  tenant: { organizationId: string; teamId: string },
  schema: LoadedSchema,
  recordIds: readonly string[],
): Promise<readonly FinalMatchingRecord[]> {
  const ids = [...new Set(recordIds)].sort()
  if (ids.length === 0) return []
  await lockLinkTopology(tx, tenant.teamId)
  await lockRecords(tx, tenant.teamId, ids)
  const records = await tx.record.findMany({
    where: { ...tenantWhere(tenant), id: { in: ids }, deletedAt: null, mergedIntoId: null },
    select: { id: true, objectTypeId: true, data: true, displayName: true },
    orderBy: { id: 'asc' },
  })
  const links = await tx.recordLink.findMany({
    where: { ...tenantWhere(tenant), fromRecordId: { in: records.map((record) => record.id) }, activeUntil: null },
    select: { fromRecordId: true, relationTypeId: true, toRecordId: true, position: true },
  })
  const byRecord = new Map<string, typeof links>()
  for (const link of links) {
    const current = byRecord.get(link.fromRecordId) ?? []
    current.push(link)
    byRecord.set(link.fromRecordId, current)
  }
  const final: FinalMatchingRecord[] = []
  for (const record of records) {
    const objectType = schema.objectTypesById.get(record.objectTypeId)
    if (objectType === undefined) throw conflict('matching_object_type_not_loaded')
    const stored = canonicalJsonValue(record.data)
    if (stored === null || Array.isArray(stored) || typeof stored !== 'object') throw conflict('stored_record_data_invalid')
    const projected = projectLinksIntoData(schema, objectType.slug, byRecord.get(record.id) ?? [])
    const data: Data = { ...stored, ...projected }
    final.push({ id: record.id, objectType, data, displayName: record.displayName })
  }
  return final
}

export async function refreshMatchingRecords(
  tx: RecordTx,
  tenant: { organizationId: string; teamId: string },
  schema: LoadedSchema,
  touchedRecordIds: readonly string[],
): Promise<{ processed: number }> {
  const records = await finalMatchingRecords(tx, tenant, schema, touchedRecordIds)
  for (const record of records) {
    await materializeMatchingKeys(tx, schema, record.objectType, record.id, record.data)
  }
  return { processed: records.length }
}

export async function stageMatchingBootstrapBatch(
  tx: RecordTx,
  tenant: { organizationId: string; teamId: string },
  schema: LoadedSchema,
  generationId: string,
  recordIds: readonly string[],
): Promise<{ processed: number }> {
  const rules = schema.matchingRules.filter((rule) => (
    rule.generation.id === generationId
    && rule.generation.state === 'active'
    && rule.generation.keysReadyAt === null
    && rule.method !== 'fuzzy'
  ))
  if (rules.length === 0) throw conflict('matching_bootstrap_generation_not_loaded')
  const records = await finalMatchingRecords(tx, tenant, schema, recordIds)
  for (const record of records) {
    const objectRules = rules.filter((rule) => rule.objectTypeId === record.objectType.id)
    if (objectRules.length === 0) continue
    await tx.recordMatchLookupKey.deleteMany({
      where: {
        ...tenantWhere(tenant),
        recordId: record.id,
        matchingRuleId: { in: objectRules.map((rule) => rule.id) },
      },
    })
    const entries = objectRules.flatMap((rule) => (
      matchingTuples(schema, record.objectType, rule, record.data).map((tuple) => ({
        rule,
        normalizedHash: matchingTupleHash(tuple),
      }))
    ))
    await lockKeys(tx, tenant.teamId, entries.map((entry) => `match:${entry.rule.id}:${entry.normalizedHash}`))
    for (const entry of entries) {
      await tx.recordMatchLookupKey.create({
        data: {
          organizationId: tenant.organizationId,
          teamId: tenant.teamId,
          matchingRuleId: entry.rule.id,
          normalizedHash: entry.normalizedHash,
          recordId: record.id,
        },
      })
    }
  }
  return { processed: records.length }
}

export async function matchingCollisionCounts(
  tx: Pick<RecordTx, '$queryRaw'>,
  tenant: { organizationId: string; teamId: string },
  generationId: string,
): Promise<{ groupCount: number; recordCount: number }> {
  const groups = await tx.$queryRaw<Array<{ groupCount: number; recordCount: number }>>`
    SELECT count(*)::integer AS "groupCount", coalesce(sum(members), 0)::integer AS "recordCount"
    FROM (
      SELECT k.matching_rule_id, k.normalized_hash, count(*) AS members
      FROM record_match_lookup_keys k
      JOIN matching_rules r ON r.id = k.matching_rule_id
      WHERE k.organization_id = ${tenant.organizationId}::uuid
        AND k.team_id = ${tenant.teamId}::uuid
        AND r.organization_id = ${tenant.organizationId}::uuid
        AND r.team_id = ${tenant.teamId}::uuid
        AND r.generation_id = ${generationId}::uuid
        AND r.action = 'block'
      GROUP BY k.matching_rule_id, k.normalized_hash
      HAVING count(*) > 1
    ) collisions
  `
  return {
    groupCount: groups[0]?.groupCount ?? 0,
    recordCount: groups[0]?.recordCount ?? 0,
  }
}
