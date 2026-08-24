/* eslint-disable max-len */
import { z } from 'zod'
import { AttributeType } from './attribute-config.js'
import { IsoDateTime, Slug, Uuid } from './primitives.js'
import { MatchingRule } from './matching.js'
export const Sensitivity = z.enum(['public','internal','confidential','restricted'])
  .describe('data sensitivity used for policy and redaction')
export const Cardinality = z.enum(['one_to_one','one_to_many','many_to_one','many_to_many'])
  .describe('relationship cardinality')
export const OnDelete = z.enum(['unlink','cascade','restrict'])
  .describe('link behavior when an endpoint record is deleted')
export const AttributeSpec = z.object({
  slug: Slug.describe('attribute slug'),
  name: z.string().min(1).max(120).describe('attribute display name'),
  description: z.string().max(500).describe('shown to agents; say what the value means'),
  type: AttributeType.describe('stored value type'),
  config: z.record(z.unknown()).optional().describe('type-specific config; see attribute-config.ts'),
  is_multi: z.boolean().default(false).describe('accepts an array of values'),
  is_required: z.boolean().default(false).describe('requires a value on every record'),
  is_unique: z.boolean().default(false).describe('enforced; enables crm_record_assert on this attribute'),
  is_indexed: z.boolean().default(false).describe('creates an index for filtering/sorting'),
  sensitivity: Sensitivity.default('internal').describe('policy and redaction sensitivity'),
  default_value: z.unknown().optional().describe('value used when a record omits this attribute'),
})
export type AttributeSpec = z.infer<typeof AttributeSpec>
export const AttributeDetail = AttributeSpec.extend({ id: Uuid, is_system: z.boolean(), position: z.number().int(), archived_at: IsoDateTime.nullable() })
export const ObjectTypeDetail = z.object({ id: Uuid, slug: Slug, singular_name: z.string(), plural_name: z.string(), description: z.string(), icon: z.string().nullable(), kind: z.enum(['system','standard','custom']), primary_attribute: Slug.nullable(), attributes: z.array(AttributeDetail), relation_types: z.array(z.object({ slug: Slug, direction: z.enum(['from','to']), name: z.string(), other_object_type: Slug.nullable(), cardinality: Cardinality })), archived_at: IsoDateTime.nullable() })
export const RelationTypeDetail = z.object({ id: Uuid, slug: Slug, from_object_type: Slug.nullable(), to_object_type: Slug.nullable(), forward_name: z.string(), inverse_name: z.string(), description: z.string(), cardinality: Cardinality, on_delete: OnDelete, edge_attributes: z.array(AttributeSpec), is_system: z.boolean(), archived_at: IsoDateTime.nullable() })
export { MatchingRule } from './matching.js'
export const ViewSummary = z.object({
  slug: Slug,
  name: z.string(),
  object_type: Slug,
})
export const SchemaSnapshot = z.object({ schema_version: z.number().int(), object_types: z.array(ObjectTypeDetail.pick({ id: true, slug: true, singular_name: true, plural_name: true, description: true, kind: true, primary_attribute: true }).extend({ attribute_count: z.number().int() })), relation_types: z.array(RelationTypeDetail), matching_rules: z.record(Slug, z.array(MatchingRule)).describe('by object type slug'), views: z.array(ViewSummary) })
