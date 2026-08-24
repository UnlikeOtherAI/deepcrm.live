import { Prisma, type Db } from '@deepcrm/db'
import type { ActorContext, Filter } from '@deepcrm/schemas'

import { attributeReadAccess, rowAccess } from '../records/visibility.js'
import type {
  LoadedAttribute, LoadedObjectType, LoadedRelationType, LoadedSchema,
} from '../schema/load.js'

export type QualityItem = {
  recordId: string
  objectType: string
  displayName: string
  detail: string
}

export type QualityBucket = {
  count: number
  items: readonly QualityItem[]
  queryFilter: Filter
}

export type DataQualityReport = {
  missingRequired: QualityBucket
  stale: QualityBucket
  orphans: QualityBucket
  collisions: QualityBucket
}

type ReportRow = {
  recordId: string
  objectType: string
  displayName: string
  detail: string
  total: number
}

type CollisionRow = ReportRow & {
  values: Array<{ attribute: string; value: unknown; multi: boolean }>
}

function bucket(rows: readonly ReportRow[], queryFilter: Filter): QualityBucket {
  return {
    count: rows[0]?.total ?? 0,
    items: rows.map((row) => ({
      recordId: row.recordId,
      objectType: row.objectType,
      displayName: row.displayName,
      detail: row.detail,
    })),
    queryFilter,
  }
}

async function groupedIssues(db: Db, branches: readonly Prisma.Sql[]): Promise<ReportRow[]> {
  if (branches.length === 0) return []
  return db.$queryRaw<ReportRow[]>(Prisma.sql`
    SELECT grouped."recordId", grouped."objectType", grouped."displayName", grouped.detail,
      count(*) OVER ()::int AS total
    FROM (
      SELECT issues."recordId", issues."objectType", issues."displayName",
        string_agg(issues.detail, '; ' ORDER BY issues.detail) AS detail
      FROM (${Prisma.join(branches, ' UNION ALL ')}) issues
      GROUP BY issues."recordId", issues."objectType", issues."displayName"
    ) grouped
    ORDER BY grouped."objectType", grouped."recordId"
    LIMIT 100
  `)
}

function missingBranches(
  ctx: ActorContext, objectTypes: readonly LoadedObjectType[],
): Prisma.Sql[] {
  const sql: Prisma.Sql[] = []
  for (const objectType of objectTypes) {
    for (const attribute of objectType.attributes.filter((item) => item.isRequired)) {
      sql.push(Prisma.sql`
        SELECT r.id::text AS "recordId", ${objectType.slug}::text AS "objectType",
          r.display_name AS "displayName", ${`missing required attribute: ${attribute.slug}`}::text AS detail
        FROM records r
        WHERE ${rowAccess(ctx.tenant, ctx, objectType)}
          ${attributeReadAccess(ctx.tenant, ctx, objectType, [attribute])}
          AND NOT (r.data ? ${attribute.slug})
      `)
    }
  }
  return sql
}

function staleBranches(
  ctx: ActorContext, objectTypes: readonly LoadedObjectType[], staleBefore: Date,
): Prisma.Sql[] {
  return objectTypes.map((objectType) => Prisma.sql`
    SELECT r.id::text AS "recordId", ${objectType.slug}::text AS "objectType",
      r.display_name AS "displayName", 'no activity inside the requested window'::text AS detail
    FROM records r
    WHERE ${rowAccess(ctx.tenant, ctx, objectType)}
      AND (r.last_activity_at IS NULL OR r.last_activity_at < ${staleBefore})
  `)
}

function orphanPairs(
  schema: LoadedSchema, objectTypes: readonly LoadedObjectType[],
): Array<{ relation: LoadedRelationType; objectType: LoadedObjectType }> {
  const selected = new Set(objectTypes.map((objectType) => objectType.id))
  const relations = schema.relationTypes.filter((relation) => (
    relation.archivedAt === null
    && relation.cardinality === 'many_to_one'
    && relation.onDelete === 'restrict'
    && (relation.fromObjectTypeId === null || selected.has(relation.fromObjectTypeId))
  ))
  return objectTypes.flatMap((objectType) => relations
    .filter((relation) => (
      relation.fromObjectTypeId === null || relation.fromObjectTypeId === objectType.id
    ))
    .map((relation) => ({ relation, objectType })))
}

function orphanBranches(
  ctx: ActorContext, schema: LoadedSchema, objectTypes: readonly LoadedObjectType[],
): Prisma.Sql[] {
  const sql: Prisma.Sql[] = []
  for (const { relation, objectType } of orphanPairs(schema, objectTypes)) {
    sql.push(Prisma.sql`
      SELECT r.id::text AS "recordId", ${objectType.slug}::text AS "objectType",
        r.display_name AS "displayName", ${`missing required relation: ${relation.slug}`}::text AS detail
      FROM records r
      WHERE ${rowAccess(ctx.tenant, ctx, objectType)}
        AND NOT EXISTS (
          SELECT 1 FROM record_links l
          WHERE l.organization_id = r.organization_id AND l.team_id = r.team_id
            AND l.relation_type_id = ${relation.id}::uuid
            AND l.from_record_id = r.id AND l.active_until IS NULL
        )
    `)
  }
  return sql
}

function normalizedValue(attribute: LoadedAttribute): Prisma.Sql {
  if (attribute.type === 'text') {
    return Prisma.sql`lower(regexp_replace(btrim(value #>> '{}'), '\\s+', ' ', 'g'))`
  }
  if (attribute.type === 'personal_name') {
    return Prisma.sql`lower(regexp_replace(btrim(value ->> 'full'), '\\s+', ' ', 'g'))`
  }
  if (attribute.type === 'registry_id') {
    return Prisma.sql`regexp_replace(upper(value #>> '{}'), '^[0]+|[\\s.-]', '', 'g')`
  }
  return Prisma.sql`value::text`
}

function collisionValueBranch(
  ctx: ActorContext, objectType: LoadedObjectType, attribute: LoadedAttribute,
): Prisma.Sql {
  const values = attribute.isMulti
    ? Prisma.sql`jsonb_array_elements(r.data -> ${attribute.slug}) AS expanded(value)`
    : Prisma.sql`(SELECT r.data -> ${attribute.slug} AS value) AS expanded`
  return Prisma.sql`
    SELECT r.id::text AS "recordId", ${objectType.slug}::text AS "objectType",
      r.display_name AS "displayName", ${attribute.id}::uuid AS "attributeId",
      ${attribute.slug}::text AS attribute, ${attribute.isMulti}::boolean AS multi,
      expanded.value AS value, ${normalizedValue(attribute)} AS normalized
    FROM records r CROSS JOIN LATERAL ${values}
    WHERE ${rowAccess(ctx.tenant, ctx, objectType)}
      ${attributeReadAccess(ctx.tenant, ctx, objectType, [attribute])}
      AND r.data ? ${attribute.slug} AND r.data -> ${attribute.slug} <> 'null'::jsonb
  `
}

async function collisionRows(
  db: Db, ctx: ActorContext, objectTypes: readonly LoadedObjectType[],
): Promise<CollisionRow[]> {
  const branches = objectTypes.flatMap((objectType) => objectType.attributes
    .filter((attribute) => attribute.isUnique)
    .map((attribute) => collisionValueBranch(ctx, objectType, attribute)))
  if (branches.length === 0) return []
  return db.$queryRaw<CollisionRow[]>(Prisma.sql`
    WITH attribute_values AS MATERIALIZED (${Prisma.join(branches, ' UNION ALL ')}),
    hashed_values AS MATERIALIZED (
      SELECT attribute_values.*,
        encode(digest(convert_to(attribute_values.normalized, 'UTF8'), 'sha256'), 'hex') AS "normalizedHash"
      FROM attribute_values WHERE attribute_values.normalized IS NOT NULL
    ),
    duplicates AS (
      SELECT values.* FROM hashed_values values
      WHERE EXISTS (
        SELECT 1 FROM hashed_values other
        WHERE other."attributeId" = values."attributeId"
          AND other."normalizedHash" = values."normalizedHash"
          AND other."recordId" <> values."recordId"
      )
    ), grouped AS (
      SELECT duplicates."recordId", duplicates."objectType", duplicates."displayName",
        string_agg(DISTINCT 'duplicate unique attribute: ' || duplicates.attribute,
          '; ' ORDER BY 'duplicate unique attribute: ' || duplicates.attribute) AS detail,
        jsonb_agg(DISTINCT jsonb_build_object(
          'attribute', duplicates.attribute, 'value', duplicates.value, 'multi', duplicates.multi
        )) AS values
      FROM duplicates
      GROUP BY duplicates."recordId", duplicates."objectType", duplicates."displayName"
    )
    SELECT grouped.*, count(*) OVER ()::int AS total
    FROM grouped ORDER BY grouped."objectType", grouped."recordId" LIMIT 100
  `)
}

function any(predicates: readonly Prisma.Sql[]): Prisma.Sql {
  if (predicates.length === 0) return Prisma.sql`false`
  return Prisma.sql`(${Prisma.join(predicates, ' OR ')})`
}

function missingPredicate(ctx: ActorContext, objectType: LoadedObjectType): Prisma.Sql {
  return any(objectType.attributes.filter((attribute) => attribute.isRequired).map((attribute) => (
    Prisma.sql`(true ${attributeReadAccess(ctx.tenant, ctx, objectType, [attribute])}
      AND NOT (r.data ? ${attribute.slug}))`
  )))
}

function orphanPredicate(
  schema: LoadedSchema, objectType: LoadedObjectType,
): Prisma.Sql {
  const pairs = orphanPairs(schema, [objectType])
  return any(pairs.map(({ relation }) => Prisma.sql`NOT EXISTS (
    SELECT 1 FROM record_links l
    WHERE l.organization_id = r.organization_id AND l.team_id = r.team_id
      AND l.relation_type_id = ${relation.id}::uuid
      AND l.from_record_id = r.id AND l.active_until IS NULL
  )`))
}

function collisionPredicate(
  ctx: ActorContext, objectType: LoadedObjectType,
): Prisma.Sql {
  const branches = objectType.attributes
    .filter((attribute) => attribute.isUnique)
    .map((attribute) => collisionValueBranch(ctx, objectType, attribute))
  if (branches.length === 0) return Prisma.sql`false`
  return Prisma.sql`r.id IN (
    WITH attribute_values AS MATERIALIZED (${Prisma.join(branches, ' UNION ALL ')}),
    hashed_values AS MATERIALIZED (
      SELECT attribute_values.*,
        encode(digest(convert_to(attribute_values.normalized, 'UTF8'), 'sha256'), 'hex') AS "normalizedHash"
      FROM attribute_values WHERE attribute_values.normalized IS NOT NULL
    )
    SELECT values."recordId"::uuid FROM hashed_values values
    WHERE EXISTS (
      SELECT 1 FROM hashed_values other
      WHERE other."attributeId" = values."attributeId"
        AND other."normalizedHash" = values."normalizedHash"
        AND other."recordId" <> values."recordId"
    )
  )`
}

export function qualityFilterPredicate(
  ctx: ActorContext,
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  input: {
    category: 'missing_required' | 'stale' | 'orphans' | 'collisions'
    stale_days?: number
  },
): Prisma.Sql {
  switch (input.category) {
    case 'missing_required': return missingPredicate(ctx, objectType)
    case 'stale': {
      const staleBefore = new Date(ctx.now.getTime() - (input.stale_days ?? 90) * 86_400_000)
      return Prisma.sql`(r.last_activity_at IS NULL OR r.last_activity_at < ${staleBefore})`
    }
    case 'orphans': return orphanPredicate(schema, objectType)
    case 'collisions': return collisionPredicate(ctx, objectType)
  }
}

export async function reportDataQuality(
  db: Db, ctx: ActorContext, schema: LoadedSchema,
  objectTypes: readonly LoadedObjectType[], staleDays: number,
): Promise<DataQualityReport> {
  const staleBefore = new Date(ctx.now.getTime() - staleDays * 86_400_000)
  const missing = missingBranches(ctx, objectTypes)
  const orphans = orphanBranches(ctx, schema, objectTypes)
  const [missingRows, staleRows, orphanRows, collisions] = await Promise.all([
    groupedIssues(db, missing),
    groupedIssues(db, staleBranches(ctx, objectTypes, staleBefore)),
    groupedIssues(db, orphans),
    collisionRows(db, ctx, objectTypes),
  ])
  return {
    missingRequired: bucket(missingRows, { quality: { category: 'missing_required' } }),
    stale: bucket(staleRows, { quality: { category: 'stale', stale_days: staleDays } }),
    orphans: bucket(orphanRows, { quality: { category: 'orphans' } }),
    collisions: bucket(collisions, { quality: { category: 'collisions' } }),
  }
}
