import type { AuditTx, Db } from '@deepcrm/db'
import { suppressionHash } from '@deepcrm/schema-engine'
import { onBehalfOfUserId, type ActorContext, type ConsentState } from '@deepcrm/schemas'

type SuppressionTx = AuditTx & Pick<Db, 'suppressionEntry'>
type SuppressionRead = Pick<Db, 'suppressionEntry'>

/** What a consent write did to the email's opt-out suppression. */
export type ConsentSuppressionChange = 'added' | 'lifted' | 'none'

// `declined` is an objection to direct marketing on the email channel.
const OPT_OUT = { kind: 'email', channel: 'email', reason: 'objection', subReason: 'opt_out' } as const

/**
 * Keeps the suppression store in step with a consent write (schema-engine
 * §4d′). `declined` upserts the `email`/`email`/`objection`/`opt_out` entry,
 * replacing only an earlier opt-out or a time-boxed hold, never a permanent
 * entry of another reason. Any other state removes that email's
 * `objection`/`opt_out` entries only — never erasure, complaint or bounce.
 */
export async function applyConsentSuppression(
  tx: SuppressionTx,
  ctx: ActorContext,
  email: string,
  state: ConsentState,
  recordId: string | null,
): Promise<ConsentSuppressionChange> {
  const keyHash = suppressionHash('email', email)
  const tenant = { organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId }
  if (state !== 'declined') {
    const lifted = await tx.suppressionEntry.deleteMany({
      where: { ...tenant, kind: OPT_OUT.kind, keyHash, reason: OPT_OUT.reason, subReason: OPT_OUT.subReason },
    })
    return lifted.count > 0 ? 'lifted' : 'none'
  }
  const existing = await tx.suppressionEntry.findFirst({
    where: { ...tenant, kind: OPT_OUT.kind, keyHash, channel: OPT_OUT.channel },
    select: { id: true, reason: true, subReason: true, expiresAt: true },
  })
  const written = {
    reason: OPT_OUT.reason,
    subReason: OPT_OUT.subReason,
    expiresAt: null,
    sourceRecordId: recordId,
    createdByType: ctx.actor.type,
    createdById: ctx.actor.id,
    onBehalfOf: onBehalfOfUserId(ctx),
  }
  if (existing === null) {
    await tx.suppressionEntry.create({
      data: { ...tenant, kind: OPT_OUT.kind, channel: OPT_OUT.channel, keyHash, note: null, ...written },
    })
    return 'added'
  }
  const replaceable = existing.expiresAt !== null
    || (existing.reason === OPT_OUT.reason && existing.subReason === OPT_OUT.subReason)
  if (!replaceable) return 'none'
  await tx.suppressionEntry.updateMany({ where: { ...tenant, id: existing.id }, data: written })
  return existing.expiresAt === null ? 'none' : 'added'
}

/** Whether marketing email to this address is suppressed now (an `all` or `email` entry, unexpired). */
export async function emailSuppressed(db: SuppressionRead, ctx: ActorContext, email: string): Promise<boolean> {
  const entry = await db.suppressionEntry.findFirst({
    where: {
      organizationId: ctx.tenant.organizationId,
      teamId: ctx.tenant.teamId,
      kind: 'email',
      keyHash: suppressionHash('email', email),
      channel: { in: ['all', 'email'] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: ctx.now } }],
    },
    select: { id: true },
  })
  return entry !== null
}
