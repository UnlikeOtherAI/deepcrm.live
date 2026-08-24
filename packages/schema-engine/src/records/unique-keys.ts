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

function normalizedValues(
  value: JsonValue | undefined, multi: boolean, normalize: (value: unknown) => string | null,
): string[] {
  if (value === undefined) return []
  const values = multi && Array.isArray(value) ? value : [value]
  return values.map((item) => normalize(item) ?? canonicalJson(item))
}

export type UniqueKey = {
  attributeId: string
  attributeSlug: string
  normalizedHash: string
  normalizedValue: string
}

export function uniqueKeysForData(
  objectType: LoadedObjectType, data: Record<string, JsonValue>,
): UniqueKey[] {
  const keys: UniqueKey[] = []
  for (const attribute of objectType.attributes) {
    if (!attribute.isUnique) continue
    const type = getAttributeType(attribute.type)
    const values = normalizedValues(
      data[attribute.slug], attribute.isMulti, (item) => type.normalize(item, attribute.config),
    )
    for (const value of values) {
      keys.push({
        attributeId: attribute.id,
        attributeSlug: attribute.slug,
        normalizedHash: keyHash(value),
        normalizedValue: value,
      })
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
  const keys = uniqueKeysForData(objectType, data)
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
      if (conflict !== null) throw duplicate(key.attributeSlug, conflict)
    }
    throw error
  }
}
