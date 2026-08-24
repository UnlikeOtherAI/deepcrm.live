import { Prisma, tenantWhere, type Db, type TenantRef } from '@deepcrm/db'
import {
  ErrorCode,
  ServiceError,
  SupportedIso4217CurrencyCode,
  type ActorContext,
  type Filter,
} from '@deepcrm/schemas'
import Decimal from 'decimal.js'
import { z } from 'zod'

import { compileRecordSet } from '../query/compile.js'
import type { LoadedAttribute, LoadedObjectType, LoadedSchema } from '../schema/load.js'

export type PipelineSummaryTx = Pick<Db, '$queryRaw' | 'pipeline' | 'pipelineStage'>

export type PipelineSummaryInput = Readonly<{
  pipeline?: string
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

export type PipelineConversion = Readonly<{ from: string; to: string; count: number }>
export type PipelineSummary = Readonly<{
  stages: readonly PipelineStageSummary[]
  conversions: readonly PipelineConversion[]
}>

type Stage = {
  id: string
  slug: string
  name: string
  position: number
  category: 'open' | 'won' | 'lost' | 'neutral'
}
type Row = {
  rowKind: 'current' | 'duration' | 'conversion'
  stageId: string | null
  count: number
  amountSum: string | null
  averageDays: number | null
  fromStage: string | null
  toStage: string | null
  invalidAmount: boolean
}

const CurrencyConfig = z.object({
  defaultCurrency: SupportedIso4217CurrencyCode,
  fixedCurrency: SupportedIso4217CurrencyCode.optional(),
}).strict()
const DECIMAL_PATTERN = '^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,4})?$'

function schemaConflict(detail = 'pipeline_metadata'): never {
  throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Pipeline schema metadata is inconsistent', { detail })
}

function invalid(path: string, message: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Pipeline summary arguments are invalid', {
    issues: [{ path, message }],
  })
}

async function pipeline(
  tx: PipelineSummaryTx,
  tenant: TenantRef,
  objectType: LoadedObjectType,
  slug: string | undefined,
): Promise<{ id: string; slug: string }> {
  const found = await tx.pipeline.findFirst({
    where: {
      ...tenantWhere(tenant),
      objectTypeId: objectType.id,
      archivedAt: null,
      ...(slug === undefined ? { isDefault: true } : { slug }),
    },
    select: { id: true, slug: true },
  })
  if (found === null) {
    throw new ServiceError(ErrorCode.NOT_FOUND, 'Pipeline not found')
  }
  return found
}

async function stages(tx: PipelineSummaryTx, tenant: TenantRef, pipelineId: string): Promise<readonly Stage[]> {
  const rows = await tx.pipelineStage.findMany({
    where: { ...tenantWhere(tenant), pipelineId, archivedAt: null },
    orderBy: [{ position: 'asc' }, { slug: 'asc' }],
    select: { id: true, slug: true, name: true, position: true, category: true },
  })
  if (rows.length === 0) schemaConflict('pipeline_has_no_active_stages')
  return rows
}

function attribute(
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  slug: string | undefined,
): LoadedAttribute | undefined {
  if (slug === undefined) return undefined
  const selected = schema.attributesByObjectTypeId.get(objectType.id)?.get(slug)
  if (selected !== undefined && selected.archivedAt === null) return selected
  throw new ServiceError(ErrorCode.UNKNOWN_ATTRIBUTE, 'Attribute does not exist', { attribute: slug })
}

function fixedCurrency(attributeValue: LoadedAttribute | undefined): string | undefined {
  if (attributeValue === undefined) return undefined
  if (attributeValue.type !== 'currency' || attributeValue.isMulti) {
    invalid('/amount_attribute', 'Must name a scalar fixed-currency attribute')
  }
  const parsed = CurrencyConfig.safeParse(attributeValue.config)
  if (!parsed.success) schemaConflict('currency_config')
  if (parsed.data.fixedCurrency === undefined) invalid('/amount_attribute', 'Currency must define fixedCurrency')
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

function consumeRows(
  rows: readonly Row[],
  stageIds: ReadonlySet<string>,
  stagePositions: ReadonlyMap<string, number>,
): {
  counts: Map<string, { count: number; amount: string | null }>
  durations: Map<string, number>
  conversions: PipelineConversion[]
} {
  const counts = new Map<string, { count: number; amount: string | null }>()
  const durations = new Map<string, number>()
  const conversions: PipelineConversion[] = []
  for (const row of rows) {
    if (row.rowKind === 'current') {
      if (row.stageId === null || !stageIds.has(row.stageId) || row.invalidAmount) schemaConflict()
      counts.set(row.stageId, {
        count: row.count,
        amount: row.amountSum === null ? null : new Decimal(row.amountSum).toFixed(),
      })
    } else if (row.rowKind === 'duration') {
      if (row.stageId === null || !stageIds.has(row.stageId) || row.averageDays === null) schemaConflict()
      durations.set(row.stageId, row.averageDays)
    } else {
      if (row.fromStage === null || row.toStage === null) schemaConflict()
      if (!stageIds.has(row.fromStage) || !stageIds.has(row.toStage)) schemaConflict()
      conversions.push({ from: row.fromStage, to: row.toStage, count: row.count })
    }
  }
  conversions.sort((left, right) => (
    (stagePositions.get(left.from) ?? Number.MAX_SAFE_INTEGER)
    - (stagePositions.get(right.from) ?? Number.MAX_SAFE_INTEGER)
    || (stagePositions.get(left.to) ?? Number.MAX_SAFE_INTEGER)
    - (stagePositions.get(right.to) ?? Number.MAX_SAFE_INTEGER)
    || left.from.localeCompare(right.from)
    || left.to.localeCompare(right.to)
  ))
  return { counts, durations, conversions }
}

export async function pipelineSummary(
  tx: PipelineSummaryTx,
  tenant: TenantRef,
  ctx: ActorContext,
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  input: PipelineSummaryInput,
): Promise<PipelineSummary> {
  if (schema.teamId !== tenant.teamId || objectType.archivedAt !== null) schemaConflict()
  if (input.since !== undefined && Number.isNaN(input.since.getTime())) {
    invalid('/since', 'Must be a valid Date')
  }
  const selectedPipeline = await pipeline(tx, tenant, objectType, input.pipeline)
  const selectedStages = await stages(tx, tenant, selectedPipeline.id)
  const amountAttribute = attribute(schema, objectType, input.amountAttribute)
  const currency = fixedCurrency(amountAttribute)
  const access = compileRecordSet(tenant, ctx, schema, objectType, {
    ...(input.filter === undefined ? {} : { filter: input.filter }),
    attributes: amountAttribute === undefined ? [] : [amountAttribute],
  })
  const amount = amountParts(amountAttribute, currency)
  const since = input.since === undefined
    ? Prisma.sql`true`
    : Prisma.sql`history.started_at >= ${input.since}`
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
    WITH eligible AS MATERIALIZED (
      SELECT r.id, r.data
      FROM records r
      WHERE ${access} AND r.erased_at IS NULL
    ), history AS MATERIALIZED (
      SELECT h.record_id, h.stage_id, h.started_at, h.ended_at,
        lag(h.stage_id) OVER (PARTITION BY h.record_id, h.pipeline_id ORDER BY h.started_at, h.created_at) AS from_stage
      FROM record_stage_history h
      JOIN eligible ON eligible.id = h.record_id
      WHERE h.organization_id = ${tenant.organizationId}::uuid
        AND h.team_id = ${tenant.teamId}::uuid
        AND h.pipeline_id = ${selectedPipeline.id}::uuid
    ), current_stages AS (
      SELECT history.stage_id,
        count(*)::integer AS count,
        ${amount.sum} AS amount_sum,
        ${amount.invalid} AS invalid_amount
      FROM history JOIN eligible ON eligible.id = history.record_id
      WHERE history.ended_at IS NULL
      GROUP BY history.stage_id
    ), durations AS (
      SELECT stage_id,
        avg(extract(epoch FROM (ended_at - started_at)) / 86400.0)::double precision AS average_days
      FROM history
      WHERE ended_at IS NOT NULL
      GROUP BY stage_id
    )
    SELECT 'current'::text AS "rowKind", stage_id AS "stageId", count, amount_sum AS "amountSum",
      NULL::double precision AS "averageDays", NULL::text AS "fromStage", NULL::text AS "toStage",
      invalid_amount AS "invalidAmount"
    FROM current_stages
    UNION ALL
    SELECT 'duration'::text, stage_id, 0::integer, NULL::text, average_days, NULL::text, NULL::text, false
    FROM durations
    UNION ALL
    SELECT 'conversion'::text, NULL::uuid, count(*)::integer, NULL::text, NULL::double precision,
      from_stage::text, stage_id::text, false
    FROM history
    WHERE from_stage IS NOT NULL AND from_stage <> stage_id AND ${since}
    GROUP BY from_stage, stage_id
  `)
  const stageIds = new Set(selectedStages.map((stage) => stage.id))
  const stageSlugs = new Map(selectedStages.map((stage) => [stage.id, stage.slug]))
  const stagePositions = new Map(selectedStages.map((stage) => [stage.id, stage.position]))
  const consumed = consumeRows(rows, stageIds, stagePositions)
  return {
    stages: selectedStages.map((stage) => {
      const current = consumed.counts.get(stage.id)
      return {
        id: stage.slug,
        label: stage.name,
        category: stage.category,
        count: current?.count ?? 0,
        amountSum: current === undefined || current.amount === null || currency === undefined
          ? null
          : { amount: current.amount, currency },
        averageDaysInStage: consumed.durations.get(stage.id) ?? null,
      }
    }),
    conversions: consumed.conversions.map((conversion) => ({
      from: stageSlugs.get(conversion.from) ?? schemaConflict(),
      to: stageSlugs.get(conversion.to) ?? schemaConflict(),
      count: conversion.count,
    })),
  }
}
