import { z } from 'zod'

import { AttributeSpec, Cardinality, OnDelete } from '@deepcrm/schemas'

const object = z.object({
  slug: z.string(), kind: z.enum(['system', 'standard', 'custom']), singular_name: z.string(),
  plural_name: z.string(), description: z.string(), icon: z.string().optional(),
  primary_attribute: z.string().optional(),
  attributes: z.array(AttributeSpec.extend({ is_system: z.boolean().optional() })),
}).strict()
const relation = z.object({
  slug: z.string(), from_object_type: z.string().nullable(), to_object_type: z.string().nullable(),
  forward_name: z.string(), inverse_name: z.string(), description: z.string().optional(),
  cardinality: Cardinality, on_delete: OnDelete.optional(), is_system: z.boolean().optional(),
  edge_attributes: z.array(AttributeSpec).optional(),
}).strict()
const matching = z.object({ attributes: z.array(z.string()), method: z.enum(['exact', 'normalized', 'fuzzy']), threshold: z.number().optional(), action: z.enum(['block', 'warn', 'allow']) }).strict()
export const TemplateSchema = z.object({
  slug: z.enum(['system', 'standard_crm']), description: z.string(), object_types: z.array(object),
  relation_types: z.array(relation), matching_rules: z.record(z.array(matching)),
}).strict()
export type Template = z.infer<typeof TemplateSchema>
export type TemplateAdded = { objectTypes: number; attributes: number; relationTypes: number; matchingRules: number }
