import {
  tenantWhere,
  type Attribute,
  type Db,
  type MatchingRule,
  type MatchingRuleGeneration,
  type ObjectType,
  type RelationType,
  type TenantRef,
} from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

export type LoadedAttribute = Readonly<Attribute>
export type LoadedObjectType = Readonly<ObjectType & {
  attributes: readonly LoadedAttribute[]
}>
export type LoadedRelationType = Readonly<RelationType>
export type LoadedMatchingRule = Readonly<MatchingRule & {
  generation: Pick<MatchingRuleGeneration, 'id' | 'state' | 'keysReadyAt' | 'backfillAttempt' | 'backfillJobId'>
}>

export type LoadedSchema = Readonly<{
  teamId: string
  schemaVersion: number
  objectTypes: readonly LoadedObjectType[]
  relationTypes: readonly LoadedRelationType[]
  matchingRules: readonly LoadedMatchingRule[]
  replacementMatchingRules: readonly LoadedMatchingRule[]
  objectTypesBySlug: ReadonlyMap<string, LoadedObjectType>
  objectTypesById: ReadonlyMap<string, LoadedObjectType>
  attributesById: ReadonlyMap<string, LoadedAttribute>
  attributesByObjectTypeId: ReadonlyMap<string, ReadonlyMap<string, LoadedAttribute>>
  archivedAttributeSlugsByObjectTypeId: ReadonlyMap<string, ReadonlySet<string>>
  relationTypesBySlug: ReadonlyMap<string, LoadedRelationType>
  relationTypesById: ReadonlyMap<string, LoadedRelationType>
  matchingRulesByObjectTypeId: ReadonlyMap<string, readonly LoadedMatchingRule[]>
  replacementMatchingRulesByObjectTypeId: ReadonlyMap<string, readonly LoadedMatchingRule[]>
  backingRelationsByAttributeId: ReadonlyMap<string, LoadedRelationType>
  resolveBackingRelation: (
    objectTypeSlug: string,
    attributeSlug: string,
  ) => LoadedRelationType | undefined
}>

type TeamVersion = { id: string; schemaVersion: number }
type MetadataRows = {
  objectTypes: Array<ObjectType & { attributes: Attribute[] }>
  relationTypes: RelationType[]
  matchingRules: Array<MatchingRule & { generation: MatchingRuleGeneration }>
}
export type SchemaLoadSource = {
  readVersion: (tenant: TenantRef) => Promise<TeamVersion | null>
  readMetadata: (tenant: TenantRef) => Promise<MetadataRows>
}

const cache = new Map<string, LoadedSchema>()
const CACHE_LIMIT = 64
const LOAD_ATTEMPTS = 3

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#values = new Map(entries)
    Object.freeze(this)
  }

  get size(): number {
    return this.#values.size
  }

  get(key: K): V | undefined {
    return this.#values.get(key)
  }

  has(key: K): boolean {
    return this.#values.has(key)
  }

  entries(): MapIterator<[K, V]> {
    return this.#values.entries()
  }

  keys(): MapIterator<K> {
    return this.#values.keys()
  }

  values(): MapIterator<V> {
    return this.#values.values()
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this)
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries()
  }
}

class ImmutableSet<T> implements ReadonlySet<T> {
  readonly #values: Set<T>

  constructor(values: Iterable<T>) {
    this.#values = new Set(values)
    Object.freeze(this)
  }

  get size(): number {
    return this.#values.size
  }

  has(value: T): boolean {
    return this.#values.has(value)
  }

  entries(): SetIterator<[T, T]> {
    return this.#values.entries()
  }

  keys(): SetIterator<T> {
    return this.#values.keys()
  }

  values(): SetIterator<T> {
    return this.#values.values()
  }

  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this)
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.values()
  }
}

function pair<K, V>(key: K, value: V): readonly [K, V] {
  return [key, value]
}

function cacheKey(teamId: string, schemaVersion: number): string {
  return `${teamId}:${schemaVersion}`
}

function teamKeyPrefix(teamId: string): string {
  return `${teamId}:`
}

function touchCached(key: string, value: LoadedSchema): LoadedSchema {
  cache.delete(key)
  cache.set(key, value)
  return value
}

function cacheSchema(key: string, schema: LoadedSchema): void {
  const prefix = teamKeyPrefix(schema.teamId)
  let newerVersion: number | undefined
  for (const [existingKey, existing] of cache) {
    if (!existingKey.startsWith(prefix)) continue
    if (newerVersion === undefined || existing.schemaVersion > newerVersion) {
      newerVersion = existing.schemaVersion
    }
  }
  if (newerVersion !== undefined && newerVersion > schema.schemaVersion) return
  for (const existingKey of cache.keys()) {
    if (existingKey.startsWith(prefix)) cache.delete(existingKey)
  }
  cache.set(key, schema)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function freezeDeep(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return
  for (const property of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, property)
    if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
      const nested: unknown = descriptor.value
      freezeDeep(nested)
    }
  }
  Object.freeze(value)
}

function schemaConflict(detail: string): ServiceError {
  return new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema metadata is inconsistent', { detail })
}

function tenantError(): ServiceError {
  return new ServiceError(ErrorCode.TENANT_MISMATCH, 'Tenant does not exist')
}

function buildSchema(
  team: TeamVersion,
  rows: MetadataRows,
  bootstrapGenerationId: string | undefined = undefined,
): LoadedSchema {
  const copied = structuredClone(rows)
  freezeDeep(copied)
  const objectTypes: readonly LoadedObjectType[] = Object.freeze(copied.objectTypes.map(
    (objectType) => Object.freeze({
      ...objectType,
      attributes: Object.freeze(objectType.attributes.filter((attribute) => attribute.archivedAt === null)),
    }),
  ))
  const relationTypes: readonly LoadedRelationType[] = copied.relationTypes
  const allMatchingRules: readonly LoadedMatchingRule[] = copied.matchingRules
  const matchingRules = Object.freeze(allMatchingRules.filter((rule) => rule.generation.state === 'active'))
  const replacementMatchingRules = Object.freeze(allMatchingRules.filter((rule) => (
    rule.generation.state === 'pending_backfill' || rule.generation.state === 'collision_blocked'
  )))
  if (
    bootstrapGenerationId !== undefined
    && !matchingRules.some((rule) => rule.generation.id === bootstrapGenerationId)
  ) {
    throw schemaConflict('matching_bootstrap_generation_not_active')
  }
  for (const rule of matchingRules) {
    const trustedBootstrapRule = (
      rule.generation.id === bootstrapGenerationId
      && rule.generation.state === 'active'
    )
    if (
      (rule.method === 'exact' || rule.method === 'normalized')
      && rule.generation.keysReadyAt === null
      && !trustedBootstrapRule
    ) {
      throw schemaConflict('matching_keys_not_ready')
    }
  }
  const objectTypesBySlug = new ImmutableMap(objectTypes.map(
    (objectType) => pair(objectType.slug, objectType),
  ))
  const objectTypesById = new ImmutableMap(objectTypes.map(
    (objectType) => pair(objectType.id, objectType),
  ))
  const attributesById = new ImmutableMap(objectTypes.flatMap((objectType) => (
    objectType.attributes.map((attribute) => pair(attribute.id, attribute))
  )))
  const attributesByObjectTypeId = new ImmutableMap(objectTypes.map((objectType) => pair(
    objectType.id,
    new ImmutableMap(objectType.attributes.map((attribute) => pair(attribute.slug, attribute))),
  )))
  const archivedAttributeSlugsByObjectTypeId = new ImmutableMap(copied.objectTypes.map((objectType) => pair(
    objectType.id,
    new ImmutableSet(objectType.attributes
      .filter((attribute) => attribute.archivedAt !== null)
      .map((attribute) => attribute.slug)),
  )))
  const relationTypesBySlug = new ImmutableMap(relationTypes.map(
    (relationType) => pair(relationType.slug, relationType),
  ))
  const relationTypesById = new ImmutableMap(relationTypes.map(
    (relationType) => pair(relationType.id, relationType),
  ))
  const matchingRulesByObjectTypeId = new ImmutableMap(objectTypes.map((objectType) => pair(
    objectType.id,
    Object.freeze(matchingRules.filter((rule) => rule.objectTypeId === objectType.id)),
  )))
  const replacementMatchingRulesByObjectTypeId = new ImmutableMap(objectTypes.map((objectType) => pair(
    objectType.id,
    Object.freeze(replacementMatchingRules.filter((rule) => rule.objectTypeId === objectType.id)),
  )))
  const projections = new Map<string, LoadedRelationType>()
  for (const relationType of relationTypes) {
    if (relationType.fromObjectTypeId === null || relationType.projectionAttributeSlug === null) continue
    const projectionKey = `${relationType.fromObjectTypeId}:${relationType.projectionAttributeSlug}`
    if (projections.has(projectionKey)) throw schemaConflict('duplicate_backing_relation')
    projections.set(projectionKey, relationType)
  }
  const backingRelations: Array<readonly [string, LoadedRelationType]> = []
  for (const objectType of objectTypes) {
    for (const attribute of objectType.attributes) {
      if (attribute.type !== 'record_reference') continue
      const relationType = projections.get(`${objectType.id}:${attribute.slug}`)
      if (relationType === undefined) throw schemaConflict('missing_backing_relation')
      backingRelations.push(pair(attribute.id, relationType))
    }
  }
  const backingRelationsByAttributeId = new ImmutableMap(backingRelations)
  const resolveBackingRelation = (
    objectTypeSlug: string,
    attributeSlug: string,
  ): LoadedRelationType | undefined => {
    const objectType = objectTypesBySlug.get(objectTypeSlug)
    if (objectType === undefined) return undefined
    const attribute = attributesByObjectTypeId.get(objectType.id)?.get(attributeSlug)
    if (attribute === undefined) return undefined
    return backingRelationsByAttributeId.get(attribute.id)
  }
  const loaded: LoadedSchema = {
    teamId: team.id,
    schemaVersion: team.schemaVersion,
    objectTypes,
    relationTypes,
    matchingRules,
    replacementMatchingRules,
    objectTypesBySlug,
    objectTypesById,
    attributesById,
    attributesByObjectTypeId,
    archivedAttributeSlugsByObjectTypeId,
    relationTypesBySlug,
    relationTypesById,
    matchingRulesByObjectTypeId,
    replacementMatchingRulesByObjectTypeId,
    backingRelationsByAttributeId,
    resolveBackingRelation,
  }
  return Object.freeze(loaded)
}

export async function loadSchemaFromSource(
  source: SchemaLoadSource,
  tenant: TenantRef,
  options: { bootstrapGenerationId?: string; useCache?: boolean } = {},
): Promise<LoadedSchema> {
  for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
    const before = await source.readVersion(tenant)
    if (before === null) throw tenantError()
    const key = cacheKey(before.id, before.schemaVersion)
    const existing = options.useCache === false ? undefined : cache.get(key)
    if (existing !== undefined) return touchCached(key, existing)
    const rows = await source.readMetadata(tenant)
    const after = await source.readVersion(tenant)
    if (after === null) throw tenantError()
    if (after.id !== before.id || after.schemaVersion !== before.schemaVersion) continue
    const loaded = buildSchema(before, rows, options.bootstrapGenerationId)
    if (options.useCache !== false) cacheSchema(key, loaded)
    return loaded
  }
  throw schemaConflict('schema_version_changed_during_load')
}

export async function loadSchema(db: Db, tenant: TenantRef): Promise<LoadedSchema> {
  const source: SchemaLoadSource = {
    readVersion: (target) => db.team.findFirst({
      where: { id: target.teamId, organizationId: target.organizationId },
      select: { id: true, schemaVersion: true },
    }),
    readMetadata: async (target) => {
      const activeWhere = { ...tenantWhere(target), archivedAt: null }
      const [objectTypes, relationTypes, matchingRules] = await Promise.all([
        db.objectType.findMany({
          where: activeWhere,
          include: {
            attributes: {
              where: tenantWhere(target),
              orderBy: { position: 'asc' },
            },
          },
          orderBy: { slug: 'asc' },
        }),
        db.relationType.findMany({ where: activeWhere, orderBy: { slug: 'asc' } }),
        db.matchingRule.findMany({
          where: tenantWhere(target),
          include: { generation: true },
          orderBy: [{ objectTypeId: 'asc' }, { position: 'asc' }],
        }),
      ])
      return { objectTypes, relationTypes, matchingRules }
    },
  }
  return loadSchemaFromSource(source, tenant)
}

export async function loadSchemaForMatchingBootstrap(
  db: Db,
  tenant: TenantRef,
  generationId: string,
): Promise<LoadedSchema> {
  const source: SchemaLoadSource = {
    readVersion: (target) => db.team.findFirst({
      where: { id: target.teamId, organizationId: target.organizationId },
      select: { id: true, schemaVersion: true },
    }),
    readMetadata: async (target) => {
      const activeWhere = { ...tenantWhere(target), archivedAt: null }
      const [objectTypes, relationTypes, matchingRules] = await Promise.all([
        db.objectType.findMany({
          where: activeWhere,
          include: { attributes: { where: tenantWhere(target), orderBy: { position: 'asc' } } },
          orderBy: { slug: 'asc' },
        }),
        db.relationType.findMany({ where: activeWhere, orderBy: { slug: 'asc' } }),
        db.matchingRule.findMany({
          where: tenantWhere(target), include: { generation: true },
          orderBy: [{ objectTypeId: 'asc' }, { position: 'asc' }],
        }),
      ])
      return { objectTypes, relationTypes, matchingRules }
    },
  }
  return loadSchemaFromSource(source, tenant, { bootstrapGenerationId: generationId, useCache: false })
}
