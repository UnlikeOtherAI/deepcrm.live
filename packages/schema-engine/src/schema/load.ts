/* eslint-disable max-len */
import type { Db } from '@deepcrm/db'
import { tenantWhere, type TenantRef } from '@deepcrm/db'

export type LoadedSchema = {
  teamId: string
  schemaVersion: number
  objectTypes: Awaited<ReturnType<Db['objectType']['findMany']>>
  relationTypes: Awaited<ReturnType<Db['relationType']['findMany']>>
  matchingRules: Awaited<ReturnType<Db['matchingRule']['findMany']>>
  objectTypesBySlug: Map<string, Awaited<ReturnType<Db['objectType']['findMany']>>[number]>
  objectTypesById: Map<string, Awaited<ReturnType<Db['objectType']['findMany']>>[number]>
  relationTypesBySlug: Map<string, Awaited<ReturnType<Db['relationType']['findMany']>>[number]>
}

const cache = new Map<string, LoadedSchema>()

function key(teamId: string, schemaVersion: number): string { return `${teamId}:${schemaVersion}` }

export async function loadSchema(db: Db, tenant: TenantRef): Promise<LoadedSchema> {
  const team = await db.team.findFirst({ where: { id: tenant.teamId, organizationId: tenant.organizationId }, select: { id: true, schemaVersion: true } })
  if (team === null) throw new Error('tenant not found')
  const cacheKey = key(team.id, team.schemaVersion)
  const existing = cache.get(cacheKey)
  if (existing !== undefined) return existing
  const where = { ...tenantWhere(tenant), archivedAt: null }
  const [objectTypes, relationTypes, matchingRules] = await Promise.all([
    db.objectType.findMany({ where, include: { attributes: { where: { ...tenantWhere(tenant), archivedAt: null }, orderBy: { position: 'asc' } } } }),
    db.relationType.findMany({ where }),
    db.matchingRule.findMany({ where: tenantWhere(tenant), orderBy: { position: 'asc' } }),
  ])
  const objectTypesBySlug = new Map(objectTypes.map((objectType) => [objectType.slug, objectType]))
  const objectTypesById = new Map(objectTypes.map((objectType) => [objectType.id, objectType]))
  const relationTypesBySlug = new Map(relationTypes.map((relationType) => [relationType.slug, relationType]))
  const loaded = { teamId: team.id, schemaVersion: team.schemaVersion, objectTypes, relationTypes, matchingRules, objectTypesBySlug, objectTypesById, relationTypesBySlug }
  cache.set(cacheKey, loaded)
  return loaded
}
