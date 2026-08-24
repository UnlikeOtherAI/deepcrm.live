import {
  loadSchema,
  timeline as engineTimeline,
  type TimelineInput as EngineTimelineInput,
  type TimelineKind as EngineTimelineKind,
} from '@deepcrm/schema-engine'
import {
  CrmRecordTimeline,
  ErrorCode,
  IsoDateTime,
  ServiceError,
  Slug,
  TimelineKind,
  Uuid,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { buildHistoryAccess } from './record-history.js'
import { recordBoundary } from './record-boundary.js'
import {
  createTimelineCursorCodec,
  type TimelineCursorBinding,
} from './timeline-cursor.js'
import { presentTimelineItems } from './timeline-presentation.js'

export type RecordTimelineInput = {
  id: string
  hops?: 0 | 1
  relationTypes?: readonly string[]
  kinds?: readonly EngineTimelineKind[]
  since?: string
  cursor?: string
  limit?: number
}

export type RecordTimelineResult = ReturnType<typeof CrmRecordTimeline.out.parse>

type NormalizedTimelineInput = {
  id: string
  hops: 0 | 1
  relationTypes?: readonly string[]
  kinds?: readonly EngineTimelineKind[]
  since?: string
  cursor?: string
  limit: number
}

function invalid(path: string, message: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Record timeline arguments are invalid', {
    issues: [{ path, message }],
  })
}

function normalizedStrings(
  values: readonly string[] | undefined,
  path: string,
): readonly string[] | undefined {
  if (values === undefined) return undefined
  const parsed = Slug.array().max(50).safeParse(values)
  if (!parsed.success) invalid(path, 'Must contain valid slugs')
  return [...new Set(parsed.data)].sort()
}

function normalizedKinds(
  values: readonly EngineTimelineKind[] | undefined,
): readonly EngineTimelineKind[] | undefined {
  if (values === undefined) return undefined
  const parsed = TimelineKind.array().max(4).safeParse(values)
  if (!parsed.success) invalid('/kinds', 'Must contain valid timeline kinds')
  return [...new Set(parsed.data)].sort()
}

function normalize(input: RecordTimelineInput): NormalizedTimelineInput {
  const id = Uuid.safeParse(input.id)
  if (!id.success) invalid('/id', 'Invalid record id')
  const hops = input.hops ?? 0
  if (hops !== 0 && hops !== 1) invalid('/hops', 'Must be 0 or 1')
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    invalid('/limit', 'Must be an integer from 1 to 200')
  }
  let since: string | undefined
  if (input.since !== undefined) {
    const parsed = IsoDateTime.safeParse(input.since)
    if (!parsed.success) invalid('/since', 'Must be ISO 8601 with an offset')
    since = new Date(parsed.data).toISOString()
  }
  const relationTypes = normalizedStrings(input.relationTypes, '/relation_types')
  const kinds = normalizedKinds(input.kinds)
  return {
    id: id.data,
    hops,
    ...(relationTypes === undefined ? {} : { relationTypes }),
    ...(kinds === undefined ? {} : { kinds }),
    ...(since === undefined ? {} : { since }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    limit,
  }
}

function cursorBinding(ctx: ActorContext, input: NormalizedTimelineInput): TimelineCursorBinding {
  return {
    tool: 'crm_record_timeline',
    tenant: ctx.tenant,
    arguments: {
      id: input.id,
      hops: input.hops,
      relation_types: input.relationTypes ?? null,
      kinds: input.kinds ?? null,
      since: input.since ?? null,
      limit: input.limit,
    },
  }
}

export async function recordTimeline(
  deps: AppDeps,
  ctx: ActorContext,
  input: RecordTimelineInput,
): Promise<RecordTimelineResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const normalized = normalize(input)
    const binding = cursorBinding(ctx, normalized)
    const codec = createTimelineCursorCodec(deps.secretBox)
    const after = normalized.cursor === undefined
      ? undefined
      : codec.open(normalized.cursor, binding)
    const schema = await loadSchema(deps.db, ctx.tenant)
    const historyAccess = await buildHistoryAccess(
      deps, ctx, 'crm_record_timeline', normalized.id,
    )
    const engineInput: EngineTimelineInput = {
      hops: normalized.hops,
      ...(normalized.relationTypes === undefined
        ? {} : { relationTypes: normalized.relationTypes }),
      ...(normalized.kinds === undefined ? {} : { kinds: normalized.kinds }),
      ...(normalized.since === undefined ? {} : { since: new Date(normalized.since) }),
      ...(after === undefined ? {} : { after }),
      limit: normalized.limit,
    }
    const page = await engineTimeline(
      deps.db, ctx.tenant, ctx, schema, normalized.id, engineInput,
    )
    const items = await presentTimelineItems(
      deps, ctx, schema, normalized.id, page.items, historyAccess,
    )
    return CrmRecordTimeline.out.parse({
      items,
      next_cursor: page.next === null ? null : codec.seal(page.next, binding),
    })
  })
}
