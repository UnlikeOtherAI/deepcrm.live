import {
  AttributeDetail,
  AttributeSpec,
  ObjectTypeDetail,
  RelationTypeDetail,
  SchemaSnapshot,
} from '@deepcrm/schemas'
import type {
  LoadedAttribute,
  LoadedObjectType,
  LoadedRelationType,
  LoadedSchema,
} from '@deepcrm/schema-engine'

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

function jsonObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}

function derivation(schema: LoadedSchema, attributeValue: LoadedAttribute) {
  const value = attributeValue.derivation
  if (value === undefined || value === null) return null
  return {
    attribute: attributeValue.slug,
    type: attributeValue.type,
    sensitivity: attributeValue.sensitivity,
    value_source: value.valueSource,
    materialized: value.materialized,
    config: jsonObject(value.config),
    refresh_state: value.refreshState,
    refresh_error_code: value.refreshErrorCode,
    last_refreshed_at: iso(value.lastRefreshedAt),
    dependencies: value.dependencies.map((dependency) => ({
      source_kind: dependency.sourceKind,
      source_path: dependency.sourcePath,
      source_attribute: dependency.sourceAttributeId === null
        ? null
        : schema.attributesById.get(dependency.sourceAttributeId)?.slug ?? null,
      relation_type: dependency.relationTypeId === null
        ? null
        : schema.relationTypesById.get(dependency.relationTypeId)?.slug ?? null,
    })),
  }
}

function groupSlug(schema: LoadedSchema, attributeValue: LoadedAttribute): string | null {
  if (attributeValue.groupId === null || attributeValue.objectTypeId === null) return null
  const objectType = schema.objectTypesById.get(attributeValue.objectTypeId)
  return objectType?.attributeGroups.find((group) => group.id === attributeValue.groupId)?.slug ?? null
}

function attribute(schema: LoadedSchema, attributeValue: LoadedAttribute) {
  return AttributeDetail.parse({
    id: attributeValue.id,
    slug: attributeValue.slug,
    name: attributeValue.name,
    description: attributeValue.description,
    type: attributeValue.type,
    value_source: attributeValue.valueSource,
    derivation: derivation(schema, attributeValue),
    group: groupSlug(schema, attributeValue),
    config: attributeValue.config,
    is_multi: attributeValue.isMulti,
    is_required: attributeValue.isRequired,
    is_unique: attributeValue.isUnique,
    is_indexed: attributeValue.isIndexed,
    sensitivity: attributeValue.sensitivity,
    default_value: attributeValue.defaultValue ?? undefined,
    is_system: attributeValue.isSystem,
    position: attributeValue.position,
    archived_at: iso(attributeValue.archivedAt),
  })
}

function edgeAttributes(relation: LoadedRelationType): AttributeSpec[] {
  return AttributeSpec.array().parse(relation.edgeAttributes)
}

function relation(
  schema: LoadedSchema,
  loaded: LoadedRelationType,
) {
  return RelationTypeDetail.parse({
    id: loaded.id,
    slug: loaded.slug,
    from_object_type: loaded.fromObjectTypeId === null
      ? null
      : schema.objectTypesById.get(loaded.fromObjectTypeId)?.slug ?? null,
    to_object_type: loaded.toObjectTypeId === null
      ? null
      : schema.objectTypesById.get(loaded.toObjectTypeId)?.slug ?? null,
    forward_name: loaded.forwardName,
    inverse_name: loaded.inverseName,
    description: loaded.description,
    cardinality: loaded.cardinality,
    edge_limits: {
      max_active_edges_from: loaded.maxActiveEdgesFrom,
      max_active_edges_to: loaded.maxActiveEdgesTo,
      label_limits: loaded.edgeLimitConfig,
    },
    on_delete: loaded.onDelete,
    edge_attributes: edgeAttributes(loaded),
    is_system: loaded.isSystem,
    archived_at: iso(loaded.archivedAt),
  })
}

function primaryAttribute(objectType: LoadedObjectType): string | null {
  if (objectType.primaryAttributeId === null) return null
  return objectType.attributes.find((attributeValue) => (
    attributeValue.id === objectType.primaryAttributeId
  ))?.slug ?? null
}

function relationSummaries(schema: LoadedSchema, objectType: LoadedObjectType) {
  const summaries: Array<{
    slug: string
    direction: 'from' | 'to'
    name: string
    other_object_type: string | null
    cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many'
  }> = []
  for (const relationType of schema.relationTypes) {
    if (relationType.fromObjectTypeId === objectType.id) {
      summaries.push({
        slug: relationType.slug,
        direction: 'from',
        name: relationType.forwardName,
        other_object_type: relationType.toObjectTypeId === null
          ? null
          : schema.objectTypesById.get(relationType.toObjectTypeId)?.slug ?? null,
        cardinality: relationType.cardinality,
      })
      continue
    }
    if (relationType.toObjectTypeId === objectType.id) {
      summaries.push({
        slug: relationType.slug,
        direction: 'to',
        name: relationType.inverseName,
        other_object_type: relationType.fromObjectTypeId === null
          ? null
          : schema.objectTypesById.get(relationType.fromObjectTypeId)?.slug ?? null,
        cardinality: relationType.cardinality,
      })
    }
  }
  return summaries
}

function pipelineSummaries(schema: LoadedSchema, objectType: LoadedObjectType) {
  return (schema.pipelinesByObjectTypeId.get(objectType.id) ?? []).map((pipeline) => ({
    id: pipeline.id,
    object_type: objectType.slug,
    slug: pipeline.slug,
    name: pipeline.name,
    description: pipeline.description,
    is_default: pipeline.isDefault,
    stages: pipeline.stages.map((stage) => ({
      id: stage.id,
      slug: stage.slug,
      name: stage.name,
      position: stage.position,
      probability: stage.probability,
      category: stage.category,
      archived_at: iso(stage.archivedAt),
    })),
    archived_at: iso(pipeline.archivedAt),
  }))
}

function attributeGroups(objectType: LoadedObjectType) {
  return objectType.attributeGroups.map((group) => ({
    id: group.id,
    object_type: objectType.slug,
    slug: group.slug,
    name: group.name,
    description: group.description,
    position: group.position,
    archived_at: iso(group.archivedAt),
  }))
}

export function presentAttributeGroup(schema: LoadedSchema, objectTypeSlug: string, groupSlugValue: string) {
  const objectType = schema.objectTypesBySlug.get(objectTypeSlug)
  if (objectType === undefined) throw new Error('Object type was not found after group mutation')
  const group = attributeGroups(objectType).find((value) => value.slug === groupSlugValue)
  if (group === undefined) throw new Error('Attribute group was not found after mutation')
  return group
}

export function presentObjectType(schema: LoadedSchema, objectType: LoadedObjectType) {
  return ObjectTypeDetail.parse({
    id: objectType.id,
    slug: objectType.slug,
    singular_name: objectType.singularName,
    plural_name: objectType.pluralName,
    description: objectType.description,
    icon: objectType.icon,
    kind: objectType.kind,
    primary_attribute: primaryAttribute(objectType),
    attribute_groups: attributeGroups(objectType),
    attributes: objectType.attributes.map((attributeValue) => attribute(schema, attributeValue)),
    relation_types: relationSummaries(schema, objectType),
    pipelines: pipelineSummaries(schema, objectType),
    archived_at: iso(objectType.archivedAt),
  })
}

export function presentSchema(
  schema: LoadedSchema,
  lists: readonly {
    slug: string
    name: string
    kind: 'static' | 'dynamic'
    object_type: string | null
    refresh_state: 'ready' | 'refreshing' | 'failed'
    evaluation_version: number
  }[],
  views: readonly { slug: string; name: string; object_type: string }[],
) {
  const matchingRules = Object.fromEntries(schema.objectTypes.map((objectType) => [
    objectType.slug,
    schema.matchingRulesByObjectTypeId.get(objectType.id)?.map((rule) => ({
      attributes: rule.attributeSlugs,
      method: rule.method,
      threshold: rule.threshold ?? undefined,
      action: rule.action,
    })) ?? [],
  ]))
  return SchemaSnapshot.parse({
    schema_version: schema.schemaVersion,
    object_types: schema.objectTypes.map((objectType) => ({
      id: objectType.id,
      slug: objectType.slug,
      singular_name: objectType.singularName,
      plural_name: objectType.pluralName,
      description: objectType.description,
      kind: objectType.kind,
      primary_attribute: primaryAttribute(objectType),
      attribute_count: objectType.attributes.length,
    })),
    relation_types: schema.relationTypes.map((relationType) => relation(schema, relationType)),
    matching_rules: matchingRules,
    lists,
    views,
  })
}

export function presentAttribute(schema: LoadedSchema, objectType: string, slug: string) {
  const object = schema.objectTypesBySlug.get(objectType)
  if (object === undefined) throw new Error('Object type was not found after schema mutation')
  const selected = object.attributes.find((attributeValue) => attributeValue.slug === slug)
  if (selected === undefined) throw new Error('Attribute was not found after schema mutation')
  return attribute(schema, selected)
}

export function presentRelation(schema: LoadedSchema, slug: string) {
  const selected = schema.relationTypesBySlug.get(slug)
  if (selected === undefined) throw new Error('Relation type was not found after schema mutation')
  return relation(schema, selected)
}
