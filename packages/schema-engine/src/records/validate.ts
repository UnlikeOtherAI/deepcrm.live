import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import { getAttributeType } from '../attribute-types/index.js'
import type { LoadedAttribute, LoadedObjectType, LoadedSchema } from '../schema/load.js'
import { canonicalJson, canonicalJsonValue, type JsonValue } from './json.js'
import type { LinkIntent, ValidatedRecordData, ValidationIssue } from './types.js'

const MAX_RECORD_DATA_BYTES = 256 * 1024
const reservedVirtualSlugs = new Set(['id', 'created_at', 'updated_at', 'last_activity_at', 'display_name', 'owner'])
type Mode = 'create' | 'update'
type Entry = readonly [string, unknown]
type GuardVisibility = 'team' | 'users' | 'private'

export type WriteGuard = {
  rejectedOrigins: readonly string[]
  requireOrigin: boolean
  teamVisibilityOnlyApps: readonly string[]
}

export type WriteGuardInput = {
  app: string
  origin: string | undefined
  currentOrigin: string | null
  visibility: GuardVisibility | undefined
  visibleTo: readonly string[] | undefined
  currentVisibility: GuardVisibility
}

function pointer(slug: string): string { return `/${slug.replace(/~/gu, '~0').replace(/\//gu, '~1')}` }

function fail(issues: ValidationIssue[]): never {
  const sorted = [...issues].sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1
    return left.message < right.message ? -1 : left.message > right.message ? 1 : 0
  })
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Record data validation failed', { issues: sorted })
}

export function validateWriteGuard(guard: WriteGuard, input: WriteGuardInput): void {
  const origin = input.origin ?? input.currentOrigin
  if (origin === null && guard.requireOrigin) {
    throw new ServiceError(ErrorCode.ORIGIN_REJECTED, 'Origin is required', { origin: null })
  }
  if (origin !== null && guard.rejectedOrigins.includes(origin)) {
    throw new ServiceError(ErrorCode.ORIGIN_REJECTED, 'Origin is rejected', { origin })
  }
  const visibility = input.visibleTo === undefined ? input.visibility ?? input.currentVisibility : 'users'
  if (visibility !== 'team' && guard.teamVisibilityOnlyApps.includes(input.app)) {
    throw new ServiceError(ErrorCode.VISIBILITY_REJECTED, 'Visibility is rejected')
  }
}

function invalidAttribute(
  code: typeof ErrorCode.UNKNOWN_ATTRIBUTE | typeof ErrorCode.ATTRIBUTE_ARCHIVED | typeof ErrorCode.ATTRIBUTE_READ_ONLY,
  slug: string,
): never {
  const message = code === ErrorCode.UNKNOWN_ATTRIBUTE
    ? 'Attribute is not active in this tenant'
    : code === ErrorCode.ATTRIBUTE_ARCHIVED ? 'Attribute is archived' : 'Attribute is read-only'
  throw new ServiceError(code, message, { attribute: slug })
}

function virtual(attribute: LoadedAttribute): boolean {
  return reservedVirtualSlugs.has(attribute.slug) || attribute.type === 'timestamp_system'
}

function issue(issues: ValidationIssue[], path: string, message: string): void {
  if (!issues.some((existing) => existing.path === path && existing.message === message)) {
    issues.push({ path, message })
  }
}

function invalid(issues: ValidationIssue[], slug: string): void {
  issue(issues, pointer(slug), 'Invalid attribute value')
}

function safeEntries(value: Record<string, unknown>, issues: ValidationIssue[]): Entry[] | undefined {
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      issue(issues, '', 'Invalid record data')
      return undefined
    }
    const entries: Entry[] = []
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        issue(issues, '', 'Invalid record data')
        return undefined
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        issue(issues, '', 'Invalid record data')
        return undefined
      }
      entries.push([key, descriptor.value])
    }
    return entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  } catch {
    issue(issues, '', 'Invalid record data')
    return undefined
  }
}

function parse(attribute: LoadedAttribute, value: unknown, issues: ValidationIssue[]): JsonValue | undefined {
  try {
    const result = getAttributeType(attribute.type).valueSchema(attribute.config).safeParse(value)
    if (!result.success) {
      invalid(issues, attribute.slug)
      return undefined
    }
    const serialized = JSON.stringify(result.data)
    if (serialized === undefined) throw new ServiceError(ErrorCode.INTERNAL, 'Attribute result is not JSON')
    return canonicalJsonValue(JSON.parse(serialized))
  } catch {
    invalid(issues, attribute.slug)
    return undefined
  }
}

function deduplicate(
  attribute: LoadedAttribute,
  values: JsonValue[],
  issues: ValidationIssue[],
): JsonValue[] | undefined {
  const definition = getAttributeType(attribute.type)
  const seen = new Set<string>()
  const result: JsonValue[] = []
  for (const value of values) {
    let key: string
    try {
      const normalized = definition.normalize(value, attribute.config)
      key = normalized === null ? `canonical:${canonicalJson(value)}` : `normalized:${normalized}`
    } catch {
      invalid(issues, attribute.slug)
      return undefined
    }
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function intent(
  schema: LoadedSchema, objectType: LoadedObjectType, attribute: LoadedAttribute, targetIds: string[],
): LinkIntent {
  const relation = schema.resolveBackingRelation(objectType.slug, attribute.slug)
  if (relation === undefined) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema metadata is inconsistent', { detail: 'missing_backing_relation' })
  }
  const cardinality = attribute.isMulti ? 'many_to_many' : 'many_to_one'
  if (relation.cardinality !== cardinality) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema metadata is inconsistent', { detail: 'invalid_backing_relation' })
  }
  return { kind: 'record_reference', attributeSlug: attribute.slug, relationTypeId: relation.id, cardinality, targetIds }
}

function reference(
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  attribute: LoadedAttribute,
  value: unknown,
  issues: ValidationIssue[],
): LinkIntent | undefined {
  if (value === null) {
    if (attribute.isRequired) {
      invalid(issues, attribute.slug)
      return undefined
    }
    return intent(schema, objectType, attribute, [])
  }
  if (!attribute.isMulti && Array.isArray(value)) { invalid(issues, attribute.slug); return undefined }
  if (attribute.isMulti && !Array.isArray(value)) { invalid(issues, attribute.slug); return undefined }
  if (attribute.isMulti && Array.isArray(value) && value.length === 0) {
    if (attribute.isRequired) {
      invalid(issues, attribute.slug)
      return undefined
    }
    return intent(schema, objectType, attribute, [])
  }
  const rawValues: unknown[] = Array.isArray(value) ? value : [value]
  const parsed = rawValues.map((raw) => parse(attribute, raw, issues))
  if (parsed.some((item) => item === undefined)) return undefined
  const unique = deduplicate(
    attribute,
    parsed.filter((item): item is JsonValue => item !== undefined),
    issues,
  )
  if (unique === undefined) return undefined
  const targetIds = unique.map((item) => {
    if (typeof item !== 'string') throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema metadata is inconsistent', { detail: 'invalid_record_reference_value' })
    return item
  })
  return intent(schema, objectType, attribute, targetIds)
}

function stored(
  attribute: LoadedAttribute, value: unknown, data: Record<string, JsonValue>, issues: ValidationIssue[],
): void {
  if (value === null) {
    if (attribute.isRequired) invalid(issues, attribute.slug)
    else delete data[attribute.slug]
    return
  }
  if (!attribute.isMulti && Array.isArray(value)) { invalid(issues, attribute.slug); return }
  if (attribute.isMulti && !Array.isArray(value)) { invalid(issues, attribute.slug); return }
  if (attribute.isMulti) {
    const rawValues: unknown[] = Array.isArray(value) ? value : []
    const parsed = rawValues.map((raw) => parse(attribute, raw, issues))
    if (parsed.some((item) => item === undefined)) return
    const unique = deduplicate(
      attribute,
      parsed.filter((item): item is JsonValue => item !== undefined),
      issues,
    )
    if (unique !== undefined) data[attribute.slug] = unique
    return
  }
  const parsed = parse(attribute, value, issues)
  if (parsed !== undefined) data[attribute.slug] = parsed
}

function canonicalData(
  value: Record<string, unknown>,
  issues: ValidationIssue[],
): Record<string, JsonValue> | undefined {
  try {
    const data = canonicalJsonValue(value)
    if (data === null || Array.isArray(data) || typeof data !== 'object') {
      issue(issues, '', 'Invalid record data')
      return undefined
    }
    return data
  } catch {
    issue(issues, '', 'Invalid record data')
    return undefined
  }
}

function currentRecordData(
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  currentData: Record<string, unknown>,
  issues: ValidationIssue[],
): Record<string, JsonValue> | undefined {
  const data = canonicalData(currentData, issues)
  if (data === undefined) return undefined
  const attributes = schema.attributesByObjectTypeId.get(objectType.id)
  const archived = schema.archivedAttributeSlugsByObjectTypeId.get(objectType.id)
  for (const slug of Object.keys(data).sort()) {
    if (archived?.has(slug) === true) continue
    const attribute = attributes?.get(slug)
    if (
      reservedVirtualSlugs.has(slug) ||
      attribute === undefined ||
      attribute.type === 'record_reference' ||
      virtual(attribute)
    ) invalid(issues, slug)
  }
  return data
}

export function validateRecordData(
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  currentData: Record<string, unknown>,
  patch: Record<string, unknown>,
  mode: Mode,
): ValidatedRecordData {
  const issues: ValidationIssue[] = []
  const data = mode === 'create' ? {} : currentRecordData(schema, objectType, currentData, issues)
  if (data === undefined || issues.length > 0) fail(issues)
  const attributes = new Map(objectType.attributes.map((attribute) => [attribute.slug, attribute]))
  const patchEntries = safeEntries(patch, issues)
  if (patchEntries === undefined || issues.length > 0) fail(issues)
  const values = new Map<string, unknown>(patchEntries)
  const linkOps: LinkIntent[] = []
  for (const [slug] of values) {
    if (reservedVirtualSlugs.has(slug)) invalidAttribute(ErrorCode.ATTRIBUTE_READ_ONLY, slug)
    const attribute = attributes.get(slug)
    if (attribute === undefined) {
      if (schema.archivedAttributeSlugsByObjectTypeId.get(objectType.id)?.has(slug) === true) {
        invalidAttribute(ErrorCode.ATTRIBUTE_ARCHIVED, slug)
      }
      invalidAttribute(ErrorCode.UNKNOWN_ATTRIBUTE, slug)
    }
    if (attribute.archivedAt !== null) invalidAttribute(ErrorCode.ATTRIBUTE_ARCHIVED, slug)
    if (virtual(attribute)) invalidAttribute(ErrorCode.ATTRIBUTE_READ_ONLY, slug)
  }
  if (mode === 'create') for (const attribute of objectType.attributes) {
    if (attribute.archivedAt === null && attribute.defaultValue !== null && !values.has(attribute.slug)) {
      values.set(attribute.slug, attribute.defaultValue)
    }
  }
  for (const [slug, value] of [...values].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const attribute = attributes.get(slug)
    if (attribute ===undefined || attribute.archivedAt !== null || virtual(attribute)) continue
    if (attribute.type === 'record_reference') {
      const operation = reference(schema, objectType, attribute, value, issues)
      if (operation !== undefined) linkOps.push(operation)
    } else stored(attribute, value, data, issues)
  }
  if (mode === 'create') for (const attribute of objectType.attributes) {
    if (!attribute.isRequired || virtual(attribute)) continue
    const present = attribute.type === 'record_reference'
      ? linkOps.some((operation) => (
        operation.attributeSlug === attribute.slug && operation.targetIds.length > 0
      ))
      : Object.hasOwn(data, attribute.slug)
    if (!present && !issues.some((item) => item.path === pointer(attribute.slug))) {
      invalid(issues, attribute.slug)
    }
  }
  if (issues.length > 0) fail(issues)
  const canonical = canonicalData(data, issues)
  if (canonical === undefined) fail(issues)
  if (Buffer.byteLength(canonicalJson(canonical), 'utf8') > MAX_RECORD_DATA_BYTES) {
    issue(issues, '', 'Record data exceeds the maximum size')
    fail(issues)
  }
  linkOps.sort((left, right) => (
    left.attributeSlug < right.attributeSlug ? -1 : left.attributeSlug > right.attributeSlug ? 1 : 0
  ))
  return { data: canonical, linkOps, issues: [] }
}
