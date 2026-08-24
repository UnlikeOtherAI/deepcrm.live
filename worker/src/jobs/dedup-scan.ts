import { Prisma, type Db } from '@deepcrm/db'
import {
  attributeReadAccess,
  compileRecordSet,
  loadSchema,
  type LoadedAttribute,
  type LoadedMatchingRule,
  type LoadedObjectType,
} from '@deepcrm/schema-engine'
import {
  ErrorCode,
  FindDuplicatesPayload,
  FindDuplicatesResult,
  ServiceError,
  type ActorContext,
} from '@deepcrm/schemas'

import type { JobHandler, JobHandlerInput } from '../index.js'

export const DEDUP_SCAN_JOB = 'records.dedup_scan'

type RecordSummary = { id: string; objectType: string; displayName: string }
type Evidence = {
  kind: 'unique' | 'exact' | 'normalized' | 'fuzzy' | 'semantic'
  attribute: string | null
  matched: true
  score?: number
}
type Pair = { left: string; right: string; evidence: Evidence[] }
type KeyGroupRow = { recordIds: string[] }
type ScoredPairRow = { left: string; right: string; score: number }

class DisjointSet {
  readonly #parent = new Map<string, string>()

  add(value: string): void {
    if (!this.#parent.has(value)) this.#parent.set(value, value)
  }

  find(value: string): string {
    this.add(value)
    const parent = this.#parent.get(value)
    if (parent === undefined || parent === value) return value
    const root = this.find(parent)
    this.#parent.set(value, root)
    return root
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left)
    const rightRoot = this.find(right)
    if (leftRoot !== rightRoot) this.#parent.set(rightRoot, leftRoot)
  }
}

function actorContext(
  input: JobHandlerInput,
  payload: ReturnType<typeof FindDuplicatesPayload.parse>,
): ActorContext {
  return { ...payload.actorContext, now: input.clock() }
}

function assertScope(
  input: JobHandlerInput,
  payload: ReturnType<typeof FindDuplicatesPayload.parse>,
): void {
  if (
    input.job.type !== DEDUP_SCAN_JOB
    || input.job.organizationId !== payload.organizationId
    || input.job.teamId !== payload.teamId
    || payload.actorContext.tenant.organizationId !== payload.organizationId
    || payload.actorContext.tenant.teamId !== payload.teamId
  ) {
    throw new Error('Dedup scan payload tenant does not match the claimed job')
  }
}

async function stillRunning(input: JobHandlerInput): Promise<boolean> {
  const row = await input.db.queueJob.findFirst({
    where: {
      id: input.job.id,
      organizationId: input.job.organizationId,
      teamId: input.job.teamId,
      type: DEDUP_SCAN_JOB,
    },
    select: { status: true },
  })
  return row?.status === 'running'
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`
}

function addPair(pairs: Map<string, Pair>, left: string, right: string, evidence: Evidence[]): void {
  if (left === right) return
  const key = pairKey(left, right)
  const ordered = left < right ? { left, right } : { left: right, right: left }
  const existing = pairs.get(key)
  if (existing === undefined) {
    pairs.set(key, { ...ordered, evidence })
    return
  }
  existing.evidence.push(...evidence)
}

function matchingEvidence(rule: LoadedMatchingRule): Evidence[] {
  return rule.attributeSlugs.map((attribute) => ({
    kind: rule.method,
    attribute,
    matched: true,
  }))
}

async function keyedPairs(
  db: Db,
  eligible: Prisma.Sql,
  rule: LoadedMatchingRule,
  pairs: Map<string, Pair>,
): Promise<void> {
  const groups = await db.$queryRaw<KeyGroupRow[]>(Prisma.sql`
    SELECT array_agg(r.id::text ORDER BY r.id) AS "recordIds"
    FROM record_match_lookup_keys k
    JOIN records r ON r.id = k.record_id
    WHERE ${eligible} AND k.matching_rule_id = ${rule.id}::uuid
    GROUP BY k.normalized_hash HAVING count(*) > 1
    ORDER BY min(r.id::text)
  `)
  for (const group of groups) {
    for (let left = 0; left < group.recordIds.length; left += 1) {
      for (let right = left + 1; right < group.recordIds.length; right += 1) {
        const leftId = group.recordIds[left]
        const rightId = group.recordIds[right]
        if (leftId !== undefined && rightId !== undefined) {
          addPair(pairs, leftId, rightId, matchingEvidence(rule))
        }
      }
    }
  }
}

function fuzzyExpression(attribute: LoadedAttribute): Prisma.Sql {
  return attribute.type === 'personal_name'
    ? Prisma.sql`r.data -> ${attribute.slug} ->> 'full'`
    : Prisma.sql`r.data ->> ${attribute.slug}`
}

async function fuzzyPairs(
  db: Db,
  eligible: Prisma.Sql,
  rule: LoadedMatchingRule,
  attribute: LoadedAttribute,
  readable: ReadonlySet<string>,
  pairs: Map<string, Pair>,
): Promise<void> {
  const threshold = Math.max(rule.threshold ?? 0.5, 0.5)
  const leftValue = fuzzyExpression(attribute)
  const rightValue = attribute.type === 'personal_name'
    ? Prisma.sql`other.data -> ${attribute.slug} ->> 'full'`
    : Prisma.sql`other.data ->> ${attribute.slug}`
  const rows = await db.$queryRaw<ScoredPairRow[]>(Prisma.sql`
    WITH eligible AS (
      SELECT r.id, r.data FROM records r WHERE ${eligible}
    )
    SELECT r.id::text AS left, other.id::text AS right,
      similarity(${leftValue}, ${rightValue})::float8 AS score
    FROM eligible r JOIN eligible other ON r.id < other.id
    WHERE ${leftValue} IS NOT NULL AND ${rightValue} IS NOT NULL
      AND similarity(${leftValue}, ${rightValue}) >= ${threshold}
    ORDER BY r.id, other.id
  `)
  for (const row of rows) {
    const score = readable.has(row.left) && readable.has(row.right)
      ? { score: row.score }
      : {}
    addPair(pairs, row.left, row.right, [{
      kind: 'fuzzy', attribute: attribute.slug, matched: true, ...score,
    }])
  }
}

async function readableRecordIds(
  db: Db,
  eligible: Prisma.Sql,
  access: Prisma.Sql,
): Promise<ReadonlySet<string>> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT r.id::text AS id FROM records r WHERE ${eligible}${access}
  `)
  return new Set(rows.map((row) => row.id))
}

async function semanticPairs(
  db: Db,
  eligible: Prisma.Sql,
  embeddingModel: string,
  pairs: Map<string, Pair>,
): Promise<void> {
  const rows = await db.$queryRaw<ScoredPairRow[]>(Prisma.sql`
    WITH eligible AS (
      SELECT r.id FROM records r WHERE ${eligible}
    )
    SELECT left_search.record_id::text AS left, right_search.record_id::text AS right,
      (1 - (left_search.embedding <=> right_search.embedding))::float8 AS score
    FROM record_search left_search
    JOIN record_search right_search ON left_search.record_id < right_search.record_id
    JOIN eligible left_record ON left_record.id = left_search.record_id
    JOIN eligible right_record ON right_record.id = right_search.record_id
    WHERE left_search.embedding IS NOT NULL AND right_search.embedding IS NOT NULL
      AND left_search.embedding_model = ${embeddingModel}
      AND right_search.embedding_model = ${embeddingModel}
      AND (left_search.embedding <=> right_search.embedding) < 0.08
    ORDER BY left_search.record_id, right_search.record_id
  `)
  for (const row of rows) {
    addPair(pairs, row.left, row.right, [{
      kind: 'semantic', attribute: null, matched: true, score: row.score,
    }])
  }
}

function distinctEvidence(values: readonly Evidence[]): Evidence[] {
  const result = new Map<string, Evidence>()
  for (const value of values) {
    const key = `${value.kind}:${value.attribute ?? ''}`
    const current = result.get(key)
    if (current === undefined || (value.score ?? -1) > (current.score ?? -1)) result.set(key, value)
  }
  return [...result.values()].sort((left, right) => (
    left.kind.localeCompare(right.kind) || (left.attribute ?? '').localeCompare(right.attribute ?? '')
  ))
}

async function summaries(
  db: Db,
  eligible: Prisma.Sql,
  objectType: LoadedObjectType,
): Promise<Map<string, RecordSummary>> {
  const rows = await db.$queryRaw<Array<{ id: string; displayName: string }>>(Prisma.sql`
    SELECT r.id::text AS id, r.display_name AS "displayName"
    FROM records r WHERE ${eligible} ORDER BY r.id
  `)
  return new Map(rows.map((row) => [row.id, {
    id: row.id, objectType: objectType.slug, displayName: row.displayName,
  }]))
}

function groups(pairs: Map<string, Pair>, records: Map<string, RecordSummary>) {
  const set = new DisjointSet()
  for (const pair of pairs.values()) set.union(pair.left, pair.right)
  const idsByRoot = new Map<string, string[]>()
  for (const pair of pairs.values()) {
    for (const id of [pair.left, pair.right]) {
      const root = set.find(id)
      const ids = idsByRoot.get(root) ?? []
      if (!ids.includes(id)) ids.push(id)
      idsByRoot.set(root, ids)
    }
  }
  return [...idsByRoot.values()].map((ids) => {
    const members = ids.sort().flatMap((id) => {
      const record = records.get(id)
      return record === undefined ? [] : [{
        id: record.id, object_type: record.objectType, display_name: record.displayName,
      }]
    })
    const memberIds = new Set(ids)
    const evidence = distinctEvidence([...pairs.values()].flatMap((pair) => (
      memberIds.has(pair.left) && memberIds.has(pair.right) ? pair.evidence : []
    )))
    return { records: members, evidence }
  }).filter((group) => group.records.length >= 2)
    .sort((left, right) => (left.records[0]?.id ?? '').localeCompare(right.records[0]?.id ?? ''))
}

function inputJson(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(inputJson)
  if (typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue | null> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = inputJson(item)
    }
    return result
  }
  throw new ServiceError(ErrorCode.INTERNAL, 'Dedup scan result is not JSON')
}

export function createDedupScanHandler(): JobHandler {
  return async (input) => {
    const payload = FindDuplicatesPayload.parse(input.job.payload)
    assertScope(input, payload)
    const ctx = actorContext(input, payload)
    const schema = await loadSchema(input.db, ctx.tenant)
    const objectType = schema.objectTypesBySlug.get(payload.objectType)
    if (objectType === undefined || objectType.archivedAt !== null) {
      throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type does not exist')
    }
    const eligible = compileRecordSet(ctx.tenant, ctx, schema, objectType, {
      ...(payload.filter === undefined ? {} : { filter: payload.filter }),
    })
    const rules = schema.matchingRulesByObjectTypeId.get(objectType.id) ?? []
    const total = rules.length + (payload.includeSemantic ? 1 : 0) + 1
    const pairs = new Map<string, Pair>()
    let done = 0
    for (const rule of rules) {
      if (!await stillRunning(input)) return
      if (rule.method === 'fuzzy') {
        const slug = rule.attributeSlugs[0]
        const attribute = slug === undefined
          ? undefined
          : schema.attributesByObjectTypeId.get(objectType.id)?.get(slug)
        if (attribute === undefined) {
          throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Matching rule attribute is missing')
        }
        const readable = await readableRecordIds(input.db, eligible, attributeReadAccess(
          ctx.tenant, ctx, objectType, [attribute],
        ))
        await fuzzyPairs(input.db, eligible, rule, attribute, readable, pairs)
      } else {
        await keyedPairs(input.db, eligible, rule, pairs)
      }
      done += 1
      if (!await input.progress({ done, total })) return
    }
    if (payload.includeSemantic) {
      if (!await stillRunning(input)) return
      await semanticPairs(input.db, eligible, payload.embeddingModel, pairs)
      done += 1
      if (!await input.progress({ done, total })) return
    }
    const records = await summaries(input.db, eligible, objectType)
    const result = FindDuplicatesResult.parse({ groups: groups(pairs, records) })
    if (!await input.progress({ done: total, total })) return
    return input.db.$transaction(async (tx) => {
      const completed = await input.terminalize(tx, inputJson(result))
      return completed ? { terminalized: true } : undefined
    })
  }
}
