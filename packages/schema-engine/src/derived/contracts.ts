import { z } from 'zod'

import { AttributeType, AttributeValueSource, Slug } from '@deepcrm/schemas'

const MAX_NODES = 100
const Literal = z.union([z.string(), z.number(), z.boolean(), z.null()])
const FormulaExpression: z.ZodType<FormulaExpression> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: Literal }).strict(),
  z.object({ kind: z.literal('attribute'), attribute: Slug }).strict(),
  z.object({
    kind: z.literal('binary'),
    op: z.enum(['add', 'subtract', 'multiply', 'divide', 'concat', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
    left: FormulaExpression,
    right: FormulaExpression,
  }).strict(),
  z.object({
    kind: z.literal('function'),
    name: z.enum(['coalesce', 'lower', 'upper', 'length', 'days_since']),
    args: z.array(FormulaExpression).max(10),
  }).strict(),
]))

export type FormulaExpression =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'attribute'; attribute: string }
  | {
    kind: 'binary'
    op: 'add' | 'subtract' | 'multiply' | 'divide' | 'concat' | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
    left: FormulaExpression
    right: FormulaExpression
  }
  | { kind: 'function'; name: 'coalesce' | 'lower' | 'upper' | 'length' | 'days_since'; args: FormulaExpression[] }

export const FormulaConfig = z.object({
  expression: FormulaExpression.describe('bounded deterministic expression AST'),
  null_behavior: z.enum(['propagate', 'skip']).default('propagate'),
  error_behavior: z.enum(['null', 'fail']).default('null'),
}).strict()

export const RollupConfig = z.object({
  relation_type: Slug.describe('relation whose active links select related records'),
  direction: z.enum(['outgoing', 'incoming']).describe('which side of the relation starts at this record'),
  operation: z.enum(['count', 'sum', 'min', 'max', 'average', 'earliest_date', 'latest_date']),
  source_attribute: Slug.optional().describe('related-record attribute used by non-count operations'),
  filter: z.record(z.unknown()).optional().describe('structured filter applied to related records'),
}).strict()

export const RelationSyncConfig = z.object({
  relation_type: Slug.describe('relation whose single active related record is read'),
  direction: z.enum(['outgoing', 'incoming']).describe('which side of the relation starts at this record'),
  source_attribute: Slug.describe('related-record attribute copied to the derived value'),
  on_multiple: z.enum(['error', 'first_by_created_at']).default('error'),
}).strict()

export const ScoreConfig = z.object({
  criteria: z.array(z.object({
    attribute: Slug.describe('source attribute slug'),
    weight: z.number().min(-1000).max(1000).describe('bounded contribution weight'),
    when: z.record(z.unknown()).describe('deterministic typed predicate config'),
  }).strict()).min(1).max(50),
  time_decay: z.object({
    attribute: Slug.describe('timestamp attribute used for decay'),
    half_life_days: z.number().positive().max(3650),
  }).strict().optional(),
}).strict()

export const DerivedDefinitionConfig = z.discriminatedUnion('value_source', [
  z.object({ value_source: z.literal('formula'), config: FormulaConfig }).strict(),
  z.object({ value_source: z.literal('rollup'), config: RollupConfig }).strict(),
  z.object({ value_source: z.literal('relation_sync'), config: RelationSyncConfig }).strict(),
  z.object({ value_source: z.literal('score'), config: ScoreConfig }).strict(),
])

export type DerivedDefinitionConfig = z.infer<typeof DerivedDefinitionConfig>
export type DerivedValueSource = Exclude<z.infer<typeof AttributeValueSource>, 'stored' | 'system'>

export type DerivedAttributeDefinition = {
  objectType: string
  slug: string
  name: string
  description: string
  type: z.infer<typeof AttributeType>
  config?: Record<string, unknown>
  isRequired: boolean
  isIndexed: boolean
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'
  valueSource: DerivedValueSource
  derivationConfig: Record<string, unknown>
}

function countNodes(expression: FormulaExpression): number {
  if (expression.kind === 'literal' || expression.kind === 'attribute') return 1
  if (expression.kind === 'binary') return 1 + countNodes(expression.left) + countNodes(expression.right)
  return 1 + expression.args.reduce((total, child) => total + countNodes(child), 0)
}

function formulaDependencies(expression: FormulaExpression, output: Set<string>): void {
  if (expression.kind === 'attribute') output.add(expression.attribute)
  else if (expression.kind === 'binary') {
    formulaDependencies(expression.left, output)
    formulaDependencies(expression.right, output)
  } else if (expression.kind === 'function') {
    for (const child of expression.args) formulaDependencies(child, output)
  }
}

export function parseDerivedConfig(valueSource: DerivedValueSource, config: unknown): DerivedDefinitionConfig {
  const parsed = DerivedDefinitionConfig.parse({ value_source: valueSource, config })
  if (parsed.value_source === 'formula' && countNodes(parsed.config.expression) > MAX_NODES) {
    throw new Error('formula_too_large')
  }
  return parsed
}

export function sourceAttributeSlugs(definition: DerivedDefinitionConfig): readonly string[] {
  const result = new Set<string>()
  if (definition.value_source === 'formula') formulaDependencies(definition.config.expression, result)
  else if (definition.value_source === 'rollup' && definition.config.source_attribute !== undefined) {
    result.add(definition.config.source_attribute)
  } else if (definition.value_source === 'relation_sync') result.add(definition.config.source_attribute)
  else if (definition.value_source === 'score') {
    for (const criterion of definition.config.criteria) result.add(criterion.attribute)
    if (definition.config.time_decay !== undefined) result.add(definition.config.time_decay.attribute)
  }
  return [...result].sort()
}
