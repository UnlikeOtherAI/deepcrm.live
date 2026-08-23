import { ErrorCode, ServiceError, type Principal } from '@deepcrm/schemas'
import type { AppDeps } from '../deps.js'

const CACHE_TTL_MS = 60_000
const CACHE_LIMIT = 1_000

type CachedTenantIds = {
  organizationId: string
  teamId: string
  expiresAt: number
}

export type TenantResolution = {
  organizationId: string
  teamId: string
  schemaVersion: number
  policyVersion: number
}

const tenantCache = new Map<string, CachedTenantIds>()

function cacheKey(principal: Principal): string {
  return `${principal.uoaOrgId}:${principal.uoaTeamId}`
}

function cacheTenant(key: string, ids: Omit<CachedTenantIds, 'expiresAt'>): void {
  tenantCache.delete(key)
  tenantCache.set(key, { ...ids, expiresAt: Date.now() + CACHE_TTL_MS })
  if (tenantCache.size > CACHE_LIMIT) {
    const oldestKey = tenantCache.keys().next().value
    if (oldestKey !== undefined) tenantCache.delete(oldestKey)
  }
}

async function readCurrentVersions(
  deps: AppDeps,
  cached: CachedTenantIds,
): Promise<TenantResolution | null> {
  const team = await deps.db.team.findFirst({
    where: { id: cached.teamId, organizationId: cached.organizationId },
    select: { id: true, organizationId: true, schemaVersion: true, policyVersion: true },
  })
  if (team === null) return null
  return {
    organizationId: team.organizationId,
    teamId: team.id,
    schemaVersion: team.schemaVersion,
    policyVersion: team.policyVersion,
  }
}

export async function resolveTenant(
  deps: AppDeps,
  principal: Principal,
): Promise<TenantResolution> {
  const key = cacheKey(principal)
  const cached = tenantCache.get(key)
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    tenantCache.delete(key)
    tenantCache.set(key, cached)
    const current = await readCurrentVersions(deps, cached)
    if (current !== null) return current
  }
  tenantCache.delete(key)

  const resolved = await deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(3, hashtext(${principal.uoaTeamId}))`

    const organization = await tx.organization.upsert({
      where: { externalOrgId: principal.uoaOrgId },
      create: {
        externalOrgId: principal.uoaOrgId,
        name: `Organisation ${principal.uoaOrgId.slice(0, 8)}`,
      },
      update: {},
      select: { id: true },
    })
    const existingTeam = await tx.team.findUnique({
      where: { externalTeamId: principal.uoaTeamId },
      select: { id: true, organizationId: true, schemaVersion: true, policyVersion: true },
    })
    if (existingTeam !== null) {
      if (existingTeam.organizationId !== organization.id) {
        throw new ServiceError(
          ErrorCode.TENANT_MISMATCH,
          'The UOA team is paired with a different organisation',
        )
      }
      return existingTeam
    }
    return tx.team.create({
      data: {
        organizationId: organization.id,
        externalTeamId: principal.uoaTeamId,
        name: `Team ${principal.uoaTeamId.slice(0, 8)}`,
      },
      select: { id: true, organizationId: true, schemaVersion: true, policyVersion: true },
    })
  })

  cacheTenant(key, { organizationId: resolved.organizationId, teamId: resolved.id })
  return {
    organizationId: resolved.organizationId,
    teamId: resolved.id,
    schemaVersion: resolved.schemaVersion,
    policyVersion: resolved.policyVersion,
  }
}
