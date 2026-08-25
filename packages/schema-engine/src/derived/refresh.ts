import Decimal from 'decimal.js'

import { Prisma, tenantWhere, type Db, type TenantRef } from '@deepcrm/db'
import { ErrorCode, Filter as FilterSchema, ServiceError, type Filter } from '@deepcrm/schemas'

import { getAttributeType } from '../attribute-types/index.js'
import { canonicalJson, canonicalJsonValue, type JsonValue } from '../records/json.js'
import { computeDisplayName } from '../records/display-name.js'
import { loadSchema, type LoadedAttribute, type LoadedObjectType, type LoadedSchema } from '../schema/load.js'
import { parseDerivedConfig, type FormulaExpression } from './contracts.js'

export type DerivedRefreshResult = {
  records: number
  attributes: number
  changedRecords: readonly string[]
}

type Data = Record<string, JsonValue>
type DerivedAttribute = LoadedAttribute & { derivation: NonNullable<LoadedAttribute['derivation']> }
type LinkedRecord = { id: string; data: unknown; createdAt: Date; deletedAt: Date | null; mergedIntoId: string | null; erasedAt: Date | null }
type Related = { id: string; data: Data; createdAt: Date }

function objectFields(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value))
}

function data(value: unknown): Data {
  const parsed = canonicalJsonValue(value)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Stored record data is invalid')
  }
  return parsed
}

function inputJson(value: JsonValue): Prisma.InputJsonValue | null {
  if (value === null) return null
  if (Array.isArray(value)) return value.map((item) => inputJson(item))
  if (typeof value !== 'object') return value
  const result: { [key: string]: Prisma.InputJsonValue | null } = {}
  for (const [key, child] of Object.entries(value)) result[key] = inputJson(child)
  return result
}

function inputObject(value: Data): Prisma.InputJsonObject {
  const result: { [key: string]: Prisma.InputJsonValue | null } = {}
  for (const [key, child] of Object.entries(value)) result[key] = inputJson(child)
  return result
}

function derivedAttributes(objectType: LoadedObjectType): DerivedAttribute[] {
  return objectType.attributes.filter((attribute): attribute is DerivedAttribute => (
    attribute.archivedAt === null && attribute.derivation !== null && attribute.derivation !== undefined
  ))
}

function validate(attribute: LoadedAttribute, value: unknown): JsonValue | null {
  if (value === null) return null
  const parsed = getAttributeType(attribute.type).valueSchema(attribute.config).safeParse(value)
  if (!parsed.success) throw new Error('invalid_derived_value')
  return canonicalJsonValue(parsed.data)
}

function number(value: unknown): Decimal | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Decimal(value)
  if (typeof value === 'string') {
    try { return new Decimal(value) } catch { return null }
  }
  const fields = objectFields(value)
  if (fields !== null) {
    const amount = fields['amount']
    if (typeof amount !== 'string') return null
    try { return new Decimal(amount) } catch { return null }
  }
  return null
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function dateValue(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function compare(left: unknown, right: unknown): number | null {
  const leftNumber = number(left)
  const rightNumber = number(right)
  if (leftNumber !== null && rightNumber !== null) return leftNumber.comparedTo(rightNumber)
  const leftText = text(left)
  const rightText = text(right)
  if (leftText === null || rightText === null) return null
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0
}

function evalFormula(expression: FormulaExpression, source: Data, now: Date): unknown {
  if (expression.kind === 'literal') return expression.value
  if (expression.kind === 'attribute') return source[expression.attribute] ?? null
  if (expression.kind === 'binary') {
    const left = evalFormula(expression.left, source, now)
    const right = evalFormula(expression.right, source, now)
    if (left === null || right === null) return null
    if (expression.op === 'concat') return `${text(left) ?? ''}${text(right) ?? ''}`
    if (['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(expression.op)) {
      const compared = compare(left, right)
      if (compared === null) return null
      if (expression.op === 'eq') return compared === 0
      if (expression.op === 'neq') return compared !== 0
      if (expression.op === 'gt') return compared > 0
      if (expression.op === 'gte') return compared >= 0
      if (expression.op === 'lt') return compared < 0
      return compared <= 0
    }
    const leftNumber = number(left)
    const rightNumber = number(right)
    if (leftNumber === null || rightNumber === null) return null
    if (expression.op === 'add') return leftNumber.plus(rightNumber).toNumber()
    if (expression.op === 'subtract') return leftNumber.minus(rightNumber).toNumber()
    if (expression.op === 'multiply') return leftNumber.times(rightNumber).toNumber()
    if (rightNumber.isZero()) return null
    return leftNumber.div(rightNumber).toNumber()
  }
  const values = expression.args.map((arg) => evalFormula(arg, source, now))
  if (expression.name === 'coalesce') return values.find((value) => value !== null) ?? null
  const first = values[0] ?? null
  if (expression.name === 'lower') return text(first)?.toLowerCase() ?? null
  if (expression.name === 'upper') return text(first)?.toUpperCase() ?? null
  if (expression.name === 'length') return text(first)?.length ?? null
  const date = dateValue(first)
  if (date === null) return null
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000)
}

function opMatches(actual: unknown, op: string, expected: unknown): boolean {
  if (op === 'exists') return actual !== undefined && actual !== null
  if (op === 'not_exists') return actual === undefined || actual === null
  if (actual === undefined) return op === 'neq'
  if (op === 'eq') return canonicalJson(actual) === canonicalJson(expected)
  if (op === 'neq') return canonicalJson(actual) !== canonicalJson(expected)
  if (op === 'in') return Array.isArray(expected) && expected.some((item) => canonicalJson(item) === canonicalJson(actual))
  if (op === 'not_in') return Array.isArray(expected) && expected.every((item) => canonicalJson(item) !== canonicalJson(actual))
  const compared = compare(actual, expected)
  if (compared === null) return false
  if (op === 'gt') return compared > 0
  if (op === 'gte') return compared >= 0
  if (op === 'lt') return compared < 0
  if (op === 'lte') return compared <= 0
  if (op === 'contains') return text(actual)?.includes(String(expected)) ?? false
  if (op === 'starts_with') return text(actual)?.startsWith(String(expected)) ?? false
  return false
}

function condition(value: unknown): { op: string; expected: unknown } | null {
  const fields = objectFields(value)
  if (fields === null) return null
  const op = fields['op']
  if (typeof op !== 'string') return null
  return { op, expected: fields['value'] }
}

function systemValue(record: Related, field: string): unknown {
  if (field === 'created_at') return record.createdAt.toISOString()
  if (field === 'updated_at' || field === 'last_activity_at' || field === 'display_name' || field === 'owner') return null
  return null
}

function matchesFilter(record: Related, filter: Filter): boolean {
  if ('and' in filter) return filter.and.every((child) => matchesFilter(record, child))
  if ('or' in filter) return filter.or.some((child) => matchesFilter(record, child))
  if ('not' in filter) return !matchesFilter(record, filter.not)
  if ('attribute' in filter) {
    const actual = record.data[filter.attribute]
    if (filter.op === 'is_null') return actual === undefined || actual === null
    if (filter.op === 'is_not_null') return actual !== undefined && actual !== null
    return opMatches(actual, filter.op, filter.value)
  }
  if ('system' in filter) {
    const actual = systemValue(record, filter.system)
    if (filter.op === 'is_null') return actual === undefined || actual === null
    if (filter.op === 'is_not_null') return actual !== undefined && actual !== null
    return opMatches(actual, filter.op, filter.value)
  }
  return false
}

function parsedFilter(value: unknown): Filter | undefined {
  if (value === undefined) return undefined
  return FilterSchema.parse(value)
}

async function relatedRecords(
  db: Db,
  tenant: TenantRef,
  recordId: string,
  relationTypeId: string,
  direction: 'outgoing' | 'incoming',
): Promise<Related[]> {
  const links = await db.recordLink.findMany({
    where: {
      ...tenantWhere(tenant),
      relationTypeId,
      activeUntil: null,
      ...(direction === 'outgoing' ? { fromRecordId: recordId } : { toRecordId: recordId }),
    },
    select: {
      toRecord: { select: { id: true, data: true, createdAt: true, deletedAt: true, mergedIntoId: true, erasedAt: true } },
      fromRecord: { select: { id: true, data: true, createdAt: true, deletedAt: true, mergedIntoId: true, erasedAt: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return links.flatMap((link) => {
    const record: LinkedRecord = direction === 'outgoing' ? link.toRecord : link.fromRecord
    if (record.deletedAt !== null || record.mergedIntoId !== null || record.erasedAt !== null) return []
    return [{ id: record.id, data: data(record.data), createdAt: record.createdAt }]
  })
}

function aggregate(values: readonly JsonValue[], operation: string, target: LoadedAttribute): unknown {
  if (operation === 'count') return values.length
  if (values.length === 0) return null
  if (operation === 'sum' || operation === 'average') {
    const numbers = values.map(number).filter((item): item is Decimal => item !== null)
    if (numbers.length !== values.length) return null
    const total = numbers.reduce((sum, item) => sum.plus(item ?? 0), new Decimal(0))
    const result = operation === 'average' ? total.div(values.length) : total
    if (target.type !== 'currency') return result.toNumber()
    const first = values[0]
    const currency = objectFields(first)?.['currency'] ?? null
    return typeof currency === 'string' ? { amount: result.toFixed(2), currency } : null
  }
  const sorted = [...values].sort((left, right) => compare(left, right) ?? 0)
  if (operation === 'min' || operation === 'earliest_date') return sorted[0] ?? null
  return sorted.at(-1) ?? null
}

async function computeDerived(
  db: Db,
  tenant: TenantRef,
  attribute: DerivedAttribute,
  source: Data,
  recordId: string,
  now: Date,
): Promise<JsonValue | null> {
  if (attribute.derivation.valueSource === 'stored' || attribute.derivation.valueSource === 'system') {
    throw new Error('invalid_derived_source')
  }
  const definition = parseDerivedConfig(attribute.derivation.valueSource, attribute.derivation.config)
  if (definition.value_source === 'formula') {
    return validate(attribute, evalFormula(definition.config.expression, source, now))
  }
  if (definition.value_source === 'score') {
    let score = new Decimal(0)
    for (const criterion of definition.config.criteria) {
      const match = condition(criterion.when)
      if (match !== null && opMatches(source[criterion.attribute], match.op, match.expected)) {
        score = score.plus(criterion.weight)
      }
    }
    if (definition.config.time_decay !== undefined) {
      const date = dateValue(source[definition.config.time_decay.attribute])
      if (date !== null) {
        const ageDays = Math.max(0, (now.getTime() - date.getTime()) / 86_400_000)
        score = score.times(Decimal.pow(0.5, ageDays / definition.config.time_decay.half_life_days))
      }
    }
    return validate(attribute, score.toNumber())
  }
  const dependency = attribute.derivation.dependencies.find((item) => item.relationTypeId !== null)
  if (dependency?.relationTypeId === undefined || dependency.relationTypeId === null) throw new Error('missing_relation_dependency')
  const direction = definition.config.direction
  const related = await relatedRecords(db, tenant, recordId, dependency.relationTypeId, direction)
  if (definition.value_source === 'relation_sync') {
    if (related.length > 1 && definition.config.on_multiple === 'error') throw new Error('relation_sync_multiple')
    const selected = related[0]
    return validate(attribute, selected?.data[definition.config.source_attribute] ?? null)
  }
  const filter = parsedFilter(definition.config.filter)
  const filtered = filter === undefined ? related : related.filter((record) => matchesFilter(record, filter))
  if (definition.config.operation === 'count') return validate(attribute, filtered.length)
  const sourceAttribute = definition.config.source_attribute
  if (sourceAttribute === undefined) throw new Error('missing_source_attribute')
  const values = filtered.flatMap((record) => {
    const value = record.data[sourceAttribute]
    return value === undefined || value === null ? [] : [value]
  })
  return validate(attribute, aggregate(values, definition.config.operation, attribute))
}

async function impactedRecords(
  db: Db,
  tenant: TenantRef,
  schema: LoadedSchema,
  sourceRecordIds: readonly string[],
): Promise<string[]> {
  const result = new Set(sourceRecordIds)
  const relationIds = new Set<string>()
  for (const objectType of schema.objectTypes) {
    for (const attribute of derivedAttributes(objectType)) {
      for (const dependency of attribute.derivation.dependencies) {
        if (dependency.relationTypeId !== null) relationIds.add(dependency.relationTypeId)
      }
    }
  }
  for (const relationTypeId of relationIds) {
    const links = await db.recordLink.findMany({
      where: {
        ...tenantWhere(tenant),
        relationTypeId,
        activeUntil: null,
        OR: [{ fromRecordId: { in: [...sourceRecordIds] } }, { toRecordId: { in: [...sourceRecordIds] } }],
      },
      select: { fromRecordId: true, toRecordId: true },
    })
    for (const link of links) {
      result.add(link.fromRecordId)
      result.add(link.toRecordId)
    }
  }
  return [...result].sort()
}

export async function refreshDerivedFromSources(
  db: Db,
  tenant: TenantRef,
  sourceRecordIds: readonly string[],
  now: Date,
): Promise<DerivedRefreshResult> {
  const uniqueSources = [...new Set(sourceRecordIds)].sort()
  if (uniqueSources.length === 0) return { records: 0, attributes: 0, changedRecords: [] }
  const schema = await loadSchema(db, tenant)
  const recordIds = await impactedRecords(db, tenant, schema, uniqueSources)
  const records = await db.record.findMany({
    where: { ...tenantWhere(tenant), id: { in: recordIds }, deletedAt: null, mergedIntoId: null, erasedAt: null },
    select: { id: true, objectTypeId: true, data: true },
    orderBy: { id: 'asc' },
  })
  const changedRecords = new Set<string>()
  let attributes = 0
  for (const record of records) {
    const objectType = schema.objectTypesById.get(record.objectTypeId)
    if (objectType === undefined) continue
    const current = data(record.data)
    const next: Data = { ...current }
    for (const attribute of derivedAttributes(objectType)) {
      await db.attributeDerivation.update({
        where: { attributeId: attribute.id },
        data: { refreshState: 'refreshing', refreshErrorCode: null },
      })
      try {
        const value = await computeDerived(db, tenant, attribute, next, record.id, now)
        if (value === null) delete next[attribute.slug]
        else next[attribute.slug] = value
        await db.attributeDerivation.update({
          where: { attributeId: attribute.id },
          data: { refreshState: 'ready', refreshErrorCode: null, lastRefreshedAt: now },
        })
        attributes += 1
      } catch (error: unknown) {
        await db.attributeDerivation.update({
          where: { attributeId: attribute.id },
          data: { refreshState: 'failed', refreshErrorCode: error instanceof Error ? error.message : 'refresh_failed' },
        })
      }
    }
    if (canonicalJson(current) === canonicalJson(next)) continue
    await db.record.updateMany({
      where: { ...tenantWhere(tenant), id: record.id },
      data: {
        data: inputObject(next),
        displayName: computeDisplayName(schema, objectType, next),
        version: { increment: 1 },
      },
    })
    changedRecords.add(record.id)
  }
  return { records: records.length, attributes, changedRecords: [...changedRecords].sort() }
}
