import { Prisma, tenantWhere, type Db } from '@deepcrm/db'
import {
  ErrorCode,
  EventDetail,
  EventTypeDetail,
  FileLinkDetail,
  FileObjectDetail,
  ServiceError,
  type ActorContext,
} from '@deepcrm/schemas'
import { loadSchema } from '@deepcrm/schema-engine'

import type { AppDeps } from '../deps.js'
import { checkPolicy, type PolicyRequest } from './policy.js'
import { recordBoundary } from './record-boundary.js'
import { requireSchemaDefine, requireSchemaView } from './schema.js'
import { requireVisibleRecord } from './record-visibility.js'

type JsonObject = Record<string, unknown>
type MutableJsonObject = { [key: string]: Prisma.InputJsonValue | null }
type AuditTx = Pick<Db, '$queryRaw' | '$executeRaw' | 'auditLog'>
type FileTx = Pick<Db, 'fileObject' | 'fileLink'> & AuditTx
type EventTx = Pick<Db, 'eventType' | 'event' | 'team'> & AuditTx
type EventRow = Awaited<ReturnType<typeof eventRows>>[number]

export type RegisterFileInput = {
  provider: string
  providerKey: string
  filename: string
  mimeType: string
  sizeBytes: string
  checksumSha256?: string
  metadata?: JsonObject
}
export type LinkFileInput = {
  fileId: string
  targetType: 'record' | 'activity' | 'event'
  recordId?: string
  eventId?: string
  purpose: string
  metadata?: JsonObject
}
export type ListFilesInput = {
  targetType?: 'record' | 'activity' | 'event'
  recordId?: string
  eventId?: string
  limit?: number
}
export type DefineEventTypeInput = {
  slug: string; name: string; description?: string; subjectObjectType?: string; propertySchema?: JsonObject
}
export type IngestEventInput = {
  eventType: string; source: string; externalId: string; occurredAt: string; subjectRecordId?: string
  actor?: { type: 'human' | 'agent' | 'system'; id: string }
  properties?: JsonObject
  correctionOfEventId?: string
}
export type EventsQueryInput = {
  eventType?: string; subjectRecordId?: string; source?: string; cursor?: string; limit?: number
}

function failure(
  code: typeof ErrorCode.VALIDATION_FAILED | typeof ErrorCode.SCHEMA_CONFLICT | typeof ErrorCode.LIMIT_EXCEEDED,
  message: string,
): never {
  throw new ServiceError(code, message)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nestedJson(value: unknown): Prisma.InputJsonValue | null {
  if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    failure(ErrorCode.VALIDATION_FAILED, 'Metadata must not contain URLs')
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(nestedJson)
  if (isObject(value)) return jsonInput(value)
  failure(ErrorCode.VALIDATION_FAILED, 'JSON metadata is invalid')
}

function jsonInput(value: unknown): MutableJsonObject {
  if (!isObject(value)) failure(ErrorCode.VALIDATION_FAILED, 'JSON metadata must be an object')
  const result: MutableJsonObject = {}
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|authorization|cookie/iu.test(key)) {
      failure(ErrorCode.VALIDATION_FAILED, 'Metadata must not contain credential fields')
    }
    result[key] = nestedJson(child)
  }
  return result
}

function metadata(ctx: ActorContext): Prisma.InputJsonObject {
  return { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance }
}

async function audit(
  deps: AppDeps,
  tx: AuditTx,
  ctx: ActorContext,
  action: string,
  resourceType: string,
  resourceId: string | null,
): Promise<void> {
  await deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type, actorId: ctx.actor.id, onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action, resourceType, resourceId, outcome: 'success', reason: null,
    metadata: metadata(ctx), requestId: ctx.requestId, ipAddress: null, userAgent: null,
  })
}

function visibleRecordRequest(ctx: ActorContext, record: { id: string; objectTypeId: string }): PolicyRequest {
  return {
    resourceType: 'record',
    action: 'view',
    scopes: [
      { scope: 'team', id: ctx.tenant.teamId },
      { scope: 'object_type', id: record.objectTypeId },
      { scope: 'record', id: record.id },
    ],
  }
}

async function requireRecordView(deps: AppDeps, ctx: ActorContext, recordId: string): Promise<void> {
  const record = await requireVisibleRecord(deps.db, ctx, recordId)
  const decision = await checkPolicy(deps.db, ctx, visibleRecordRequest(ctx, record))
  if (!decision.allowed || decision.requiresApproval) {
    throw new ServiceError(
      decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
      'Record access is not permitted',
    )
  }
}

function presentFile(row: {
  id: string; provider: string; providerKey: string; filename: string; mimeType: string
  sizeBytes: bigint; checksumSha256: string | null; metadata: unknown; createdAt: Date
}) {
  return FileObjectDetail.parse({
    id: row.id, provider: row.provider, provider_key: row.providerKey,
    filename: row.filename, mime_type: row.mimeType, size_bytes: row.sizeBytes.toString(),
    checksum_sha256: row.checksumSha256, metadata: row.metadata, created_at: row.createdAt.toISOString(),
  })
}

function presentLink(row: {
  id: string; fileId: string; targetType: 'record' | 'activity' | 'event'
  recordId: string | null; eventId: string | null; purpose: string; metadata: unknown
}) {
  return FileLinkDetail.parse({
    id: row.id, file_id: row.fileId, target_type: row.targetType,
    record_id: row.recordId, event_id: row.eventId, purpose: row.purpose, metadata: row.metadata,
  })
}

function accessFor(fileId: string, now: Date) {
  const expires = new Date(now.getTime() + 5 * 60 * 1_000)
  return {
    url: `https://storage.deepcrm.invalid/files/${fileId}?expires_at=${encodeURIComponent(expires.toISOString())}`,
    expires_at: expires.toISOString(),
  }
}

function parseSize(value: string): bigint {
  const size = BigInt(value)
  if (size > 5_000_000_000n) failure(ErrorCode.LIMIT_EXCEEDED, 'File size exceeds metadata limit')
  return size
}

function assertFileInput(input: RegisterFileInput): void {
  if (!/^[a-z0-9][a-z0-9_.-]{0,59}$/u.test(input.provider)) {
    failure(ErrorCode.VALIDATION_FAILED, 'Storage provider is invalid')
  }
  if (input.providerKey.includes('://')) failure(ErrorCode.VALIDATION_FAILED, 'Provider key must not be a URL')
  if (!/^[\w.+-]+\/[\w.+-]+$/u.test(input.mimeType)) failure(ErrorCode.VALIDATION_FAILED, 'MIME type is invalid')
}

function sameFile(input: RegisterFileInput, row: {
  filename: string; mimeType: string; sizeBytes: bigint; checksumSha256: string | null
}): boolean {
  return row.filename === input.filename
    && row.mimeType === input.mimeType
    && row.sizeBytes.toString() === input.sizeBytes
    && row.checksumSha256 === (input.checksumSha256 ?? null)
}

export async function registerFile(
  deps: AppDeps,
  ctx: ActorContext,
  input: RegisterFileInput,
): Promise<{ file: ReturnType<typeof FileObjectDetail.parse> }> {
  await requireSchemaView(deps, ctx)
  assertFileInput(input)
  const metadataValue = jsonInput(input.metadata ?? {})
  const existing = await deps.db.fileObject.findUnique({
    where: { organizationId_teamId_provider_providerKey: {
      organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId,
      provider: input.provider, providerKey: input.providerKey,
    } },
  })
  if (existing !== null) {
    if (!sameFile(input, existing)) failure(ErrorCode.SCHEMA_CONFLICT, 'File metadata conflicts with existing object')
    return { file: presentFile(existing) }
  }
  return deps.db.$transaction(async (tx: FileTx) => {
    const file = await tx.fileObject.create({ data: {
      ...tenantWhere(ctx.tenant), provider: input.provider, providerKey: input.providerKey,
      filename: input.filename, mimeType: input.mimeType, sizeBytes: parseSize(input.sizeBytes),
      checksumSha256: input.checksumSha256 ?? null, metadata: metadataValue,
      createdByType: ctx.actor.type, createdById: ctx.actor.id, onBehalfOf: ctx.onBehalfOf.uoaUserId,
    } })
    await audit(deps, tx, ctx, 'crm_file_register', 'file', file.id)
    return { file: presentFile(file) }
  })
}

async function visibleEvent(deps: AppDeps, ctx: ActorContext, eventId: string): Promise<EventRow> {
  const row = await deps.db.event.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: eventId },
    include: { eventType: true },
  })
  if (row === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Event not found')
  if (row.subjectRecordId !== null) await requireRecordView(deps, ctx, row.subjectRecordId)
  return row
}

async function isVisibleTarget(deps: AppDeps, ctx: ActorContext, row: {
  recordId: string | null; eventId: string | null
}): Promise<boolean> {
  try {
    if (row.recordId !== null) await requireRecordView(deps, ctx, row.recordId)
    if (row.eventId !== null) await visibleEvent(deps, ctx, row.eventId)
    return true
  } catch (error) {
    if (
      error instanceof ServiceError &&
      (error.code === ErrorCode.NOT_FOUND || error.code === ErrorCode.POLICY_DENIED)
    ) return false
    throw error
  }
}

function target(input: LinkFileInput): { recordId: string | null; eventId: string | null } {
  if (input.targetType === 'event') {
    if (input.eventId === undefined || input.recordId !== undefined) {
      failure(ErrorCode.VALIDATION_FAILED, 'Event file links require only event_id')
    }
    return { recordId: null, eventId: input.eventId }
  }
  if (input.recordId === undefined || input.eventId !== undefined) {
    failure(ErrorCode.VALIDATION_FAILED, 'Record/activity file links require only record_id')
  }
  return { recordId: input.recordId, eventId: null }
}

export async function linkFile(
  deps: AppDeps,
  ctx: ActorContext,
  input: LinkFileInput,
): Promise<{ link: ReturnType<typeof FileLinkDetail.parse> }> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const file = await deps.db.fileObject.findFirst({ where: { ...tenantWhere(ctx.tenant), id: input.fileId } })
    if (file === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'File not found')
    const selected = target(input)
    if (selected.recordId !== null) await requireRecordView(deps, ctx, selected.recordId)
    if (selected.eventId !== null) await visibleEvent(deps, ctx, selected.eventId)
    const linkMetadata = jsonInput(input.metadata ?? {})
    return deps.db.$transaction(async (tx: FileTx) => {
      const link = await tx.fileLink.create({ data: {
        ...tenantWhere(ctx.tenant), fileId: input.fileId, targetType: input.targetType,
        recordId: selected.recordId, eventId: selected.eventId, purpose: input.purpose,
        metadata: linkMetadata, createdByType: ctx.actor.type, createdById: ctx.actor.id,
      } })
      await audit(deps, tx, ctx, 'crm_file_link', 'file_link', link.id)
      return { link: presentLink(link) }
    })
  })
}

export async function listFiles(deps: AppDeps, ctx: ActorContext, input: ListFilesInput) {
  await requireSchemaView(deps, ctx)
  if (input.recordId !== undefined) await requireRecordView(deps, ctx, input.recordId)
  if (input.eventId !== undefined) await visibleEvent(deps, ctx, input.eventId)
  const limit = input.limit ?? 50
  const rows = await deps.db.fileLink.findMany({
    where: {
      ...tenantWhere(ctx.tenant),
      ...(input.targetType === undefined ? {} : { targetType: input.targetType }),
      ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    },
    include: { file: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  const visible = []
  for (const row of rows) {
    if (!await isVisibleTarget(deps, ctx, row)) continue
    visible.push({ file: presentFile(row.file), link: presentLink(row), access: accessFor(row.fileId, deps.clock()) })
  }
  return { files: visible }
}

function presentEventType(
  row: {
    id: string; slug: string; name: string; description: string
    propertySchema: unknown; archivedAt: Date | null
  },
  subject: string | null,
) {
  return EventTypeDetail.parse({
    id: row.id, slug: row.slug, name: row.name, description: row.description,
    subject_object_type: subject, property_schema: row.propertySchema,
    archived_at: row.archivedAt?.toISOString() ?? null,
  })
}

function validatePropertySchema(value: unknown): MutableJsonObject {
  const schema = jsonInput(value ?? {})
  const type = schema['type']
  if (type !== undefined && type !== 'object') failure(ErrorCode.VALIDATION_FAILED, 'Event property schema must be object')
  return schema
}

export async function defineEventType(
  deps: AppDeps,
  ctx: ActorContext,
  input: DefineEventTypeInput,
): Promise<{ event_type: ReturnType<typeof EventTypeDetail.parse> }> {
  await requireSchemaDefine(deps, ctx)
  const schema = await loadSchema(deps.db, ctx.tenant, { useCache: false })
  const subject = input.subjectObjectType === undefined ? null : schema.objectTypesBySlug.get(input.subjectObjectType)
  if (input.subjectObjectType !== undefined && subject === undefined) {
    throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Unknown subject object type')
  }
  const propertySchema = validatePropertySchema(input.propertySchema ?? {})
  try {
    return await deps.db.$transaction(async (tx: EventTx) => {
      const eventType = await tx.eventType.create({ data: {
        ...tenantWhere(ctx.tenant), slug: input.slug, name: input.name,
        description: input.description ?? '', subjectObjectTypeId: subject?.id ?? null,
        propertySchema, createdByType: ctx.actor.type, createdById: ctx.actor.id,
      } })
      await tx.team.updateMany({
        where: { id: ctx.tenant.teamId, organizationId: ctx.tenant.organizationId },
        data: { schemaVersion: { increment: 1 } },
      })
      await audit(deps, tx, ctx, 'crm_event_type_define', 'event_type', eventType.id)
      return { event_type: presentEventType(eventType, input.subjectObjectType ?? null) }
    })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      failure(ErrorCode.SCHEMA_CONFLICT, 'Event type slug already exists')
    }
    throw error
  }
}

function validateProperties(schema: unknown, properties: JsonObject): MutableJsonObject {
  const definition = isObject(schema) ? schema : {}
  const rawRequired = definition['required']
  if (Array.isArray(rawRequired)) {
    for (const key of rawRequired) {
      if (typeof key === 'string' && !Object.hasOwn(properties, key)) {
        failure(ErrorCode.VALIDATION_FAILED, 'Event properties are missing required fields')
      }
    }
  }
  if (definition['additionalProperties'] === false && isObject(definition['properties'])) {
    const allowed = new Set(Object.keys(definition['properties']))
    if (Object.keys(properties).some((key) => !allowed.has(key))) {
      failure(ErrorCode.VALIDATION_FAILED, 'Event properties contain unknown fields')
    }
  }
  if (isObject(definition['properties'])) {
    for (const [key, childSchema] of Object.entries(definition['properties'])) {
      if (!Object.hasOwn(properties, key)) continue
      if (!isObject(childSchema)) failure(ErrorCode.VALIDATION_FAILED, 'Event property schema is invalid')
      const expected = childSchema['type']
      const actual = properties[key]
      const matches =
        expected === undefined ||
        (expected === 'string' && typeof actual === 'string') ||
        (expected === 'number' && typeof actual === 'number' && Number.isFinite(actual)) ||
        (expected === 'integer' && typeof actual === 'number' && Number.isInteger(actual)) ||
        (expected === 'boolean' && typeof actual === 'boolean') ||
        (expected === 'object' && isObject(actual)) ||
        (expected === 'array' && Array.isArray(actual))
      if (!matches) failure(ErrorCode.VALIDATION_FAILED, 'Event property type does not match schema')
    }
  }
  return jsonInput(properties)
}

async function eventRows(deps: AppDeps, ctx: ActorContext, input: EventsQueryInput, after: Date | undefined) {
  return deps.db.event.findMany({
    where: {
      ...tenantWhere(ctx.tenant),
      ...(input.eventType === undefined ? {} : { eventType: { slug: input.eventType } }),
      ...(input.subjectRecordId === undefined ? {} : { subjectRecordId: input.subjectRecordId }),
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(after === undefined ? {} : { occurredAt: { lt: after } }),
    },
    include: { eventType: true },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: (input.limit ?? 50) + 1,
  })
}

function presentEvent(row: EventRow) {
  return EventDetail.parse({
    id: row.id, event_type: row.eventType.slug, source: row.source, external_id: row.externalId,
    occurred_at: row.occurredAt.toISOString(), subject_record_id: row.subjectRecordId,
    actor: row.actorType === null || row.actorId === null ? null : { type: row.actorType, id: row.actorId },
    properties: row.properties, correction_of_event_id: row.correctionOfEventId,
  })
}

export async function ingestEvent(
  deps: AppDeps,
  ctx: ActorContext,
  input: IngestEventInput,
): Promise<{ event: ReturnType<typeof EventDetail.parse>; created: boolean }> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const type = await deps.db.eventType.findFirst({
      where: { ...tenantWhere(ctx.tenant), slug: input.eventType, archivedAt: null },
    })
    if (type === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Event type not found')
    if (type.subjectObjectTypeId !== null) {
      if (input.subjectRecordId === undefined) failure(ErrorCode.VALIDATION_FAILED, 'Event subject is required')
      const subject = await requireVisibleRecord(deps.db, ctx, input.subjectRecordId)
      if (subject.objectTypeId !== type.subjectObjectTypeId) {
        failure(ErrorCode.VALIDATION_FAILED, 'Event subject object type does not match')
      }
      await requireRecordView(deps, ctx, input.subjectRecordId)
    }
    if (input.correctionOfEventId !== undefined) await visibleEvent(deps, ctx, input.correctionOfEventId)
    const existing = await deps.db.event.findFirst({
      where: { ...tenantWhere(ctx.tenant), eventTypeId: type.id, source: input.source, externalId: input.externalId },
      include: { eventType: true },
    })
    if (existing !== null) return { event: presentEvent(existing), created: false }
    const properties = validateProperties(type.propertySchema, input.properties ?? {})
    const occurredAt = new Date(input.occurredAt)
    if (Number.isNaN(occurredAt.getTime())) failure(ErrorCode.VALIDATION_FAILED, 'Event occurred_at is invalid')
    return deps.db.$transaction(async (tx: EventTx) => {
      const event = await tx.event.create({ data: {
        ...tenantWhere(ctx.tenant), eventTypeId: type.id, source: input.source, externalId: input.externalId,
        occurredAt, subjectRecordId: input.subjectRecordId, actorType: input.actor?.type,
        actorId: input.actor?.id, properties, correctionOfEventId: input.correctionOfEventId,
        createdByType: ctx.actor.type, createdById: ctx.actor.id,
      }, include: { eventType: true } })
      await audit(deps, tx, ctx, 'crm_event_ingest', 'event', event.id)
      return { event: presentEvent(event), created: true }
    })
  })
}

function eventCursor(input: EventsQueryInput, ctx: ActorContext) {
  return {
    tool: 'crm_events_query',
    tenant: ctx.tenant,
    arguments: {
      event_type: input.eventType ?? null, subject_record_id: input.subjectRecordId ?? null,
      source: input.source ?? null, limit: input.limit ?? 50,
      sort: [{ system: 'occurred_at', direction: 'desc' }],
    },
  }
}

export async function queryEvents(deps: AppDeps, ctx: ActorContext, input: EventsQueryInput) {
  await requireSchemaView(deps, ctx)
  if (input.subjectRecordId !== undefined) await requireRecordView(deps, ctx, input.subjectRecordId)
  const limit = input.limit ?? 50
  const after = input.cursor === undefined
    ? undefined
    : new Date(String(deps.queryCursor.open(input.cursor, eventCursor(input, ctx)).values[0]?.value))
  const rows = await eventRows(deps, ctx, input, after)
  const page = rows.slice(0, limit)
  const visible = []
  for (const row of page) {
    if (!await isVisibleTarget(deps, ctx, { recordId: row.subjectRecordId, eventId: null })) continue
    visible.push(presentEvent(row))
  }
  const last = page.at(-1)
  const next_cursor = rows.length <= limit || last === undefined ? null : deps.queryCursor.seal({
    values: [{ isNull: false, value: last.occurredAt.toISOString() }],
    id: last.id,
  }, eventCursor(input, ctx))
  return { events: visible, next_cursor }
}
