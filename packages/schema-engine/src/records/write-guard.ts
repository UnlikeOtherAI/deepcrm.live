import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { RecordTx } from '../schema/tx.js'
import { requestedVisibility, type RecordMetadataInput } from './metadata.js'
import { validateWriteGuard } from './validate.js'

type CurrentRecord = {
  origin: string | null
  visibility: 'team' | 'users' | 'private'
}

export async function enforceWriteGuard(
  tx: RecordTx,
  ctx: ActorContext,
  input: RecordMetadataInput,
  current: CurrentRecord | null,
): Promise<void> {
  const guard = await tx.team.findUnique({
    where: { id: ctx.tenant.teamId },
    select: { rejectedOrigins: true, requireOrigin: true, teamVisibilityOnlyApps: true },
  })
  if (guard === null) throw new ServiceError(ErrorCode.TENANT_MISMATCH, 'Tenant does not match actor context')
  validateWriteGuard(guard, {
    app: ctx.app,
    origin: input.origin,
    currentOrigin: current?.origin ?? null,
    visibility: requestedVisibility(input),
    visibleTo: input.visibleTo,
    currentVisibility: current?.visibility ?? 'team',
  })
}
