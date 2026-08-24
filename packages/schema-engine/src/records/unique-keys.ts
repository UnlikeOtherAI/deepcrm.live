import { createHash } from 'node:crypto'

import { tenantWhere } from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import { getAttributeType } from '../attribute-types/index.js'
import type { LoadedAttribute, LoadedObjectType, LoadedSchema } from '../schema/load.js'
import type { RecordTx } from '../schema/tx.js'
import { canonicalJson, type JsonValue } from './json.js'
import { lockKeys } from './locks.js'

export function keyHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function normalizedAttributeValue(attribute: LoadedAttribute, value: JsonValue): string {
  const type = getAttributeType(attribute.type)
  return type.normalize(value, attribute.config) ?? canonicalJson(value)
}

function normalizedStoredValue(attribute: LoadedAttribute, value: JsonValue): string {
  if (!attribute.isMulti) return normalizedAttributeValue(attribute, value)
  if (!Array.isArray(value)) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Stored multi attribute is not an array')
  }
  return canonicalJson(value.map((item) => normalizedAttributeValue(attribute, item)))
}

function normalizedValues(
  value: JsonValue | undefined, multi: boolean, normalize: (value: unknown) => string | null,
): string[] {
  if (value === undefined) return []
  const values = multi && Array.isArray(value) ? value : [value]
  return values.map((item) => normalize(item) ?? canonicalJson(item))
}

type UniqueKey = { attributeId: string; normalizedHash: string; normalizedValue: string }

function uniqueKeys(objectType: LoadedObjectType, data: Record<string, JsonValue>): UniqueKey[] {
  const keys: UniqueKey[] = []
  for (const attribute of objectType.attributes) {
    if (!attribute.isUnique) continue
    const type = getAttributeType(attribute.type)
    const values = normalizedValues(
      data[attribute.slug], attribute.isMulti, (item) => type.normalize(item, attribute.config),
    )
    for (const value of values) {
      keys.push({ attributeId: attribute.id, normalizedHash: keyHash(value), normalizedValue: value })
    }
  }
  return keys.sort((left, right) => `${left.attributeId}:${left.normalizedHash}`.localeCompare(`${right.attributeId}:${right.normalizedHash}`))
}

function duplicate(attribute: string, recordId?: string): ServiceError {
  return new ServiceError(ErrorCode.DUPLICATE_FOUND, 'A record with this value already exists', {
    attribute,
    ...(recordId === undefined ? {} : { record_id: recordId }),
  })
}

function uniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

export async function findUniqueRecord(
  tx: RecordTx,
  tenant: { organizationId: string; teamId: string },
  attributeId: string,
  normalizedHash: string,
): Promise<string | null> {
  const row = await tx.recordUniqueKey.findFirst({
    where: { ...tenantWhere(tenant), attributeId, normalizedHash },
    select: { recordId: true },
  })
  return row?.recordId ?? null
}

export async function syncUniqueKeys(
  tx: RecordTx,
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  recordId: string,
  data: Record<string, JsonValue>,
): Promise<void> {
  const keys = uniqueKeys(objectType, data)
  await lockKeys(tx, schema.teamId, keys.map((key) => `${key.attributeId}:${key.normalizedHash}`))
  await tx.recordUniqueKey.deleteMany({
    where: { organizationId: objectType.organizationId, teamId: schema.teamId, recordId },
  })
  await tx.$executeRaw`SAVEPOINT unique_key_insert`
  try {
    for (const key of keys) {
      await tx.recordUniqueKey.create({
        data: {
          organizationId: objectType.organizationId,
          teamId: schema.teamId,
          attributeId: key.attributeId,
          recordId,
          normalizedHash: key.normalizedHash,
          normalizedValue: key.normalizedValue,
        },
      })
    }
    await tx.$executeRaw`RELEASE SAVEPOINT unique_key_insert`
  } catch (error) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT unique_key_insert`
    if (!uniqueViolation(error)) throw error
    for (const key of keys) {
      const conflict = await findUniqueRecord(
        tx, { organizationId: objectType.organizationId, teamId: schema.teamId }, key.attributeId, key.normalizedHash,
      )
      if (conflict !== null) throw duplicate(key.attributeId, conflict)
    }
    throw error
  }
}

export async function syncMatchKeys(
  tx: RecordTx,
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  recordId: string,
  data: Record<string, JsonValue>,
): Promise<void> {
  await tx.recordMatchKey.deleteMany({
    where: { organizationId: objectType.organizationId, teamId: schema.teamId, recordId },
  })
  for (const rule of schema.matchingRulesByObjectTypeId.get(objectType.id) ?? []) {
    if (rule.action !== 'block') continue
    const rawValues = rule.attributeSlugs.map((slug) => data[slug])
    if (rawValues.some((value) => value === undefined)) continue
    const values = rawValues.map((value, index) => {
      const slug = rule.attributeSlugs[index]
      const attribute = slug === undefined ? undefined : schema.attributesByObjectTypeId.get(objectType.id)?.get(slug)
      if (attribute === undefined || value === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema metadata is inconsistent')
      return normalizedStoredValue(attribute, value)
    })
    const normalizedHash = keyHash(values.join('\x1f'))
    await lockKeys(tx, schema.teamId, [`match:${rule.position}:${normalizedHash}`])
    await tx.$executeRaw`SAVEPOINT match_key_insert`
    try {
      await tx.recordMatchKey.create({
        data: {
          organizationId: objectType.organizationId,
          teamId: schema.teamId,
          objectTypeId: objectType.id,
          rulePosition: rule.position,
          normalizedHash,
          recordId,
        },
      })
      await tx.$executeRaw`RELEASE SAVEPOINT match_key_insert`
    } catch (error) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT match_key_insert`
      if (!uniqueViolation(error)) throw error
      const attribute = rule.attributeSlugs[0]
      if (attribute === undefined) {
        throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Matching rule has no attribute descriptor')
      }
      const conflict = await tx.recordMatchKey.findFirst({
        where: {
          organizationId: objectType.organizationId,
          teamId: schema.teamId,
          objectTypeId: objectType.id,
          rulePosition: rule.position,
          normalizedHash,
        },
        select: { recordId: true },
      })
      if (conflict === null) throw new ServiceError(ErrorCode.INTERNAL, 'Matching key conflict has no winner')
      throw new ServiceError(ErrorCode.DUPLICATE_FOUND, 'A matching record already exists', {
        attribute, record_id: conflict.recordId,
      })
    }
  }
}
