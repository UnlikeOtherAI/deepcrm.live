import { z } from 'zod'

import { Slug, Uuid } from './primitives.js'

export const FilterOp = z.enum([
  'eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null', 'contains',
  'starts_with', 'gt', 'gte', 'lt', 'lte', 'between',
]).describe('comparison operator; valid operators depend on the attribute or system-field type')

export const SystemField = z.enum([
  'created_at', 'updated_at', 'last_activity_at', 'display_name', 'owner',
]).describe('read-only record field outside data')

const QualityFilter = z.union([
  z.object({
    category: z.literal('stale')
      .describe('records with null or old last activity'),
    stale_days: z.number().int().min(1).max(3650).optional()
      .describe('stale window, default 90 days'),
  }).strict(),
  z.object({
    category: z.enum(['missing_required', 'orphans', 'collisions'])
      .describe('structural data-quality category reported by crm_data_quality'),
  }).strict(),
]).describe('reusable data-quality filter returned by crm_data_quality')

export type Filter =
  | { and: Filter[] }
  | { or: Filter[] }
  | { not: Filter }
  | { attribute: string; op: z.infer<typeof FilterOp>; value?: unknown }
  | { system: z.infer<typeof SystemField>; op: z.infer<typeof FilterOp>; value?: unknown }
  | { linked_to: { relation: string; record_id: string; direction?: 'from' | 'to' } }
  | { quality: {
    category: 'missing_required' | 'stale' | 'orphans' | 'collisions'
    stale_days?: number
  } }
  | { text: string }

export const Filter: z.ZodType<Filter> = z.lazy(() => z.union([
  z.object({ and: z.array(Filter).min(1).describe('all child filters must match') }).strict(),
  z.object({ or: z.array(Filter).min(1).describe('at least one child filter must match') }).strict(),
  z.object({ not: Filter.describe('child filter whose result is inverted') }).strict(),
  z.object({
    attribute: Slug.describe('attribute slug on the selected object type'),
    op: FilterOp.describe('operator valid for this attribute type'),
    value: z.unknown().optional().describe('typed operand; omitted only for is_null/is_not_null'),
  }).strict(),
  z.object({
    system: SystemField.describe('system field to compare'),
    op: FilterOp.describe('operator valid for this system field'),
    value: z.unknown().optional().describe('typed operand; omitted only for is_null/is_not_null'),
  }).strict(),
  z.object({ linked_to: z.object({
    relation: Slug.describe('active relation type slug'),
    record_id: Uuid.describe('record id at the requested end of the relation'),
    direction: z.enum(['from', 'to']).default('from')
      .describe('from matches selected records at the link source; to matches them at the target'),
  }).strict().describe('match records joined to this record by an active link') }).strict(),
  z.object({ quality: QualityFilter }).strict(),
  z.object({ text: z.string().min(1).max(200).describe('full-text match on the search document') }).strict(),
])).describe('structured filter; grammar + examples in resource crm://help/filtering. Caps: depth 8, 100 nodes, 16 KiB')

export const Sort = z.array(z.object({
  attribute: Slug.optional().describe('sortable scalar attribute slug; mutually exclusive with system'),
  system: SystemField.optional()
    .describe('sortable system field except owner; mutually exclusive with attribute'),
  direction: z.enum(['asc', 'desc']).default('asc').describe('sort direction; nulls are always last'),
}).strict()
  .refine((item) => !!item.attribute !== !!item.system, 'exactly one of attribute or system')
  .refine((item) => item.system !== 'owner', 'owner is filter-only and cannot be sorted'))
  .max(3).describe('ordered sort keys; defaults to created_at descending when omitted')

export type Sort = z.infer<typeof Sort>
