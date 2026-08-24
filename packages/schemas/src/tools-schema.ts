import { z } from 'zod'
import {
  AttributeDetail,
  AttributeSpec,
  Cardinality,
  ObjectTypeDetail,
  OnDelete,
  RelationTypeDetail,
  SchemaSnapshot,
  Sensitivity,
} from './schema-specs.js'
import { MatchingRule, MatchingRuleActivation } from './matching.js'
import { Reason, Slug } from './primitives.js'

export const CrmSchemaGet = {
  in: z.object({
    object_type: Slug.optional().describe('object type slug; omit for the complete schema snapshot'),
  }),
  out: z.union([SchemaSnapshot, ObjectTypeDetail]),
}

export const CrmObjectTypeDefine = {
  in: z.object({
    slug: Slug.describe('new object type slug'),
    singular_name: z.string().min(1).max(80).describe('singular display name'),
    plural_name: z.string().min(1).max(80).describe('plural display name'),
    description: z.string().min(1).max(500).describe('what a record of this type represents'),
    icon: z.string().max(64).optional().describe('optional icon identifier'),
    attributes: z.array(AttributeSpec).max(100).optional().describe('attributes to create with the object type'),
    primary_attribute: Slug.optional().describe('attribute used as the record display name'),
  }),
  out: ObjectTypeDetail,
}

export const CrmObjectTypeUpdate = {
  in: z.object({
    object_type: Slug.describe('existing object type slug'),
    singular_name: z.string().min(1).max(80).optional().describe('replacement singular display name'),
    plural_name: z.string().min(1).max(80).optional().describe('replacement plural display name'),
    description: z.string().max(500).optional().describe('replacement description'),
    icon: z.string().max(64).optional().describe('replacement icon identifier'),
    primary_attribute: Slug.optional().describe('replacement display-name attribute'),
  }),
  out: ObjectTypeDetail,
}

export const CrmObjectTypeArchive = {
  in: z.object({
    object_type: Slug.describe('custom object type slug to archive'),
    reason: Reason.describe('why this object type is being archived'),
  }),
  out: z.object({
    archived: z.literal(true),
    records: z.number().int().nonnegative(),
  }),
}

export const CrmAttributeDefine = {
  in: AttributeSpec.extend({
    object_type: Slug.describe('object type that owns the attribute'),
  }),
  out: AttributeDetail,
}

export const CrmAttributeUpdate = {
  in: z.object({
    object_type: Slug.describe('object type that owns the attribute'),
    attribute: Slug.describe('existing attribute slug'),
    name: z.string().min(1).max(120).optional().describe('replacement display name'),
    description: z.string().max(500).optional().describe('replacement description'),
    config: z.record(z.unknown()).optional().describe('replacement type-specific configuration'),
    is_required: z.boolean().optional().describe('whether records must provide a value'),
    is_unique: z.boolean().optional().describe('whether values must be unique'),
    is_indexed: z.boolean().optional().describe('whether filtering and sorting are indexed'),
    sensitivity: Sensitivity.optional().describe('replacement data sensitivity'),
    default_value: z.unknown().optional().describe('replacement default value'),
    recompute_keys: z.boolean().optional()
      .describe('set true to enqueue the required key-recompute backfill for normalization-affecting config changes'),
  }),
  out: AttributeDetail,
}

export const CrmAttributeArchive = {
  in: z.object({
    object_type: Slug.describe('object type that owns the attribute'),
    attribute: Slug.describe('attribute slug to archive'),
    reason: Reason.describe('why this attribute is being archived'),
  }),
  out: z.object({
    archived: z.literal(true),
    records_with_values: z.number().int().nonnegative(),
  }),
}

export const CrmRelationTypeDefine = {
  in: z.object({
    slug: Slug.describe('new relation type slug'),
    from_object_type: Slug.nullable().describe('source object type; null permits any object type'),
    to_object_type: Slug.nullable().describe('target object type; null permits any object type'),
    forward_name: z.string().min(1).max(80).describe('source-to-target relationship name'),
    inverse_name: z.string().min(1).max(80).describe('target-to-source relationship name'),
    description: z.string().max(500).optional().describe('what this relationship represents'),
    cardinality: Cardinality.describe('allowed relationship cardinality'),
    on_delete: OnDelete.default('unlink').describe('what happens to links when a record is deleted'),
    edge_attributes: z.array(AttributeSpec).max(20).optional().describe('typed attributes stored on each link'),
  }),
  out: RelationTypeDetail,
}

export const CrmRelationTypeArchive = {
  in: z.object({
    relation_type: Slug.describe('relation type slug to archive'),
    reason: Reason.describe('why this relation type is being archived'),
  }),
  out: z.object({
    archived: z.literal(true),
    links: z.number().int().nonnegative(),
  }),
}

export const CrmMatchingRuleSet = {
  in: z.object({
    object_type: Slug.describe('object type whose duplicate rules are replaced'),
    rules: z.array(MatchingRule).max(10).describe('ordered duplicate-detection rules'),
    retry_backfill: z.boolean().default(false).describe('retry a terminal or collision-blocked backfill'),
  }),
  out: z.object({
    rules: z.array(MatchingRule),
    activation: MatchingRuleActivation,
  }),
}

export const CrmTemplateApply = {
  in: z.object({
    template: Slug.describe('a slug from crm://templates; unknown values return UNKNOWN_TEMPLATE'),
  }),
  out: z.object({
    added: z.object({
      object_types: z.number().int().nonnegative(),
      attributes: z.number().int().nonnegative(),
      relation_types: z.number().int().nonnegative(),
      matching_rules: z.number().int().nonnegative(),
    }),
  }),
}
