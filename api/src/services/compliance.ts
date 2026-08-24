import { Prisma } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'

export type WriteGuardInput = {
  rejected_origins?: readonly string[]
  require_origin?: boolean
  team_visibility_only_apps?: readonly string[]
}

export type WriteGuardOutput = {
  rejected_origins: string[]
  require_origin: boolean
  team_visibility_only_apps: string[]
}

function uniqueSorted(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  return [...new Set(values)].sort()
}

function auditMetadata(ctx: ActorContext, guard: WriteGuardOutput): Prisma.InputJsonObject {
  return {
    app: ctx.app,
    actChain: ctx.actChain,
    provenance: ctx.provenance,
    rejectedOriginsCount: guard.rejected_origins.length,
    requireOrigin: guard.require_origin,
    teamVisibilityOnlyAppsCount: guard.team_visibility_only_apps.length,
  }
}

async function deniedAudit(deps: AppDeps, ctx: ActorContext): Promise<void> {
  await deps.db.$transaction((tx) => deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: 'crm_write_guard_set',
    resourceType: 'team',
    resourceId: ctx.tenant.teamId,
    outcome: 'denied',
    reason: null,
    metadata: { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance },
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  }))
}

function present(row: {
  rejectedOrigins: string[]
  requireOrigin: boolean
  teamVisibilityOnlyApps: string[]
}): WriteGuardOutput {
  return {
    rejected_origins: row.rejectedOrigins,
    require_origin: row.requireOrigin,
    team_visibility_only_apps: row.teamVisibilityOnlyApps,
  }
}

export async function setWriteGuard(
  deps: AppDeps,
  ctx: ActorContext,
  input: WriteGuardInput,
): Promise<WriteGuardOutput> {
  if (ctx.onBehalfOf.role !== 'owner') {
    await deniedAudit(deps, ctx)
    throw new ServiceError(ErrorCode.POLICY_DENIED, 'Write guard requires an owner')
  }
  const rejectedOrigins = uniqueSorted(input.rejected_origins)
  const teamVisibilityOnlyApps = uniqueSorted(input.team_visibility_only_apps)
  const data = {
    ...(rejectedOrigins === undefined ? {} : { rejectedOrigins }),
    ...(input.require_origin === undefined ? {} : { requireOrigin: input.require_origin }),
    ...(teamVisibilityOnlyApps === undefined ? {} : { teamVisibilityOnlyApps }),
  }
  if (Object.keys(data).length === 0) {
    const current = await deps.db.team.findUniqueOrThrow({
      where: { id: ctx.tenant.teamId },
      select: { rejectedOrigins: true, requireOrigin: true, teamVisibilityOnlyApps: true },
    })
    return present(current)
  }
  return deps.db.$transaction(async (tx) => {
    const updated = await tx.team.update({
      where: { id: ctx.tenant.teamId },
      data: { ...data, policyVersion: { increment: 1 } },
      select: { rejectedOrigins: true, requireOrigin: true, teamVisibilityOnlyApps: true },
    })
    const output = present(updated)
    await deps.writeAudit(tx, {
      organizationId: ctx.tenant.organizationId,
      teamId: ctx.tenant.teamId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      onBehalfOf: ctx.onBehalfOf.uoaUserId,
      action: 'crm_write_guard_set',
      resourceType: 'team',
      resourceId: ctx.tenant.teamId,
      outcome: 'success',
      reason: null,
      metadata: auditMetadata(ctx, output),
      requestId: ctx.requestId,
      ipAddress: null,
      userAgent: null,
    })
    return output
  })
}
