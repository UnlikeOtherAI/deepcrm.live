import { tenantWhere } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import { computeDisplayName } from './display-name.js'
import { createChanges, diffChanges, type ChangeIntent, writeChanges } from './changes.js'
import { canonicalJsonValue, type JsonValue } from './json.js'
import { lockKeys, lockLinkTopology, lockRecords } from './locks.js'
import {
  findMatches, refreshMatchingRecords, removeMatchingKeys,
  type MatchCandidateFact,
} from '../matching/index.js'
import { findUniqueRecord, keyHash, normalizedAttributeValue, syncUniqueKeys } from './unique-keys.js'
import { validateRecordData } from './validate.js'
import type { LinkIntent } from './types.js'
import type { LoadedObjectType, LoadedSchema } from '../schema/load.js'
import type { RecordTx } from '../schema/tx.js'

export type LinkWriter = {
  apply(
    tx: RecordTx, ctx: ActorContext, schema: LoadedSchema, recordId: string, linkOps: readonly LinkIntent[],
  ): Promise<LinkWriteResult>
  delete(tx: RecordTx, ctx: ActorContext, schema: LoadedSchema, recordId: string): Promise<LinkWriteResult>
  restore(
    tx: RecordTx, ctx: ActorContext, schema: LoadedSchema, recordId: string, deleteSnapshot: JsonValue,
  ): Promise<LinkWriteResult>
}

export type LinkWriteResult = {
  changes: readonly ChangeIntent[]
  touchedRecordIds: readonly string[]
  snapshot?: JsonValue
}

export type AssertResolvedAction =
  | { action: 'create'; objectTypeId: string; recordId: null }
  | { action: 'edit'; objectTypeId: string; recordId: string }

export type AssertResolvedActionHandler = (resolution: AssertResolvedAction) => Promise<void>

type Data = Record<string, JsonValue>
export type RecordWriteResult = {
  record: { id: string; version: number; data: Data; displayName: string; deletedAt: Date | null }
  created: boolean
  changed: boolean
  changes: readonly ChangeIntent[]
  sequences: readonly number[]
  touchedRecordIds: readonly string[]
  duplicates: readonly MatchCandidateFact[]
}

export type CreateRecordInput = { objectType: string; data: Record<string, unknown>; reason?: string }
export type UpdateRecordInput = {
  recordId: string; data: Record<string, unknown>; expectedVersion?: number; reason?: string
}
export type AssertRecordInput = CreateRecordInput & { matchAttribute: string; expectedVersion?: number }

function object(schema: LoadedSchema, slug: string): LoadedObjectType {
  const result = schema.objectTypesBySlug.get(slug)
  if (result === undefined) throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Unknown object type')
  return result
}

function data(value: unknown): Data {
  const parsed = canonicalJsonValue(value)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new ServiceError(ErrorCode.INTERNAL, 'Stored record data is invalid')
  }
  return parsed
}

function output(
  record: { id: string; version: number; data: unknown; displayName: string; deletedAt: Date | null },
): RecordWriteResult['record'] {
  return {
    id: record.id,
    version: record.version,
    data: data(record.data),
    displayName: record.displayName,
    deletedAt: record.deletedAt,
  }
}

async function activeRecord(tx: RecordTx, ctx: ActorContext, recordId: string) {
  await lockRecords(tx, ctx.tenant.teamId, [recordId])
  const record = await tx.record.findFirst({ where: { ...tenantWhere(ctx.tenant), id: recordId } })
  if (record === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  if (record.mergedIntoId !== null) throw new ServiceError(ErrorCode.MERGED, 'Record has been merged', { redirect_to: record.mergedIntoId })
  if (record.deletedAt !== null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  return record
}

function version(record: { version: number }, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && expectedVersion !== record.version) {
    throw new ServiceError(ErrorCode.VERSION_CONFLICT, 'Record version does not match', { current: record.version })
  }
}

async function deleteSnapshot(
  tx: RecordTx, ctx: ActorContext, record: { id: string; data: unknown },
): Promise<JsonValue> {
  const [uniqueKeys, matchKeys] = await Promise.all([
    tx.recordUniqueKey.findMany({
      where: { ...tenantWhere(ctx.tenant), recordId: record.id },
      select: { attributeId: true, normalizedHash: true, normalizedValue: true },
      orderBy: [{ attributeId: 'asc' }, { normalizedHash: 'asc' }],
    }),
    tx.recordMatchKey.findMany({
      where: { ...tenantWhere(ctx.tenant), recordId: record.id },
      select: { matchingRuleId: true, normalizedHash: true },
      orderBy: [{ matchingRuleId: 'asc' }, { normalizedHash: 'asc' }],
    }),
  ])
  return canonicalJsonValue({ data: data(record.data), unique_keys: uniqueKeys, match_keys: matchKeys })
}

async function finish(
  tx: RecordTx,
  ctx: ActorContext,
  record: { id: string; version: number; data: unknown; displayName: string; deletedAt: Date | null },
  changes: ChangeIntent[],
  created: boolean,
  linkResult: LinkWriteResult = { changes: [], touchedRecordIds: [] },
  reason: string | undefined = undefined,
): Promise<RecordWriteResult> {
  const allChanges = [...changes, ...linkResult.changes]
    .map((change) => ({ ...change, reason: reason ?? change.reason }))
  const sequences = await writeChanges(tx, ctx, allChanges)
  return {
    record: output(record), created, changed: true, changes: allChanges, sequences,
    touchedRecordIds: [...new Set([record.id, ...linkResult.touchedRecordIds])].sort(),
    duplicates: [],
  }
}

async function matchingDuplicates(
  tx: RecordTx, ctx: ActorContext, schema: LoadedSchema, objectTypeId: string, recordId: string,
): Promise<readonly MatchCandidateFact[]> {
  const candidates = await findMatches(tx, ctx.tenant, ctx, schema, { objectTypeId, recordId })
  return candidates.filter((candidate) => candidate.recordId !== recordId)
}

type PreparedCreate = {
  record: { id: string; version: number; data: unknown; displayName: string; deletedAt: Date | null }
  changes: ChangeIntent[]
  links: LinkWriteResult
}

async function prepareCreate(
  tx: RecordTx, ctx: ActorContext, schema: LoadedSchema, input: CreateRecordInput, linkWriter: LinkWriter,
): Promise<PreparedCreate> {
  const objectType = object(schema, input.objectType)
  const validated = validateRecordData(schema, objectType, {}, input.data, 'create')
  const validatedData = data(validated.data)
  const displayName = computeDisplayName(schema, objectType, validatedData)
  const record = await tx.record.create({
    data: {
      ...tenantWhere(ctx.tenant), objectTypeId: objectType.id, data: validatedData, displayName,
      visibility: 'team', createdOnBehalfOf: ctx.onBehalfOf.uoaUserId, origin: null,
      createdByType: ctx.actor.type, createdById: ctx.actor.id,
    },
  })
  await syncUniqueKeys(tx, schema, objectType, record.id, validatedData)
  const links = validated.linkOps.length === 0
    ? { changes: [], touchedRecordIds: [] }
    : await linkWriter.apply(tx, ctx, schema, record.id, validated.linkOps)
  await refreshMatchingRecords(tx, ctx.tenant, schema, [record.id, ...links.touchedRecordIds])
  return { record, changes: createChanges(validatedData, record.id), links }
}

export async function createRecord(
  tx: RecordTx, ctx: ActorContext, schema: LoadedSchema, input: CreateRecordInput, linkWriter: LinkWriter,
): Promise<RecordWriteResult> {
  await lockLinkTopology(tx, ctx.tenant.teamId)
  const prepared = await prepareCreate(tx, ctx, schema, input, linkWriter)
  const result = await finish(tx, ctx, prepared.record, prepared.changes, true, prepared.links, input.reason)
  const duplicates = await matchingDuplicates(
    tx, ctx, schema, object(schema, input.objectType).id, prepared.record.id,
  )
  return { ...result, duplicates }
}

async function updateRecordInternal(
  tx: RecordTx, ctx: ActorContext, schema: LoadedSchema, input: UpdateRecordInput, linkWriter: LinkWriter,
  includeDuplicates: boolean,
): Promise<RecordWriteResult> {
  await lockLinkTopology(tx, ctx.tenant.teamId)
  const record = await activeRecord(tx, ctx, input.recordId)
  version(record, input.expectedVersion)
  const objectType = schema.objectTypesById.get(record.objectTypeId)
  if (objectType === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema metadata is inconsistent')
  const before = data(record.data)
  const validated = validateRecordData(schema, objectType, before, input.data, 'update')
  const validatedData = data(validated.data)
  const changes = diffChanges(before, validatedData, record.id, record.version + 1)
  if (changes.length === 0 && validated.linkOps.length === 0) {
    const result: RecordWriteResult = {
      record: output(record), created: false, changed: false, changes: [], sequences: [], touchedRecordIds: [],
      duplicates: [],
    }
    if (!includeDuplicates) return result
    return {
      ...result,
      duplicates: await matchingDuplicates(tx, ctx, schema, objectType.id, record.id),
    }
  }
  const persisted = await tx.record.updateMany({
    where: { ...tenantWhere(ctx.tenant), id: record.id },
    data: {
      data: validatedData,
      displayName: computeDisplayName(schema, objectType, validatedData),
      version: { increment: 1 },
    },
  })
  if (persisted.count !== 1) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const updated = await tx.record.findFirst({ where: { ...tenantWhere(ctx.tenant), id: record.id } })
  if (updated === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  await syncUniqueKeys(tx, schema, objectType, record.id, validatedData)
  const links = validated.linkOps.length === 0
    ? { changes: [], touchedRecordIds: [] }
    : await linkWriter.apply(tx, ctx, schema, record.id, validated.linkOps)
  await refreshMatchingRecords(tx, ctx.tenant, schema, [record.id, ...links.touchedRecordIds])
  const result = await finish(tx, ctx, updated, changes, false, links, input.reason)
  const duplicates = includeDuplicates
    ? await matchingDuplicates(tx, ctx, schema, objectType.id, record.id)
    : []
  return { ...result, duplicates }
}

export function updateRecord(
  tx: RecordTx, ctx: ActorContext, schema: LoadedSchema, input: UpdateRecordInput, linkWriter: LinkWriter,
): Promise<RecordWriteResult> {
  return updateRecordInternal(tx, ctx, schema, input, linkWriter, false)
}

export async function deleteRecord(
  tx: RecordTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  recordId: string,
  expectedVersion: number | undefined,
  linkWriter: LinkWriter,
  reason?: string,
): Promise<RecordWriteResult> {
  await lockLinkTopology(tx, ctx.tenant.teamId)
  const record = await activeRecord(tx, ctx, recordId)
  version(record, expectedVersion)
  const objectType = schema.objectTypesById.get(record.objectTypeId)
  if (objectType === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema metadata is inconsistent')
  const links = await linkWriter.delete(tx, ctx, schema, record.id)
  const baseSnapshot = await deleteSnapshot(tx, ctx, record)
  const linkSnapshot = links.snapshot === undefined ? {} : data(links.snapshot)
  const snapshot = canonicalJsonValue({
    ...data(baseSnapshot),
    links: linkSnapshot['links'] ?? [],
    cascaded: linkSnapshot['cascaded'] ?? [],
  })
  await syncUniqueKeys(tx, schema, objectType, record.id, {})
  await removeMatchingKeys(tx, ctx.tenant, [record.id])
  const persisted = await tx.record.updateMany({
    where: { ...tenantWhere(ctx.tenant), id: record.id },
    data: { deletedAt: ctx.now, version: { increment: 1 } },
  })
  if (persisted.count !== 1) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const updated = await tx.record.findFirst({ where: { ...tenantWhere(ctx.tenant), id: record.id } })
  if (updated === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  await refreshMatchingRecords(
    tx,
    ctx.tenant,
    schema,
    links.touchedRecordIds.filter((id) => id !== record.id),
  )
  const changes: ChangeIntent[] = [{
    recordId, kind: 'delete', attributeSlug: null, relationTypeId: null, linkId: null, groupId: null, oldValue: null, newValue: null,
    snapshot, resultingVersion: updated.version, reason: null,
  }]
  return finish(tx, ctx, updated, changes, false, links, reason)
}

export async function restoreRecord(
  tx: RecordTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  recordId: string,
  expectedVersion: number | undefined,
  linkWriter: LinkWriter,
  reason?: string,
): Promise<RecordWriteResult> {
  await lockLinkTopology(tx, ctx.tenant.teamId)
  await lockRecords(tx, ctx.tenant.teamId, [recordId])
  const record = await tx.record.findFirst({ where: { ...tenantWhere(ctx.tenant), id: recordId } })
  if (record === null || record.deletedAt === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  if (record.mergedIntoId !== null) throw new ServiceError(ErrorCode.MERGED, 'Record has been merged', { redirect_to: record.mergedIntoId })
  if (record.erasedAt !== null) throw new ServiceError(ErrorCode.ERASED, 'Record has been erased')
  version(record, expectedVersion)
  const objectType = schema.objectTypesById.get(record.objectTypeId)
  if (objectType === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema metadata is inconsistent')
  try { await syncUniqueKeys(tx, schema, objectType, record.id, data(record.data)) } catch (error) {
    if (error instanceof ServiceError && error.code === ErrorCode.DUPLICATE_FOUND) {
      throw new ServiceError(ErrorCode.RESTORE_CONFLICT, 'Record cannot be restored', {
        attribute: error.details['attribute'], held_by: error.details['record_id'],
      })
    }
    throw error
  }
  const persisted = await tx.record.updateMany({
    where: { ...tenantWhere(ctx.tenant), id: record.id },
    data: { deletedAt: null, version: { increment: 1 } },
  })
  if (persisted.count !== 1) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const updated = await tx.record.findFirst({ where: { ...tenantWhere(ctx.tenant), id: record.id } })
  if (updated === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const deletion = await tx.recordChange.findFirst({
    where: { ...tenantWhere(ctx.tenant), recordId: record.id, kind: 'delete' },
    orderBy: { seq: 'desc' }, select: { snapshot: true },
  })
  if (deletion === null) throw new ServiceError(ErrorCode.INTERNAL, 'Deleted record has no snapshot')
  const snapshot = canonicalJsonValue(deletion.snapshot)
  const changes: ChangeIntent[] = [{
    recordId, kind: 'restore', attributeSlug: null, relationTypeId: null, linkId: null, groupId: null, oldValue: null, newValue: null,
    snapshot: null, resultingVersion: updated.version, reason: null,
  }]
  const links = await linkWriter.restore(tx, ctx, schema, record.id, snapshot)
  try {
    await refreshMatchingRecords(tx, ctx.tenant, schema, [record.id, ...links.touchedRecordIds])
  } catch (error) {
    if (error instanceof ServiceError && error.code === ErrorCode.DUPLICATE_FOUND) {
      throw new ServiceError(ErrorCode.RESTORE_CONFLICT, 'Record cannot be restored', {
        attribute: error.details['attribute'], held_by: error.details['record_id'],
      })
    }
    throw error
  }
  return finish(tx, ctx, updated, changes, false, links, reason)
}

export async function assertRecord(
  tx: RecordTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  input: AssertRecordInput,
  linkWriter: LinkWriter,
  onResolved: AssertResolvedActionHandler,
): Promise<RecordWriteResult> {
  await lockLinkTopology(tx, ctx.tenant.teamId)
  const objectType = object(schema, input.objectType)
  const attribute = schema.attributesByObjectTypeId.get(objectType.id)?.get(input.matchAttribute)
  if (attribute === undefined || !attribute.isUnique) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Match attribute must be unique', { issues: [{ path: '/match_attribute', message: 'Match attribute must be unique' }] })
  }
  const validated = validateRecordData(schema, objectType, {}, input.data, 'create')
  const candidate = validated.data[attribute.slug]
  const first = attribute.isMulti && Array.isArray(candidate) ? candidate[0] : candidate
  if (first === undefined) throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Match attribute is required', { issues: [{ path: '/data', message: 'Match attribute is required' }] })
  const values = attribute.isMulti && Array.isArray(candidate) ? candidate : [candidate]
  const normalized = values.map((value) => normalizedAttributeValue(attribute, canonicalJsonValue(value)))
  const hashes = normalized.map(keyHash)
  await lockKeys(tx, ctx.tenant.teamId, hashes.map((hash) => `${attribute.id}:${hash}`))
  const firstHash = hashes[0]
  if (firstHash === undefined) throw new ServiceError(ErrorCode.INTERNAL, 'Match key is missing')
  const existingId = await findUniqueRecord(tx, ctx.tenant, attribute.id, firstHash)
  if (existingId !== null && input.expectedVersion !== undefined) {
    const existing = await tx.record.findFirst({
      where: { ...tenantWhere(ctx.tenant), id: existingId },
      select: { version: true },
    })
    if (existing !== null && existing.version > input.expectedVersion) {
      throw new ServiceError(ErrorCode.IDEMPOTENCY_MISMATCH, 'Expected version is older than the current record version', {
        current: existing.version,
      })
    }
  }
  const otherIds = new Set<string>()
  for (const hash of hashes.slice(1)) {
    const candidateId = await findUniqueRecord(tx, ctx.tenant, attribute.id, hash)
    if (candidateId !== null && candidateId !== existingId) otherIds.add(candidateId)
  }
  if (otherIds.size > 0) {
    throw new ServiceError(ErrorCode.DUPLICATE_FOUND, 'Multiple records match assert values', {
      record_ids: [...otherIds].sort(),
    })
  }
  if (existingId !== null) {
    await onResolved({ action: 'edit', objectTypeId: objectType.id, recordId: existingId })
    return updateRecordInternal(
      tx,
      ctx,
      schema,
      { recordId: existingId, data: input.data, expectedVersion: input.expectedVersion, reason: input.reason },
      linkWriter,
      true,
    )
  }
  await onResolved({ action: 'create', objectTypeId: objectType.id, recordId: null })
  await tx.$executeRaw`SAVEPOINT assert_create`
  try {
    const prepared = await prepareCreate(tx, ctx, schema, input, linkWriter)
    const created = await finish(tx, ctx, prepared.record, prepared.changes, true, prepared.links, input.reason)
    const duplicates = await matchingDuplicates(tx, ctx, schema, objectType.id, prepared.record.id)
    await tx.$executeRaw`RELEASE SAVEPOINT assert_create`
    return { ...created, duplicates }
  } catch (error) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT assert_create`
    if (!(error instanceof ServiceError) || error.code !== ErrorCode.DUPLICATE_FOUND) throw error
    const retriedId = await findUniqueRecord(tx, ctx.tenant, attribute.id, firstHash)
    if (retriedId === null) throw error
    await onResolved({ action: 'edit', objectTypeId: objectType.id, recordId: retriedId })
    return updateRecordInternal(
      tx,
      ctx,
      schema,
      { recordId: retriedId, data: input.data, expectedVersion: input.expectedVersion, reason: input.reason },
      linkWriter,
      true,
    )
  }
}
