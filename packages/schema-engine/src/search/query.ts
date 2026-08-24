import { Prisma, type Db, type TenantRef } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import { rowAccess } from '../records/visibility.js'
import type { LoadedObjectType } from '../schema/load.js'
import type { Embedder } from './embedder.js'

export type SearchMatch = 'keyword' | 'semantic' | 'both'
export type SearchHit = {
  recordId: string
  objectTypeId: string
  displayName: string
  score: number
  match: SearchMatch
}
export type SearchTx = Pick<Db, '$queryRaw'>
export type SearchScope = {
  tenant: TenantRef
  ctx: ActorContext
  objectTypes: readonly LoadedObjectType[]
  sourceObjectTypes: readonly LoadedObjectType[]
  limit: number
}
export type SemanticInput =
  | { query: string; similarTo?: never }
  | { query?: never; similarTo: string }

type RawHit = Omit<SearchHit, 'match'> & { match: string }
type VectorRow = { embedding: string }
type SearchQueryInput = {
  scope: SearchScope
  objectTypes?: readonly LoadedObjectType[]
  select: Prisma.Sql
  where?: Prisma.Sql
  orderBy?: Prisma.Sql
  limit?: number
}

function access(
  scope: SearchScope,
  objectTypes: readonly LoadedObjectType[] = scope.objectTypes,
): Prisma.Sql {
  if (objectTypes.length === 0) return Prisma.sql`false`
  return Prisma.join(
    objectTypes.map((objectType) => Prisma.sql`(${rowAccess(
      scope.tenant, scope.ctx, objectType,
    )})`),
    ' OR ',
  )
}

export function searchQuery(input: SearchQueryInput): Prisma.Sql {
  const objects = input.objectTypes ?? input.scope.objectTypes
  return Prisma.sql`
    SELECT ${input.select}
    FROM record_search s JOIN records r ON r.id = s.record_id
    WHERE (${access(input.scope, objects)})
      ${input.where === undefined ? Prisma.empty : Prisma.sql`AND ${input.where}`}
    ${input.orderBy === undefined ? Prisma.empty : Prisma.sql`ORDER BY ${input.orderBy}`}
    ${input.limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${input.limit}`}
  `
}

function parseHits(rows: readonly RawHit[]): SearchHit[] {
  return rows.map((row) => {
    if (row.match !== 'keyword' && row.match !== 'semantic' && row.match !== 'both') {
      throw new ServiceError(ErrorCode.INTERNAL, 'Search returned an invalid match kind')
    }
    if (!Number.isFinite(row.score)) {
      throw new ServiceError(ErrorCode.INTERNAL, 'Search returned an invalid score')
    }
    return { ...row, match: row.match }
  })
}

function encodedVector(values: readonly number[]): string {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new ServiceError(ErrorCode.INTERNAL, 'Embedding query returned invalid values')
  }
  return `[${values.join(',')}]`
}

async function vector(
  tx: SearchTx,
  scope: SearchScope,
  input: SemanticInput,
  embedder: Embedder,
): Promise<string> {
  if (input.query !== undefined) {
    const values = (await embedder.embed([input.query]))[0]
    if (values === undefined) throw new ServiceError(ErrorCode.INTERNAL, 'Embedding query returned no value')
    return encodedVector(values)
  }
  const rows = await tx.$queryRaw<VectorRow[]>(searchQuery({
    scope,
    objectTypes: scope.sourceObjectTypes,
    select: Prisma.sql`s.embedding::text AS embedding`,
    where: Prisma.sql`r.id = ${input.similarTo}::uuid
      AND s.embedding IS NOT NULL AND s.embedding_model = ${embedder.model}`,
    limit: 1,
  }))
  const stored = rows[0]?.embedding
  if (stored === undefined) {
    throw new ServiceError(ErrorCode.NOT_FOUND, 'Similar record or current-model embedding not found')
  }
  return stored
}

export async function keywordSearch(
  tx: SearchTx,
  scope: SearchScope,
  query: string,
): Promise<SearchHit[]> {
  const rows = await tx.$queryRaw<RawHit[]>(searchQuery({
    scope,
    select: Prisma.sql`r.id AS "recordId", r.object_type_id AS "objectTypeId",
      r.display_name AS "displayName",
      ts_rank(s.tsv, plainto_tsquery('simple', ${query}))::float8 AS score,
      'keyword'::text AS match`,
    where: Prisma.sql`s.tsv @@ plainto_tsquery('simple', ${query})`,
    orderBy: Prisma.sql`score DESC, r.id ASC`,
    limit: scope.limit,
  }))
  return parseHits(rows)
}

export async function semanticSearch(
  tx: SearchTx,
  scope: SearchScope,
  input: SemanticInput,
  embedder: Embedder,
): Promise<SearchHit[]> {
  const queryVector = await vector(tx, scope, input, embedder)
  const rows = await tx.$queryRaw<RawHit[]>(searchQuery({
    scope,
    select: Prisma.sql`r.id AS "recordId", r.object_type_id AS "objectTypeId",
      r.display_name AS "displayName", (1 - (s.embedding <=> ${queryVector}::vector))::float8 AS score,
      'semantic'::text AS match`,
    where: Prisma.sql`s.embedding IS NOT NULL
      AND s.embedding_model = ${embedder.model}
      ${input.similarTo === undefined ? Prisma.empty : Prisma.sql`AND r.id <> ${input.similarTo}::uuid`}`,
    orderBy: Prisma.sql`s.embedding <=> ${queryVector}::vector, r.id ASC`,
    limit: scope.limit,
  }))
  return parseHits(rows)
}

export async function hybridSearch(
  tx: SearchTx,
  scope: SearchScope,
  query: string,
  embedder: Embedder,
): Promise<SearchHit[]> {
  const queryVector = await vector(tx, scope, { query }, embedder)
  const rows = await tx.$queryRaw<RawHit[]>(Prisma.sql`
    WITH eligible AS (${searchQuery({
      scope,
      select: Prisma.sql`s.record_id, s.tsv, s.embedding, s.embedding_model`,
    })}), keyword AS (
      SELECT record_id, row_number() OVER (
        ORDER BY ts_rank(tsv, plainto_tsquery('simple', ${query})) DESC, record_id
      ) AS rank
      FROM eligible WHERE tsv @@ plainto_tsquery('simple', ${query})
      ORDER BY ts_rank(tsv, plainto_tsquery('simple', ${query})) DESC, record_id LIMIT 50
    ), semantic AS (
      SELECT record_id, row_number() OVER (
        ORDER BY embedding <=> ${queryVector}::vector, record_id
      ) AS rank
      FROM eligible WHERE embedding IS NOT NULL AND embedding_model = ${embedder.model}
      ORDER BY embedding <=> ${queryVector}::vector, record_id LIMIT 50
    ), fused AS (
      SELECT COALESCE(keyword.record_id, semantic.record_id) AS record_id,
        (COALESCE(1.0 / (60 + keyword.rank), 0) + COALESCE(1.0 / (60 + semantic.rank), 0))::float8 AS score,
        CASE WHEN keyword.record_id IS NOT NULL AND semantic.record_id IS NOT NULL THEN 'both'
          WHEN keyword.record_id IS NOT NULL THEN 'keyword' ELSE 'semantic' END AS match
      FROM keyword FULL OUTER JOIN semantic USING (record_id)
    )
    SELECT r.id AS "recordId", r.object_type_id AS "objectTypeId",
      r.display_name AS "displayName", fused.score, fused.match
    FROM fused JOIN records r ON r.id = fused.record_id
    ORDER BY fused.score DESC, r.id ASC LIMIT ${scope.limit}
  `)
  return parseHits(rows)
}
