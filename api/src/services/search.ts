import {
  hybridSearch,
  keywordSearch,
  loadSchema,
  semanticSearch,
  type LoadedObjectType,
} from '@deepcrm/schema-engine'
import {
  CrmSearch,
  ErrorCode,
  ServiceError,
  type ActorContext,
  type SearchModeValue,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { recordBoundary } from './record-boundary.js'

export type SearchInput = {
  query?: string
  similarTo?: string
  objectTypes?: readonly string[]
  mode?: SearchModeValue
  limit?: number
}

export type SearchResult = {
  hits: Array<{
    record: { id: string; object_type: string; display_name: string }
    score: number
    match: 'keyword' | 'semantic' | 'both'
  }>
}

function invalid(message: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Search input is invalid', {
    issues: [{ path: '', message }],
  })
}

function selectedObjectTypes(
  schema: Awaited<ReturnType<typeof loadSchema>>,
  requested: readonly string[] | undefined,
): LoadedObjectType[] {
  if (requested === undefined) {
    return [...schema.objectTypesBySlug.values()]
      .filter((objectType) => objectType.archivedAt === null)
      .sort((left, right) => left.slug.localeCompare(right.slug))
  }
  return [...new Set(requested)].map((slug) => {
    const objectType = schema.objectTypesBySlug.get(slug)
    if (objectType === undefined || objectType.archivedAt !== null) {
      throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type does not exist', {
        object_type: slug,
      })
    }
    return objectType
  })
}

export async function searchRecords(
  deps: AppDeps,
  ctx: ActorContext,
  input: SearchInput,
): Promise<SearchResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const parsed = CrmSearch.in.safeParse({
      query: input.query,
      similar_to: input.similarTo,
      object_types: input.objectTypes,
      mode: input.mode,
      limit: input.limit,
    })
    if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? 'Invalid search arguments')
    const query = parsed.data.query?.trim()
    if (parsed.data.query !== undefined && query === '') invalid('Query must contain text')
    if (parsed.data.similar_to !== undefined && parsed.data.mode === 'keyword') {
      invalid('similar_to requires semantic or hybrid mode')
    }
    const schema = await loadSchema(deps.db, ctx.tenant)
    const sourceObjectTypes = selectedObjectTypes(schema, undefined)
    const objectTypes = selectedObjectTypes(schema, parsed.data.object_types)
    const scope = { tenant: ctx.tenant, ctx, objectTypes, sourceObjectTypes, limit: parsed.data.limit }
    const hits = parsed.data.similar_to !== undefined
      ? await semanticSearch(deps.db, scope, { similarTo: parsed.data.similar_to }, deps.embedder)
      : parsed.data.mode === 'keyword'
        ? await keywordSearch(deps.db, scope, query ?? '')
        : parsed.data.mode === 'semantic'
          ? await semanticSearch(deps.db, scope, { query: query ?? '' }, deps.embedder)
          : await hybridSearch(deps.db, scope, query ?? '', deps.embedder)
    return {
      hits: hits.map((hit) => {
        const objectType = schema.objectTypesById.get(hit.objectTypeId)
        if (objectType === undefined) {
          throw new ServiceError(ErrorCode.INTERNAL, 'Search hit object type is not active')
        }
        return {
          record: {
            id: hit.recordId,
            object_type: objectType.slug,
            display_name: hit.displayName,
          },
          score: hit.score,
          match: hit.match,
        }
      }),
    }
  })
}
