import { Prisma } from '@deepcrm/db'
import {
  AttributeDetail,
  ErrorCode,
  Filter as FilterSchema,
  ServiceError,
  type ActorContext,
  type Filter,
} from '@deepcrm/schemas'
import {
  rowAccess,
  type LoadedList,
  type LoadedSchema,
} from '@deepcrm/schema-engine'

import type { AppDeps } from '../deps.js'

type PublicAttribute = ReturnType<typeof presentAttribute>

export type DynamicListStatus = {
  list: string; object_type: string; filter: Record<string, unknown>; evaluation_version: number
  refresh_state: 'ready' | 'refreshing' | 'failed'; refresh_error_code: string | null; last_evaluated_at: string | null
}

export type ListDetail = {
  id: string; slug: string; name: string; description: string; object_type: string | null
  kind: 'static' | 'dynamic'; definition: DynamicListStatus | null; refresh_state: 'ready' | 'refreshing' | 'failed'
  refresh_error_code: string | null; last_evaluated_at: string | null
  attributes: PublicAttribute[]; entry_count: number
}

function failure(message: string): never {
  throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, message)
}

function presentAttribute(attribute: LoadedList['attributes'][number]) {
  return AttributeDetail.parse({
    id: attribute.id, slug: attribute.slug, name: attribute.name, description: attribute.description,
    type: attribute.type, config: attribute.config, is_multi: attribute.isMulti,
    is_required: attribute.isRequired, is_unique: attribute.isUnique, is_indexed: attribute.isIndexed,
    sensitivity: attribute.sensitivity, default_value: attribute.defaultValue ?? undefined,
    is_system: attribute.isSystem, position: attribute.position,
    value_source: 'stored',
    derivation: null,
    archived_at: attribute.archivedAt?.toISOString() ?? null,
  })
}

export function recordAccess(schema: LoadedSchema, ctx: ActorContext, list: LoadedList): Prisma.Sql {
  const selected = list.objectTypeId === null
    ? schema.objectTypes
    : schema.objectTypes.filter((objectType) => objectType.id === list.objectTypeId)
  if (selected.length === 0) {
    if (list.objectTypeId === null) return Prisma.sql`FALSE`
    failure('List object type is not active')
  }
  return Prisma.join(selected.map((objectType) => Prisma.sql`(${rowAccess(
    ctx.tenant, ctx, objectType,
  )})`), ' OR ')
}

export async function visibleEntryCount(
  deps: AppDeps, ctx: ActorContext, schema: LoadedSchema, list: LoadedList,
): Promise<number> {
  const rows = await deps.db.$queryRaw<Array<{ total: number }>>`
    SELECT count(*)::int AS total FROM list_entries le
    JOIN lists l ON l.id = le.list_id JOIN records r ON r.id = le.record_id
    WHERE l.id = ${list.id}::uuid AND l.organization_id = ${ctx.tenant.organizationId}::uuid
      AND l.team_id = ${ctx.tenant.teamId}::uuid AND r.erased_at IS NULL
      AND (${recordAccess(schema, ctx, list)})
  `
  return rows[0]?.total ?? 0
}

export function dynamicFilter(definition: unknown): Filter {
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    failure('Dynamic list definition is invalid')
  }
  return FilterSchema.parse(Object.fromEntries(Object.entries(definition)).filter)
}

export function dynamicStatus(schema: LoadedSchema, list: LoadedList): DynamicListStatus | null {
  if (list.kind !== 'dynamic') return null
  const objectType = list.objectTypeId === null ? undefined : schema.objectTypesById.get(list.objectTypeId)
  if (objectType === undefined) failure('Dynamic list object type is not active')
  return {
    list: list.slug, object_type: objectType.slug, filter: dynamicFilter(list.definition),
    evaluation_version: list.evaluationVersion, refresh_state: list.refreshState,
    refresh_error_code: list.refreshErrorCode, last_evaluated_at: list.lastEvaluatedAt?.toISOString() ?? null,
  }
}

export async function presentList(
  deps: AppDeps, ctx: ActorContext, schema: LoadedSchema, list: LoadedList,
): Promise<ListDetail> {
  const objectType = list.objectTypeId === null ? null : schema.objectTypesById.get(list.objectTypeId)
  if (list.objectTypeId !== null && objectType === undefined) failure('List object type is not active')
  return {
    id: list.id, slug: list.slug, name: list.name, description: list.description,
    kind: list.kind,
    object_type: objectType?.slug ?? null,
    definition: dynamicStatus(schema, list),
    refresh_state: list.refreshState,
    refresh_error_code: list.refreshErrorCode,
    last_evaluated_at: list.lastEvaluatedAt?.toISOString() ?? null,
    attributes: list.attributes.map(presentAttribute),
    entry_count: await visibleEntryCount(deps, ctx, schema, list),
  }
}
