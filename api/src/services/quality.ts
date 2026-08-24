import {
  loadSchema,
  reportDataQuality,
  type DataQualityReport as EngineDataQualityReport,
  type LoadedObjectType,
} from '@deepcrm/schema-engine'
import {
  CrmDataQuality,
  ErrorCode,
  ServiceError,
  type ActorContext,
  type Filter,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { recordBoundary } from './record-boundary.js'

export type DataQualityInput = {
  objectType?: string
  staleDays?: number
}

type DataQualityBucket = {
  count: number
  items: Array<{
    record: { id: string; object_type: string; display_name: string }
    detail: string
  }>
  query_filter: Filter
}

export type DataQualityResult = {
  missing_required: DataQualityBucket
  stale: DataQualityBucket
  orphans: DataQualityBucket
  collisions: DataQualityBucket
}

function invalid(message: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Data-quality input is invalid', {
    issues: [{ path: '', message }],
  })
}

function selectedObjectTypes(
  schema: Awaited<ReturnType<typeof loadSchema>>,
  objectType: string | undefined,
): LoadedObjectType[] {
  if (objectType === undefined) {
    return [...schema.objectTypesBySlug.values()]
      .filter((item) => item.archivedAt === null)
      .sort((left, right) => left.slug.localeCompare(right.slug))
  }
  const selected = schema.objectTypesBySlug.get(objectType)
  if (selected === undefined || selected.archivedAt !== null) {
    throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type does not exist', {
      object_type: objectType,
    })
  }
  return [selected]
}

function bucket(value: EngineDataQualityReport['stale']): DataQualityBucket {
  return {
    count: value.count,
    items: value.items.map((item) => ({
      record: {
        id: item.recordId,
        object_type: item.objectType,
        display_name: item.displayName,
      },
      detail: item.detail,
    })),
    query_filter: value.queryFilter,
  }
}

export async function dataQualityReport(
  deps: AppDeps,
  ctx: ActorContext,
  input: DataQualityInput,
): Promise<DataQualityResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const parsed = CrmDataQuality.in.safeParse({
      object_type: input.objectType,
      stale_days: input.staleDays,
    })
    if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? 'Invalid data-quality arguments')
    const schema = await loadSchema(deps.db, ctx.tenant)
    const objectTypes = selectedObjectTypes(schema, parsed.data.object_type)
    const result = await reportDataQuality(
      deps.db, ctx, schema, objectTypes, parsed.data.stale_days,
    )
    return {
      missing_required: bucket(result.missingRequired),
      stale: bucket(result.stale),
      orphans: bucket(result.orphans),
      collisions: bucket(result.collisions),
    }
  })
}
