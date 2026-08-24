import {
  loadSchema,
  pipelineSummary as enginePipelineSummary,
  type LoadedAttribute,
} from '@deepcrm/schema-engine'
import {
  CrmPipelineSummary,
  ErrorCode,
  Filter as FilterSchema,
  IsoDateTime,
  ServiceError,
  Slug,
  type ActorContext,
  type Filter,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { loadPolicyEvaluator, type PolicyRequest } from './policy.js'
import { recordBoundary } from './record-boundary.js'
import {
  attributeRequest,
  filterAttributes,
  preauthorize,
  queryScopes,
  selectedAttribute,
  selectedObjectType,
} from './record-query-authorization.js'

export type PipelineSummaryInput = {
  objectType: string
  statusAttribute?: string
  amountAttribute?: string
  filter?: Filter
  since?: string
}

export type PipelineSummaryResult = ReturnType<typeof CrmPipelineSummary.out.parse>

type NormalizedInput = {
  objectType: string
  statusAttribute?: string
  amountAttribute?: string
  filter?: Filter
  since?: string
}

function pointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return ''
  return `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`
}

function invalid(path: string, message: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Pipeline summary arguments are invalid', {
    issues: [{ path, message }],
  })
}

function optionalSlug(value: string | undefined, path: string): string | undefined {
  if (value === undefined) return undefined
  const parsed = Slug.safeParse(value)
  if (!parsed.success) invalid(path, 'Must be a valid attribute slug')
  return parsed.data
}

function normalize(input: PipelineSummaryInput): NormalizedInput {
  const objectType = Slug.safeParse(input.objectType)
  if (!objectType.success) invalid('/object_type', 'Must be a valid object type slug')
  let filter: Filter | undefined
  if (input.filter !== undefined) {
    const parsed = FilterSchema.safeParse(input.filter)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      invalid(pointer(issue?.path ?? []), issue?.message ?? 'Invalid filter')
    }
    filter = parsed.data
  }
  let since: string | undefined
  if (input.since !== undefined) {
    const parsed = IsoDateTime.safeParse(input.since)
    if (!parsed.success) invalid('/since', 'Must be ISO 8601 with an offset')
    since = new Date(parsed.data).toISOString()
  }
  const statusAttribute = optionalSlug(input.statusAttribute, '/status_attribute')
  const amountAttribute = optionalSlug(input.amountAttribute, '/amount_attribute')
  return {
    objectType: objectType.data,
    ...(statusAttribute === undefined ? {} : { statusAttribute }),
    ...(amountAttribute === undefined ? {} : { amountAttribute }),
    ...(filter === undefined ? {} : { filter }),
    ...(since === undefined ? {} : { since }),
  }
}

function statusAttribute(
  attributes: readonly LoadedAttribute[],
): LoadedAttribute {
  const candidates = attributes.filter((attribute) => (
    attribute.archivedAt === null && attribute.type === 'status' && !attribute.isMulti
  ))
  if (candidates.length !== 1) {
    invalid('/status_attribute', 'Required unless the object has exactly one active status attribute')
  }
  const selected = candidates[0]
  if (selected === undefined) invalid('/status_attribute', 'Status attribute is required')
  return selected
}

export async function pipelineSummary(
  deps: AppDeps,
  ctx: ActorContext,
  input: PipelineSummaryInput,
): Promise<PipelineSummaryResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const normalized = normalize(input)
    const schema = await loadSchema(deps.db, ctx.tenant)
    const objectType = selectedObjectType(schema, normalized.objectType)
    const selectedStatus = normalized.statusAttribute === undefined
      ? statusAttribute(objectType.attributes)
      : selectedAttribute(schema, objectType, normalized.statusAttribute)
    if (selectedStatus.type !== 'status' || selectedStatus.isMulti) {
      invalid('/status_attribute', 'Must name a scalar status attribute')
    }
    const selectedAmount = normalized.amountAttribute === undefined
      ? undefined
      : selectedAttribute(schema, objectType, normalized.amountAttribute)
    if (selectedAmount !== undefined && (
      selectedAmount.type !== 'currency' || selectedAmount.isMulti
    )) invalid('/amount_attribute', 'Must name a scalar fixed-currency attribute')

    const sensitiveSlugs = filterAttributes(normalized.filter)
    sensitiveSlugs.add(selectedStatus.slug)
    if (selectedAmount !== undefined) sensitiveSlugs.add(selectedAmount.slug)
    const sensitiveAttributes = [...sensitiveSlugs].sort().map((slug) => (
      selectedAttribute(schema, objectType, slug)
    ))
    const scopes = queryScopes(ctx, objectType)
    const recordRequest: PolicyRequest = {
      resourceType: 'record', action: 'view', scopes,
    }
    const attributeRequests = sensitiveAttributes.map((attribute) => (
      attributeRequest(scopes, attribute)
    ))
    const evaluator = await loadPolicyEvaluator(deps.db, ctx, [recordRequest, ...attributeRequests])
    await preauthorize(
      deps,
      ctx,
      objectType,
      evaluator,
      [recordRequest, ...attributeRequests],
      'crm_pipeline_summary',
    )
    const result = await enginePipelineSummary(
      deps.db,
      ctx.tenant,
      ctx,
      schema,
      objectType,
      {
        statusAttribute: selectedStatus.slug,
        ...(selectedAmount === undefined ? {} : { amountAttribute: selectedAmount.slug }),
        ...(normalized.filter === undefined ? {} : { filter: normalized.filter }),
        ...(normalized.since === undefined ? {} : { since: new Date(normalized.since) }),
      },
    )
    return CrmPipelineSummary.out.parse({
      stages: result.stages.map((stage) => ({
        id: stage.id,
        label: stage.label,
        category: stage.category,
        count: stage.count,
        amount_sum: stage.amountSum,
        avg_days_in_stage: stage.averageDaysInStage,
      })),
      conversions: result.conversions,
    })
  })
}
