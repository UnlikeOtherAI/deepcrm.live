import { Prisma, tenantWhere, type TenantRef } from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import { canonicalJson } from '../records/json.js'
import type { AttributeInput, AuditActor } from './mutation-types.js'
import type { SchemaTx } from './tx.js'

type AttributeRow = {
  id: string
  slug: string
  type: AttributeInput['type']
  config: Prisma.JsonValue
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'
  objectTypeId: string
}
type UpdateInput = Partial<AttributeInput> & { recomputeKeys?: boolean }
type JsonObject = Record<string, Prisma.InputJsonValue | null>
type Option = JsonObject & {
  id: string
  label: string
  color?: string
  archived?: boolean
  category?: string
  position?: number
}
export type PreparedAttributeEvolution = {
  config: Prisma.InputJsonValue | typeof Prisma.JsonNull
  keyRecompute: boolean
  reindex: boolean
}

function conflict(detail: string): ServiceError {
  return new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema conflicts with existing metadata', { detail })
}

function asObject(value: Prisma.JsonValue | Prisma.InputJsonValue | typeof Prisma.JsonNull): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: JsonObject = {}
  for (const [key, child] of Object.entries(value)) {
    if (
      child === null ||
      typeof child === 'string' ||
      typeof child === 'number' ||
      typeof child === 'boolean' ||
      Array.isArray(child) ||
      typeof child === 'object'
    ) result[key] = child as Prisma.InputJsonValue | null
  }
  return result
}

function option(value: unknown): Option | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const fields = value as Record<string, unknown>
  if (typeof fields.id !== 'string' || typeof fields.label !== 'string') return null
  return {
    ...asObject(fields as Prisma.JsonObject),
    id: fields.id,
    label: fields.label,
    ...(typeof fields.color === 'string' ? { color: fields.color } : {}),
    ...(fields.archived === true ? { archived: true } : {}),
    ...(typeof fields.category === 'string' ? { category: fields.category } : {}),
    ...(typeof fields.position === 'number' ? { position: fields.position } : {}),
  }
}

function options(config: Prisma.JsonValue | Prisma.InputJsonValue | typeof Prisma.JsonNull): Option[] {
  const raw = asObject(config).options
  if (!Array.isArray(raw)) return []
  return raw.map(option).filter((item): item is Option => item !== null)
}

function activeIds(config: Prisma.JsonValue | Prisma.InputJsonValue | typeof Prisma.JsonNull): string[] {
  return options(config)
    .filter((item) => item.archived !== true)
    .map((item) => item.id)
    .sort()
}

function optionSearchShape(config: Prisma.JsonValue | Prisma.InputJsonValue | typeof Prisma.JsonNull): string {
  return canonicalJson(options(config).map((item) => ({
    id: item.id,
    label: item.label,
    archived: item.archived === true,
  })).sort((left, right) => left.id.localeCompare(right.id)))
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function referencedOptionIds(tx: SchemaTx, tenant: TenantRef, attribute: AttributeRow): Promise<Set<string>> {
  const rows = await tx.$queryRaw<{ value: string }[]>`
    SELECT DISTINCT item.value
    FROM records r
    CROSS JOIN LATERAL (
      SELECT jsonb_array_elements_text(r.data -> ${attribute.slug}) AS value
      WHERE jsonb_typeof(r.data -> ${attribute.slug}) = 'array'
      UNION ALL
      SELECT r.data ->> ${attribute.slug} AS value
      WHERE jsonb_typeof(r.data -> ${attribute.slug}) = 'string'
    ) item
    WHERE r.organization_id = ${tenant.organizationId}::uuid
      AND r.team_id = ${tenant.teamId}::uuid
      AND r.object_type_id = ${attribute.objectTypeId}::uuid
      AND r.deleted_at IS NULL
      AND r.merged_into_id IS NULL
      AND r.erased_at IS NULL
  `
  return new Set(rows.map((row) => row.value))
}

async function recordsWithValue(tx: SchemaTx, tenant: TenantRef, attribute: AttributeRow): Promise<number> {
  return tx.record.count({
    where: {
      ...tenantWhere(tenant),
      objectTypeId: attribute.objectTypeId,
      deletedAt: null,
      mergedIntoId: null,
      erasedAt: null,
      data: { path: [attribute.slug], not: Prisma.JsonNull },
    },
  })
}

function archivedMergedConfig(
  oldConfig: Prisma.JsonValue,
  newConfig: Prisma.InputJsonValue | typeof Prisma.JsonNull,
  referenced: ReadonlySet<string>,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  const next = options(newConfig)
  if (next.length === 0) return newConfig
  const nextIds = new Set(next.map((item) => item.id))
  const additions = options(oldConfig)
    .filter((item) => referenced.has(item.id) && !nextIds.has(item.id))
    .map((item) => ({ ...item, archived: true }))
  if (additions.length === 0) return newConfig
  return { ...asObject(newConfig), options: [...next, ...additions] }
}

function raisesPastInternal(
  oldSensitivity: AttributeRow['sensitivity'],
  newSensitivity: AttributeRow['sensitivity'] | undefined,
): boolean {
  if (newSensitivity === undefined) return false
  const rank = { public: 0, internal: 1, confidential: 2, restricted: 3 }
  return rank[oldSensitivity] <= rank.internal && rank[newSensitivity] > rank.internal
}

function toSearchChanges(attribute: AttributeRow, newConfig: Prisma.InputJsonValue | typeof Prisma.JsonNull): boolean {
  if (attribute.type === 'select' || attribute.type === 'status') {
    return optionSearchShape(attribute.config) !== optionSearchShape(newConfig)
  }
  return false
}

export async function prepareAttributeEvolution(
  tx: SchemaTx,
  tenant: TenantRef,
  attribute: AttributeRow,
  input: UpdateInput,
  parsedConfig: Prisma.InputJsonValue | typeof Prisma.JsonNull,
): Promise<PreparedAttributeEvolution> {
  if (attribute.type !== 'select' && attribute.type !== 'status') {
    const reindex = raisesPastInternal(attribute.sensitivity, input.sensitivity) || (
      input.config !== undefined && toSearchChanges(attribute, parsedConfig)
    )
    return { config: parsedConfig, keyRecompute: false, reindex }
  }
  const referenced = await referencedOptionIds(tx, tenant, attribute)
  const config = input.config === undefined
    ? parsedConfig
    : archivedMergedConfig(attribute.config, parsedConfig, referenced)
  const activeChanged = !sameStrings(activeIds(attribute.config), activeIds(config))
  const withValues = referenced.size
  if (activeChanged && withValues > 0 && input.recomputeKeys !== true) {
    throw conflict('key_recompute_required')
  }
  return {
    config,
    keyRecompute: activeChanged && withValues > 0,
    reindex: raisesPastInternal(attribute.sensitivity, input.sensitivity) || toSearchChanges(attribute, config),
  }
}

export async function enqueueAttributeEvolutionJobs(
  tx: SchemaTx,
  tenant: TenantRef,
  attribute: AttributeRow,
  actor: AuditActor,
  operation: 'update' | 'archive',
  evolution: Pick<PreparedAttributeEvolution, 'keyRecompute' | 'reindex'>,
): Promise<void> {
  if (evolution.keyRecompute) {
    await tx.queueJob.create({
      data: {
        ...tenantWhere(tenant),
        type: 'schema.key_recompute',
        priority: 50,
        payload: {
          organizationId: tenant.organizationId,
          teamId: tenant.teamId,
          objectTypeId: attribute.objectTypeId,
          attributeId: attribute.id,
        },
        idempotencyKey: `key-recompute:${tenant.teamId}:${attribute.id}:${operation}:${actor.requestId}`,
      },
    })
  }
  if (!evolution.reindex || await recordsWithValue(tx, tenant, attribute) === 0) return
  const records = await tx.record.findMany({
    where: {
      ...tenantWhere(tenant),
      objectTypeId: attribute.objectTypeId,
      deletedAt: null,
      mergedIntoId: null,
      erasedAt: null,
      data: { path: [attribute.slug], not: Prisma.JsonNull },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  for (const record of records) {
    await tx.queueJob.create({
      data: {
        ...tenantWhere(tenant),
        type: 'record.reindex',
        priority: 100,
        payload: { organizationId: tenant.organizationId, teamId: tenant.teamId, recordId: record.id },
        idempotencyKey: `schema-reindex:${tenant.teamId}:${attribute.id}:${record.id}:${operation}:${actor.requestId}`,
      },
    })
  }
}
