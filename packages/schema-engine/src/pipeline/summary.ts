import { Prisma, type Db, type TenantRef } from '@deepcrm/db'
import {
  ErrorCode,
  ServiceError,
  Slug,
  StatusOption,
  SupportedIso4217CurrencyCode,
  type ActorContext,
  type Filter,
} from '@deepcrm/schemas'
import Decimal from 'decimal.js'
import { z } from 'zod'

import { compileRecordSet } from '../query/compile.js'
import type {
  LoadedAttribute,
  LoadedObjectType,
  LoadedSchema,
} from '../schema/load.js'

export type PipelineSummaryTx = Pick<Db, '$queryRaw'>

export type PipelineSummaryInput = Readonly<{
  statusAttribute: string
  amountAttribute?: string
  filter?: Filter
  since?: Date
}>

export type PipelineStageSummary = Readonly<{
  id: string
  label: string
  category: 'open' | 'won' | 'lost' | 'neutral'
  count: number
  amountSum: Readonly<{ amount: string; currency: string }> | null
  averageDaysInStage: number | null
}>

export type PipelineConversion = Readonly<{
  from: string
  to: string
  count: number
}>

export type PipelineSummary = Readonly<{
  stages: readonly PipelineStageSummary[]
  conversions: readonly PipelineConversion[]
}>

type SummaryRow = {
  rowKind: 'current' | 'duration' | 'conversion'
  stageId: string | null
  count: number
  amountSum: string | null
  averageDays: number | null
  fromStage: string | null
  toStage: string | null
  invalidAmount: boolean
}

const StatusConfig = z.object({ options: z.array(StatusOption).min(2).max(50) }).strict()
const CurrencyConfig = z.object({
  defaultCurrency: SupportedIso4217CurrencyCode,
  fixedCurrency: SupportedIso4217CurrencyCode.optional(),
}).strict()
const DECIMAL_PATTERN = '^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,4})?$'

function schemaConflict(): never {
  throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Pipeline schema metadata is inconsistent')
}

function invalid(path: string, message: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Pipeline summary arguments are invalid', {
    issues: [{ path, message }],
  })
}

function assertScope(
  tenant: TenantRef,
  ctx: ActorContext,
  schema: LoadedSchema,
  objectType: LoadedObjectType,
): void {
  if (
    tenant.organizationId !== ctx.tenant.organizationId
    || tenant.teamId !== ctx.tenant.teamId
    || schema.teamId !== tenant.teamId
  ) {
    throw new ServiceError(ErrorCode.TENANT_MISMATCH, 'Pipeline tenant does not match')
  }
  if (
    objectType.organizationId !== tenant.organizationId
    || objectType.teamId !== tenant.teamId
    || objectType.archivedAt !== null
    || schema.objectTypesById.get(objectType.id)?.id !== objectType.id
  ) schemaConflict()
}

function attribute(
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  slug: string,
): LoadedAttribute {
  if (!Slug.safeParse(slug).success) invalid('/attribute', 'Must be a valid attribute slug')
  const selected = schema.attributesByObjectTypeId.get(objectType.id)?.get(slug)
  if (selected !== undefined && selected.archivedAt === null) return selected
  if (schema.archivedAttributeSlugsByObjectTypeId.get(objectType.id)?.has(slug) === true) {
    throw new ServiceError(ErrorCode.ATTRIBUTE_ARCHIVED, 'Attribute is archived', { attribute: slug })
  }
  throw new ServiceError(ErrorCode.UNKNOWN_ATTRIBUTE, 'Attribute does not exist', { attribute: slug })
}

function statusOptions(attributeValue: LoadedAttribute): readonly z.infer<typeof StatusOption>[] {
  if (attributeValue.type !== 'status' || attributeValue.isMulti) {
    invalid('/status_attribute', 'Must name a scalar status attribute')
  }
  const parsed = StatusConfig.safeParse(attributeValue.config)
  if (!parsed.success) schemaConflict()
  const ids = new Set<string>()
  const positions = new Set<number>()
  for (const option of parsed.data.options) {
    if (ids.has(option.id) || positions.has(option.position)) schemaConflict()
    ids.add(option.id)
    positions.add(option.position)
  }
  if (parsed.data.options.some((_, position) => !positions.has(position))) schemaConflict()
  return [...parsed.data.options].sort((left, right) => left.position - right.position)
}

function fixedCurrency(attributeValue: LoadedAttribute | undefined): string | undefined {
  if (attributeValue === undefined) return undefined
  if (attributeValue.type !== 'currency' || attributeValue.isMulti) {
    invalid('/amount_attribute', 'Must name a scalar fixed-currency attribute')
  }
  const parsed = CurrencyConfig.safeParse(attributeValue.config)
  if (!parsed.success) schemaConflict()
  if (parsed.data.fixedCurrency === undefined) {
    invalid('/amount_attribute', 'Currency must define fixedCurrency')
  }
  return parsed.data.fixedCurrency
}

function amountParts(
  amountAttribute: LoadedAttribute | undefined,
  currency: string | undefined,
): { sum: Prisma.Sql; invalid: Prisma.Sql } {
  if (amountAttribute === undefined || currency === undefined) {
    return { sum: Prisma.sql`NULL::text`, invalid: Prisma.sql`false` }
  }
  const slug = amountAttribute.slug
  const valid = Prisma.sql`jsonb_typeof(eligible.data -> ${slug}) = 'object'
    AND jsonb_typeof(eligible.data -> ${slug} -> 'amount') = 'string'
    AND jsonb_typeof(eligible.data -> ${slug} -> 'currency') = 'string'
    AND eligible.data -> ${slug} ->> 'amount' ~ ${DECIMAL_PATTERN}
    AND eligible.data -> ${slug} ->> 'currency' = ${currency}`
  return {
    sum: Prisma.sql`sum(CASE WHEN ${valid}
      THEN (eligible.data -> ${slug} ->> 'amount')::numeric END)::text`,
    invalid: Prisma.sql`bool_or(eligible.data ? ${slug} AND NOT (${valid}))`,
  }
}

function currentRow(
  row: SummaryRow,
  optionIds: ReadonlySet<string>,
  counts: Map<string, { count: number; amount: string | null }>,
): void {
  if (row.stageId === null) return
  if (!optionIds.has(row.stageId) || row.invalidAmount) schemaConflict()
  if (!Number.isInteger(row.count) || row.count < 0) schemaConflict()
  const amount = row.amountSum === null ? null : new Decimal(row.amountSum).toFixed()
  counts.set(row.stageId, { count: row.count, amount })
}

function durationRow(
  row: SummaryRow,
  optionIds: ReadonlySet<string>,
  durations: Map<string, number>,
): void {
  if (
    row.stageId === null
    || !optionIds.has(row.stageId)
    || row.averageDays === null
    || !Number.isFinite(row.averageDays)
    || row.averageDays < 0
  ) schemaConflict()
  durations.set(row.stageId, row.averageDays)
}

function conversionRow(row: SummaryRow, optionIds: ReadonlySet<string>): PipelineConversion {
  if (
    row.fromStage === null
    || row.toStage === null
    || !optionIds.has(row.fromStage)
    || !optionIds.has(row.toStage)
    || !Number.isInteger(row.count)
    || row.count < 1
  ) schemaConflict()
  return { from: row.fromStage, to: row.toStage, count: row.count }
}

export async function pipelineSummary(
  tx: PipelineSummaryTx,
  tenant: TenantRef,
  ctx: ActorContext,
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  input: PipelineSummaryInput,
): Promise<PipelineSummary> {
  assertScope(tenant, ctx, schema, objectType)
  if (input.since !== undefined && Number.isNaN(input.since.getTime())) {
    invalid('/since', 'Must be a valid timestamp')
  }
  const statusAttribute = attribute(schema, objectType, input.statusAttribute)
  const options = statusOptions(statusAttribute)
  const amountAttribute = input.amountAttribute === undefined
    ? undefined
    : attribute(schema, objectType, input.amountAttribute)
  const currency = fixedCurrency(amountAttribute)
  const access = compileRecordSet(tenant, ctx, schema, objectType, {
    ...(input.filter === undefined ? {} : { filter: input.filter }),
    attributes: amountAttribute === undefined
      ? [statusAttribute]
      : [statusAttribute, amountAttribute],
  })
  const optionIds = options.map((option) => option.id)
  const amount = amountParts(amountAttribute, currency)
  const since = input.since === undefined
    ? Prisma.sql`true`
    : Prisma.sql`mutations.occurred_at >= ${input.since}`
  const rows = await tx.$queryRaw<SummaryRow[]>(Prisma.sql`
    WITH eligible AS MATERIALIZED (
      SELECT r.id, r.data, r.data ->> ${statusAttribute.slug} AS stage_id
      FROM records r
      WHERE ${access} AND r.erased_at IS NULL
    ), status_mutations AS MATERIALIZED (
      SELECT changes.kind,
        changes.old_value,
        changes.new_value,
        changes.occurred_at,
        lead(changes.occurred_at) OVER (
          PARTITION BY changes.record_id ORDER BY changes.seq
        ) AS ended_at
      FROM record_changes changes
      JOIN eligible ON eligible.id = changes.record_id
      WHERE changes.organization_id = ${tenant.organizationId}::uuid
        AND changes.team_id = ${tenant.teamId}::uuid
        AND changes.attribute_slug = ${statusAttribute.slug}
        AND changes.kind IN ('set', 'unset')
    ), current_stages AS (
      SELECT eligible.stage_id,
        count(*)::integer AS count,
        ${amount.sum} AS amount_sum,
        ${amount.invalid} AS invalid_amount
      FROM eligible
      WHERE eligible.data ? ${statusAttribute.slug}
      GROUP BY eligible.stage_id
    ), durations AS (
      SELECT status_mutations.new_value #>> '{}' AS stage_id,
        avg(extract(epoch FROM (status_mutations.ended_at - status_mutations.occurred_at))
          / 86400.0)::double precision AS average_days
      FROM status_mutations
      WHERE status_mutations.kind = 'set'
        AND status_mutations.ended_at IS NOT NULL
        AND jsonb_typeof(status_mutations.new_value) = 'string'
        AND status_mutations.new_value #>> '{}' = ANY(${optionIds}::text[])
      GROUP BY status_mutations.new_value #>> '{}'
    ), mutations AS (
      SELECT * FROM status_mutations
    )
    SELECT 'current'::text AS "rowKind",
      current_stages.stage_id AS "stageId",
      current_stages.count,
      current_stages.amount_sum AS "amountSum",
      NULL::double precision AS "averageDays",
      NULL::text AS "fromStage",
      NULL::text AS "toStage",
      current_stages.invalid_amount AS "invalidAmount"
    FROM current_stages
    UNION ALL
    SELECT 'duration'::text,
      durations.stage_id,
      0::integer,
      NULL::text,
      durations.average_days,
      NULL::text,
      NULL::text,
      false
    FROM durations
    UNION ALL
    SELECT 'conversion'::text,
      NULL::text,
      count(*)::integer,
      NULL::text,
      NULL::double precision,
      mutations.old_value #>> '{}',
      mutations.new_value #>> '{}',
      false
    FROM mutations
    WHERE mutations.kind = 'set'
      AND jsonb_typeof(mutations.old_value) = 'string'
      AND jsonb_typeof(mutations.new_value) = 'string'
      AND mutations.old_value #>> '{}' <> mutations.new_value #>> '{}'
      AND mutations.old_value #>> '{}' = ANY(${optionIds}::text[])
      AND mutations.new_value #>> '{}' = ANY(${optionIds}::text[])
      AND ${since}
    GROUP BY mutations.old_value #>> '{}', mutations.new_value #>> '{}'
  `)
  const optionIdSet = new Set(optionIds)
  const counts = new Map<string, { count: number; amount: string | null }>()
  const durations = new Map<string, number>()
  const conversions: PipelineConversion[] = []
  for (const row of rows) {
    if (row.rowKind === 'current') currentRow(row, optionIdSet, counts)
    else if (row.rowKind === 'duration') durationRow(row, optionIdSet, durations)
    else if (row.rowKind === 'conversion') conversions.push(conversionRow(row, optionIdSet))
    else schemaConflict()
  }
  const position = new Map(options.map((option) => [option.id, option.position]))
  conversions.sort((left, right) => (
    (position.get(left.from) ?? 0) - (position.get(right.from) ?? 0)
    || (position.get(left.to) ?? 0) - (position.get(right.to) ?? 0)
  ))
  return {
    stages: options.map((option) => {
      const current = counts.get(option.id)
      return {
        id: option.id,
        label: option.label,
        category: option.category,
        count: current?.count ?? 0,
        amountSum: current === undefined || current.amount === null || currency === undefined
          ? null
          : { amount: current.amount, currency },
        averageDaysInStage: durations.get(option.id) ?? null,
      }
    }),
    conversions,
  }
}
