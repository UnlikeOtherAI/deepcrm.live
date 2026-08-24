import { Prisma, type TenantRef } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'
import Decimal from 'decimal.js'

import { getAttributeType } from '../attribute-types/index.js'
import { qualityFilterPredicate } from '../quality/report.js'
import { canonicalJson, canonicalJsonValue, type JsonValue } from '../records/json.js'
import type { LoadedAttribute, LoadedObjectType, LoadedRelationType, LoadedSchema } from '../schema/load.js'
import { attributeReadAccess, rowAccess } from './access.js'
import type { QueryCursorState, QueryFilter, QueryInput, QueryOperator, QuerySort } from './types.js'

export type CompiledQuery = { sql: Prisma.Sql; countSql: Prisma.Sql }
export type RecordSetInput = {
  filter?: QueryFilter
  attributes?: readonly LoadedAttribute[]
}
type SortKey = {
  expression: Prisma.Sql
  direction: 'asc' | 'desc'
  attribute?: LoadedAttribute
  system?: 'created_at' | 'updated_at' | 'last_activity_at' | 'display_name'
}
const nullOps = new Set<QueryOperator>(['is_null', 'is_not_null'])
const manyOps = new Set<QueryOperator>(['in', 'not_in'])
const ordered = new Set<QueryOperator>(['gt', 'gte', 'lt', 'lte', 'between'])
const equality = new Set<QueryOperator>(['eq', 'neq', 'in', 'not_in'])

function failure(detail: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Invalid query filter', { detail })
}
function activeAttribute(schema: LoadedSchema, objectType: LoadedObjectType, slug: string): LoadedAttribute {
  const value = objectType.attributes.find((candidate) => candidate.slug === slug)
  if (value === undefined) {
    if (schema.archivedAttributeSlugsByObjectTypeId.get(objectType.id)?.has(slug)) failure('archived_attribute')
    failure('unknown_attribute')
  }
  if (value.archivedAt !== null) failure('archived_attribute')
  return value
}
function relation(schema: LoadedSchema, slug: string): LoadedRelationType {
  const value = schema.relationTypesBySlug.get(slug)
  if (value === undefined || value.archivedAt !== null) failure('unknown_relation')
  return value
}
function jsonParam(value: JsonValue): Prisma.Sql { return Prisma.sql`${canonicalJson(value)}::jsonb` }
function parsed(attribute: LoadedAttribute, value: unknown): JsonValue {
  const result = getAttributeType(attribute.type).valueSchema(attribute.config).safeParse(value)
  if (!result.success) failure('invalid_value')
  return canonicalJsonValue(result.data)
}
function stored(attribute: LoadedAttribute, value: unknown): JsonValue {
  if (!attribute.isMulti) return parsed(attribute, value)
  if (!Array.isArray(value)) failure('invalid_value')
  const values: JsonValue[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const parsedValue = parsed(attribute, item)
    const normalized = getAttributeType(attribute.type).normalize(item, attribute.config)
    const key = normalized ?? canonicalJson(parsedValue)
    if (seen.has(key)) continue
    seen.add(key)
    values.push(parsedValue)
  }
  return canonicalJsonValue(values)
}
function valueExpression(attribute: LoadedAttribute): Prisma.Sql {
  const key = attribute.slug
  switch (attribute.type) {
    case 'number': case 'percent': case 'rating': return Prisma.sql`(r.data ->> ${key})::numeric`
    case 'currency': return Prisma.sql`(r.data -> ${key} ->> 'amount')::numeric`
    case 'date': return Prisma.sql`(r.data ->> ${key})::date`
    case 'datetime': return Prisma.sql`(r.data ->> ${key})::timestamptz`
    case 'timestamp_system': {
      const config = attribute.config
      const source = typeof config === 'object' && config !== null && !Array.isArray(config) ? config['source'] : undefined
      if (source === 'created_at') return Prisma.sql`r.created_at`
      if (source === 'updated_at') return Prisma.sql`r.updated_at`
      if (source === 'last_activity_at') return Prisma.sql`r.last_activity_at`
      throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema metadata is inconsistent')
    }
    case 'boolean': return Prisma.sql`(r.data ->> ${key})::boolean`
    default: return Prisma.sql`r.data ->> ${key}`
  }
}
function objectExpression(attribute: LoadedAttribute): Prisma.Sql { return Prisma.sql`r.data -> ${attribute.slug}` }
function orderedValue(attribute: LoadedAttribute, value: JsonValue): Prisma.Sql {
  if (['number', 'percent', 'rating'].includes(attribute.type)) {
    if (typeof value !== 'string') failure('invalid_value')
    return Prisma.sql`${value}::numeric`
  }
  if (attribute.type === 'date') return Prisma.sql`${value}::date`
  if (attribute.type === 'datetime') return Prisma.sql`${value}::timestamptz`
  if (attribute.type === 'timestamp_system') return Prisma.sql`${value}::timestamp`
  if (attribute.type !== 'currency') return Prisma.sql`${value}`
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.amount !== 'string') {
    failure('invalid_value')
  }
  const config = attribute.config
  const fixed = typeof config === 'object' && config !== null && !Array.isArray(config) ? config['fixedCurrency'] : undefined
  if (typeof fixed !== 'string') failure('currency_filter')
  return Prisma.sql`${value.amount}::numeric`
}
function scalarValue(attribute: LoadedAttribute, value: JsonValue): Prisma.Sql {
  if (['number', 'percent', 'rating', 'currency', 'date', 'datetime', 'timestamp_system'].includes(attribute.type)) {
    return orderedValue(attribute, value)
  }
  if (attribute.type === 'boolean') return Prisma.sql`${value}::boolean`
  return Prisma.sql`${value}`
}
function orderedPair(attribute: LoadedAttribute, low: JsonValue, high: JsonValue): boolean {
  if (['number', 'percent', 'rating'].includes(attribute.type)) {
    if (typeof low !== 'string' || typeof high !== 'string') return false
    return new Decimal(low).lessThanOrEqualTo(new Decimal(high))
  }
  if (attribute.type === 'currency') {
    if (typeof low !== 'object' || low === null || Array.isArray(low) || typeof low.amount !== 'string') return false
    if (typeof high !== 'object' || high === null || Array.isArray(high) || typeof high.amount !== 'string') return false
    return new Decimal(low.amount).lessThanOrEqualTo(new Decimal(high.amount))
  }
  return String(low) <= String(high)
}
function compare(expression: Prisma.Sql, op: QueryOperator, value: Prisma.Sql): Prisma.Sql {
  switch (op) {
    case 'eq': return Prisma.sql`${expression} = ${value}`
    case 'neq': return Prisma.sql`${expression} <> ${value}`
    case 'gt': return Prisma.sql`${expression} > ${value}`
    case 'gte': return Prisma.sql`${expression} >= ${value}`
    case 'lt': return Prisma.sql`${expression} < ${value}`
    case 'lte': return Prisma.sql`${expression} <= ${value}`
    default: return Prisma.empty
  }
}
function textExpression(attribute: LoadedAttribute): Prisma.Sql {
  if (attribute.type === 'personal_name') return Prisma.sql`r.data -> ${attribute.slug} ->> 'full'`
  return valueExpression(attribute)
}
function parsedPersonalNameText(attribute: LoadedAttribute, value: unknown): string {
  const result = getAttributeType(attribute.type).valueSchema(attribute.config).safeParse(value)
  if (!result.success || typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) {
    failure('invalid_value')
  }
  const full = result.data['full']
  if (typeof full !== 'string') failure('invalid_value')
  return full
}
function textual(attribute: LoadedAttribute): boolean {
  return ['text', 'email', 'url', 'domain', 'registry_id', 'personal_name', 'select', 'status'].includes(attribute.type)
}
function refFilter(
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  attribute: LoadedAttribute,
  op: QueryOperator,
  value: unknown,
): Prisma.Sql {
  const backing = schema.resolveBackingRelation(objectType.slug, attribute.slug)
  if (backing === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema metadata is inconsistent')
  const ids = manyOps.has(op) ? (() => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) failure('array_arity')
    return value.map((item) => parsed(attribute, item))
  })() : [parsed(attribute, value)]
  const uuidIds = ids.map((id) => Prisma.sql`${id}::uuid`)
  const target = uuidIds.length === 1 ? Prisma.sql`l.to_record_id = ${uuidIds[0]}` : Prisma.sql`l.to_record_id IN (${Prisma.join(uuidIds)})`
  const exists = Prisma.sql`EXISTS (SELECT 1 FROM record_links l WHERE l.organization_id = r.organization_id AND l.team_id = r.team_id AND l.from_record_id = r.id AND l.relation_type_id = ${backing.id}::uuid AND l.active_until IS NULL AND ${target})`
  return op === 'neq' || op === 'not_in' ? Prisma.sql`NOT ${exists}` : exists
}
function attributeFilter(
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  filter: Extract<QueryFilter, { attribute: string }>,
): Prisma.Sql {
  const attribute = activeAttribute(schema, objectType, filter.attribute)
  const { op } = filter
  const hasValue = Object.hasOwn(filter, 'value')
  if (nullOps.has(op)) {
    if (hasValue) failure('null_arity')
    if (attribute.type === 'record_reference') {
      const backing = schema.resolveBackingRelation(objectType.slug, attribute.slug)
      if (backing === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema metadata is inconsistent')
      const exists = Prisma.sql`EXISTS (SELECT 1 FROM record_links l WHERE l.organization_id = r.organization_id AND l.team_id = r.team_id AND l.from_record_id = r.id AND l.relation_type_id = ${backing.id}::uuid AND l.active_until IS NULL)`
      return op === 'is_null' ? Prisma.sql`NOT ${exists}` : exists
    }
    const expression = attribute.type === 'timestamp_system'
      ? valueExpression(attribute)
      : objectExpression(attribute)
    return op === 'is_null' ? Prisma.sql`${expression} IS NULL` : Prisma.sql`${expression} IS NOT NULL`
  }
  if (!hasValue) failure('missing_value')
  if (!getAttributeType(attribute.type).filterOps.includes(op)) failure('unsupported_operator')
  if (ordered.has(op) && attribute.isMulti) failure('unsupported_operator')
  if (attribute.type === 'record_reference') return refFilter(schema, objectType, attribute, op, filter.value)
  if (attribute.type === 'json') failure('unsupported_operator')
  if (attribute.type === 'rich_text') {
    if (op !== 'contains' || typeof filter.value !== 'string') failure('unsupported_operator')
    return Prisma.sql`EXISTS (SELECT 1 FROM record_search rs WHERE rs.record_id = r.id AND rs.organization_id = r.organization_id AND rs.team_id = r.team_id AND rs.tsv @@ plainto_tsquery('simple', ${filter.value}))`
  }
  if (op === 'contains' || op === 'starts_with') {
    const value = attribute.type === 'personal_name' ? null : parsed(attribute, filter.value)
    const personalText = attribute.type === 'personal_name'
      ? parsedPersonalNameText(attribute, filter.value)
      : null
    if (attribute.isMulti) {
      const text = personalText ?? value
      const condition = attribute.type === 'personal_name'
        ? Prisma.sql`item ->> 'full' ILIKE ${op === 'contains' ? `%${text}%` : `${text}%`}`
        : typeof text === 'string' && op === 'starts_with'
          ? Prisma.sql`item #>> '{}' ILIKE ${`${text}%`}`
          : Prisma.sql`item = ${jsonParam(value)}`
      return Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${objectExpression(attribute)}) item WHERE ${condition})`
    }
    const text = personalText ?? value
    if (!textual(attribute) || typeof text !== 'string') failure('unsupported_operator')
    return op === 'contains'
      ? Prisma.sql`${textExpression(attribute)} ILIKE ${`%${text}%`}`
      : Prisma.sql`${textExpression(attribute)} ILIKE ${`${text}%`}`
  }
  if (manyOps.has(op)) {
    if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 100) failure('array_arity')
    const object = attribute.isMulti || ['currency', 'location', 'personal_name', 'actor_reference'].includes(attribute.type)
    const expression = object ? objectExpression(attribute) : valueExpression(attribute)
    const values = filter.value.map((item) => stored(attribute, item))
      .map((value) => object ? jsonParam(value) : scalarValue(attribute, value))
    return op === 'in' ? Prisma.sql`${expression} IN (${Prisma.join(values)})` : Prisma.sql`${expression} NOT IN (${Prisma.join(values)})`
  }
  if (op === 'between') {
    if (!Array.isArray(filter.value) || filter.value.length !== 2) failure('between_arity')
    const [low, high] = filter.value.map((item) => parsed(attribute, item))
    if (low === undefined || high === undefined) failure('between_arity')
    if (typeof low !== typeof high || !orderedPair(attribute, low, high)) failure('between_order')
    return Prisma.sql`${valueExpression(attribute)} BETWEEN ${orderedValue(attribute, low)} AND ${orderedValue(attribute, high)}`
  }
  const value = stored(attribute, filter.value)
  const object = !ordered.has(op)
    && (attribute.isMulti || ['currency', 'location', 'personal_name', 'actor_reference'].includes(attribute.type))
  const parameter = object ? jsonParam(value) : scalarValue(attribute, value)
  return compare(object ? objectExpression(attribute) : valueExpression(attribute), op, parameter)
}
function systemExpression(field: 'created_at' | 'updated_at' | 'last_activity_at' | 'display_name' | 'owner'): Prisma.Sql {
  switch (field) {
    case 'created_at': return Prisma.sql`r.created_at`
    case 'updated_at': return Prisma.sql`r.updated_at`
    case 'last_activity_at': return Prisma.sql`r.last_activity_at`
    case 'display_name': return Prisma.sql`r.display_name`
    case 'owner': return Prisma.sql`r.owner_id`
  }
}
function actor(value: unknown): value is { type: 'human' | 'agent'; id: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const type = Reflect.get(value, 'type'); const id = Reflect.get(value, 'id')
  return (type === 'human' || type === 'agent') && typeof id === 'string' && id.length > 0
}
function actorList(value: unknown, op: QueryOperator): Array<{ type: 'human' | 'agent'; id: string }> {
  if (!manyOps.has(op)) return actor(value) ? [value] : failure('invalid_value')
  if (!Array.isArray(value) || value.length === 0 || value.length > 100 || !value.every(actor)) failure('array_arity')
  return value
}
function systemFilter(filter: Extract<QueryFilter, { system: string }>): Prisma.Sql {
  const hasValue = Object.hasOwn(filter, 'value'); const { op } = filter
  if (nullOps.has(op)) {
    if (hasValue) failure('null_arity')
    const expression = filter.system === 'owner' ? Prisma.sql`r.owner_id` : systemExpression(filter.system)
    return op === 'is_null' ? Prisma.sql`${expression} IS NULL` : Prisma.sql`${expression} IS NOT NULL`
  }
  if (!hasValue) failure('missing_value')
  if (filter.system === 'owner') {
    if (!equality.has(op)) failure('unsupported_operator')
    const values = actorList(filter.value, op)
    const matches = Prisma.join(values.map(
      (value) => Prisma.sql`(r.owner_type = ${value.type}::"ActorType" AND r.owner_id = ${value.id})`,
    ), ' OR ')
    return op === 'neq' || op === 'not_in' ? Prisma.sql`NOT (${matches})` : Prisma.sql`(${matches})`
  }
  if (filter.system === 'display_name' && !equality.has(op) && op !== 'contains' && op !== 'starts_with') {
    failure('unsupported_operator')
  }
  const expression = systemExpression(filter.system)
  if (manyOps.has(op)) {
    if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 100 || !filter.value.every((value) => typeof value === 'string')) failure('array_arity')
    const values = filter.value.map((value) => systemValue(filter.system, value))
    return op === 'in' ? Prisma.sql`${expression} IN (${Prisma.join(values)})` : Prisma.sql`${expression} NOT IN (${Prisma.join(values)})`
  }
  if (op === 'between') {
    if (!Array.isArray(filter.value) || filter.value.length !== 2 || !filter.value.every((value) => typeof value === 'string')) failure('between_arity')
    const [low, high] = filter.value
    if (low === undefined || high === undefined || low > high) failure('between_order')
    return Prisma.sql`${expression} BETWEEN ${systemValue(filter.system, low)} AND ${systemValue(filter.system, high)}`
  }
  if (typeof filter.value !== 'string') failure('invalid_value')
  if (filter.system === 'display_name' && op === 'contains') return Prisma.sql`${expression} ILIKE ${`%${filter.value}%`}`
  if (filter.system === 'display_name' && op === 'starts_with') return Prisma.sql`${expression} ILIKE ${`${filter.value}%`}`
  if (!equality.has(op) && !ordered.has(op)) failure('unsupported_operator')
  return compare(expression, op, systemValue(filter.system, filter.value))
}
function systemValue(
  field: 'created_at' | 'updated_at' | 'last_activity_at' | 'display_name' | 'owner',
  value: string,
): Prisma.Sql {
  return field === 'display_name' ? Prisma.sql`${value}` : Prisma.sql`${value}::timestamp`
}
function linked(schema: LoadedSchema, filter: Extract<QueryFilter, { linked_to: object }>): Prisma.Sql {
  const input = filter.linked_to; const item = relation(schema, input.relation); const direction = input.direction ?? 'from'
  const selected = direction === 'from' ? Prisma.sql`l.from_record_id = r.id` : Prisma.sql`l.to_record_id = r.id`
  const other = direction === 'from' ? Prisma.sql`l.to_record_id = ${input.record_id}::uuid` : Prisma.sql`l.from_record_id = ${input.record_id}::uuid`
  return Prisma.sql`EXISTS (SELECT 1 FROM record_links l WHERE l.organization_id = r.organization_id AND l.team_id = r.team_id AND l.relation_type_id = ${item.id}::uuid AND l.active_until IS NULL AND ${selected} AND ${other})`
}
function nodeCount(filter: QueryFilter): number {
  if ('and' in filter) return 1 + filter.and.reduce((count, item) => count + nodeCount(item), 0)
  if ('or' in filter) return 1 + filter.or.reduce((count, item) => count + nodeCount(item), 0)
  return 'not' in filter ? 1 + nodeCount(filter.not) : 1
}
function filters(
  schema: LoadedSchema, objectType: LoadedObjectType, filter: QueryFilter,
  ctx: ActorContext, depth = 1,
): Prisma.Sql {
  if (depth > 8 || nodeCount(filter) > 100 || Buffer.byteLength(canonicalJson(filter), 'utf8') > 16_384) failure('filter_limit')
  if ('and' in filter) return filter.and.length === 0 ? failure('empty_logical') : Prisma.sql`(${Prisma.join(filter.and.map((item) => filters(schema, objectType, item, ctx, depth + 1)), ' AND ')})`
  if ('or' in filter) return filter.or.length === 0 ? failure('empty_logical') : Prisma.sql`(${Prisma.join(filter.or.map((item) => filters(schema, objectType, item, ctx, depth + 1)), ' OR ')})`
  if ('not' in filter) return Prisma.sql`NOT (${filters(schema, objectType, filter.not, ctx, depth + 1)})`
  if ('attribute' in filter) return attributeFilter(schema, objectType, filter)
  if ('system' in filter) return systemFilter(filter)
  if ('linked_to' in filter) return linked(schema, filter)
  if ('quality' in filter) return qualityFilterPredicate(ctx, schema, objectType, filter.quality)
  if ('text' in filter && typeof filter.text === 'string') return Prisma.sql`EXISTS (SELECT 1 FROM record_search rs WHERE rs.record_id = r.id AND rs.organization_id = r.organization_id AND rs.team_id = r.team_id AND rs.tsv @@ plainto_tsquery('simple', ${filter.text}))`
  return failure('unsupported_filter')
}
function filterAttributes(
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  filter: QueryFilter | undefined,
): LoadedAttribute[] {
  if (filter === undefined) return []
  if ('and' in filter) return filter.and.flatMap((item) => filterAttributes(schema, objectType, item))
  if ('or' in filter) return filter.or.flatMap((item) => filterAttributes(schema, objectType, item))
  if ('not' in filter) return filterAttributes(schema, objectType, filter.not)
  return 'attribute' in filter ? [activeAttribute(schema, objectType, filter.attribute)] : []
}
function sortKeys(schema: LoadedSchema, objectType: LoadedObjectType, sort: QuerySort | undefined): SortKey[] {
  const requested = sort ?? [{ system: 'created_at', direction: 'desc' }]
  if (requested.length === 0 || requested.length > 3) failure('sort_limit')
  const seen = new Set<string>()
  return requested.map((item) => {
    const direction = item.direction ?? 'asc'; const key = item.attribute === undefined ? `system:${item.system}` : `attribute:${item.attribute}`
    if (seen.has(key) || (item.attribute === undefined) === (item.system === undefined) || (direction !== 'asc' && direction !== 'desc')) failure('invalid_sort')
    seen.add(key)
    if (item.system !== undefined) {
      if (item.system === 'owner') failure('owner_sort')
      return { expression: systemExpression(item.system), direction, system: item.system }
    }
    if (item.attribute === undefined) failure('invalid_sort')
    const attribute = activeAttribute(schema, objectType, item.attribute)
    if (attribute.isMulti || ['json', 'record_reference', 'actor_reference', 'location', 'personal_name', 'rich_text'].includes(attribute.type)) failure('unsupported_sort')
    if (attribute.type === 'currency') {
      const config = attribute.config; const fixed = typeof config === 'object' && config !== null && !Array.isArray(config) ? config['fixedCurrency'] : undefined
      if (typeof fixed !== 'string') failure('currency_sort')
    }
    return { expression: valueExpression(attribute), direction, attribute }
  })
}
function cursorValue(key: SortKey, value: JsonValue): Prisma.Sql {
  if (typeof value !== 'string') failure('cursor_type')
  if (['number', 'percent', 'rating', 'currency'].includes(key.attribute?.type ?? '') && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) failure('cursor_type')
  if (['number', 'percent', 'rating', 'currency'].includes(key.attribute?.type ?? '')) return Prisma.sql`${value}::numeric`
  if (key.attribute?.type === 'date') return Prisma.sql`${value}::date`
  if (key.attribute?.type === 'datetime') return Prisma.sql`${value}::timestamptz`
  if (key.attribute?.type === 'timestamp_system') return Prisma.sql`${value}::timestamp`
  if (key.system !== undefined && key.system !== 'display_name') return Prisma.sql`${value}::timestamp`
  return Prisma.sql`${value}`
}
function afterPredicate(keys: readonly SortKey[], after: QueryCursorState | undefined): Prisma.Sql {
  if (after === undefined) return Prisma.empty
  if (after.values.length !== keys.length || !/^[0-9a-f-]{36}$/iu.test(after.id)) failure('cursor_type')
  const clauses: Prisma.Sql[] = []
  for (const [index, key] of keys.entries()) {
    const prefix = keys.slice(0, index).map((prior, position) => {
      const value = after.values[position]; if (value === undefined || typeof value.isNull !== 'boolean') failure('cursor_type')
      return value.isNull ? Prisma.sql`${prior.expression} IS NULL` : Prisma.sql`${prior.expression} IS NOT NULL AND ${prior.expression} = ${cursorValue(prior, value.value)}`
    })
    const value = after.values[index]; if (value === undefined || typeof value.isNull !== 'boolean') failure('cursor_type')
    const laterNull = value.isNull ? Prisma.sql`false` : Prisma.sql`${key.expression} IS NULL`
    const cmp = value.isNull ? Prisma.sql`false` : Prisma.sql`${key.expression} ${Prisma.raw(key.direction === 'asc' ? '>' : '<')} ${cursorValue(key, value.value)}`
    const prior = prefix.length === 0 ? Prisma.empty : Prisma.sql`${Prisma.join(prefix, ' AND ')} AND `
    clauses.push(Prisma.sql`(${prior}(${laterNull} OR (${key.expression} IS NOT NULL AND ${cmp})))`)
  }
  const same = keys.map((key, index) => {
    const value = after.values[index]; if (value === undefined || typeof value.isNull !== 'boolean') failure('cursor_type')
    return value.isNull ? Prisma.sql`${key.expression} IS NULL` : Prisma.sql`${key.expression} = ${cursorValue(key, value.value)}`
  })
  const direction = keys.at(-1)?.direction; if (direction === undefined) failure('cursor_type')
  clauses.push(Prisma.sql`(${Prisma.join(same, ' AND ')} AND r.id ${Prisma.raw(direction === 'asc' ? '>' : '<')} ${after.id}::uuid)`)
  return Prisma.sql` AND (${Prisma.join(clauses, ' OR ')})`
}
function order(keys: readonly SortKey[]): Prisma.Sql {
  const items = keys.map((key) => Prisma.sql`${key.expression} ${Prisma.raw(key.direction.toUpperCase())} NULLS LAST`)
  const direction = keys.at(-1)?.direction; if (direction === undefined) failure('invalid_sort')
  items.push(Prisma.sql`r.id ${Prisma.raw(direction.toUpperCase())}`)
  return Prisma.join(items, ', ')
}
function cursorSelect(keys: readonly SortKey[]): Prisma.Sql {
  const values = keys.map((key) => Prisma.sql`jsonb_build_object('isNull', ${key.expression} IS NULL, 'value', CASE WHEN ${key.expression} IS NULL THEN NULL ELSE to_jsonb(${key.expression}::text) END)`)
  return Prisma.sql`jsonb_build_array(${Prisma.join(values)}) AS "cursorValues"`
}

/** Shared visibility, policy, attribute-access, and filter predicate for record-set queries. */
export function compileRecordSet(
  tenant: TenantRef,
  ctx: ActorContext,
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  input: RecordSetInput,
): Prisma.Sql {
  const attributes = new Map<string, LoadedAttribute>()
  for (const attribute of filterAttributes(schema, objectType, input.filter)) {
    attributes.set(attribute.id, attribute)
  }
  for (const attribute of input.attributes ?? []) {
    if (attribute.objectTypeId !== objectType.id || attribute.archivedAt !== null) {
      throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Query attribute does not belong to object type')
    }
    attributes.set(attribute.id, attribute)
  }
  const filter = input.filter === undefined
    ? Prisma.empty
    : Prisma.sql` AND ${filters(schema, objectType, input.filter, ctx)}`
  return Prisma.sql`${rowAccess(tenant, ctx, objectType)}${
    attributeReadAccess(tenant, ctx, objectType, [...attributes.values()])
  }${filter}`
}

export function compileQuery(
  tenant: TenantRef,
  ctx: ActorContext,
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  input: QueryInput,
): CompiledQuery {
  if (tenant.organizationId !== ctx.tenant.organizationId || tenant.teamId !== ctx.tenant.teamId) throw new ServiceError(ErrorCode.TENANT_MISMATCH, 'Tenant does not match actor context')
  const limit = input.limit ?? 50; if (!Number.isInteger(limit) || limit < 1 || limit > 500) failure('limit')
  const keys = sortKeys(schema, objectType, input.sort)
  const base = compileRecordSet(tenant, ctx, schema, objectType, {
    ...(input.filter === undefined ? {} : { filter: input.filter }),
    attributes: keys.flatMap((key) => key.attribute === undefined ? [] : [key.attribute]),
  })
  const fields = Prisma.sql`r.id, r.object_type_id AS "objectTypeId", r.data, r.display_name AS "displayName", r.owner_type AS "ownerType", r.owner_id AS "ownerId", r.visibility, r.created_on_behalf_of AS "createdOnBehalfOf", r.origin, r.version, r.last_activity_at AS "lastActivityAt", r.created_at AS "createdAt", r.updated_at AS "updatedAt"`
  return { sql: Prisma.sql`SELECT ${fields}, ${cursorSelect(keys)} FROM records r WHERE ${base}${afterPredicate(keys, input.after)} ORDER BY ${order(keys)} LIMIT ${limit + 1}`, countSql: Prisma.sql`SELECT count(*)::int AS total FROM records r WHERE ${base}` }
}
