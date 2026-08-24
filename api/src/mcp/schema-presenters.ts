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

function attribute(attribute: LoadedAttribute) {
  return AttributeDetail.parse({
    id: attribute.id,
    slug: attribute.slug,
    name: attribute.name,
    description: attribute.description,
    type: attribute.type,
    config: attribute.config,
    is_multi: attribute.isMulti,
    is_required: attribute.isRequired,
    is_unique: attribute.isUnique,
    is_indexed: attribute.isIndexed,
    sensitivity: attribute.sensitivity,
    default_value: attribute.defaultValue ?? undefined,
    is_system: attribute.isSystem,
    position: attribute.position,
    archived_at: iso(attribute.archivedAt),
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
    attributes: objectType.attributes.map(attribute),
    relation_types: relationSummaries(schema, objectType),
    pipelines: pipelineSummaries(schema, objectType),
    archived_at: iso(objectType.archivedAt),
  })
}

export function presentSchema(
  schema: LoadedSchema,
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
    views,
  })
}

export function presentAttribute(schema: LoadedSchema, objectType: string, slug: string) {
  const object = schema.objectTypesBySlug.get(objectType)
  if (object === undefined) throw new Error('Object type was not found after schema mutation')
  const selected = object.attributes.find((attributeValue) => attributeValue.slug === slug)
  if (selected === undefined) throw new Error('Attribute was not found after schema mutation')
  return attribute(selected)
}

export function presentRelation(schema: LoadedSchema, slug: string) {
  const selected = schema.relationTypesBySlug.get(slug)
  if (selected === undefined) throw new Error('Relation type was not found after schema mutation')
  return relation(schema, selected)
}
