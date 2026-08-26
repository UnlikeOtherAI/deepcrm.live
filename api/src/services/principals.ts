import { createHash } from 'node:crypto'

import { canonicalJson, tenantWhere, type Db } from '@deepcrm/db'
import { enqueue } from '@deepcrm/queue'
import {
  ErrorCode,
  ServiceError,
  type ActorContext,
  type Principal,
} from '@deepcrm/schemas'
import type { LoadedSchema } from '@deepcrm/schema-engine'

const REQUEST_REPLAY_TTL_MS = 300_000

export class TokenVersionRegressionError extends Error {
  constructor() {
    super('Token version regressed')
  }
}

type ActorRef = { type: 'human' | 'agent'; id: string }
type RecordInput = {
  objectType: string
  data: Record<string, unknown>
  owner?: ActorRef | null
  visibleTo?: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseActor(value: unknown): ActorRef | null {
  if (!isRecord(value)) return null
  const type = value['type']
  const id = value['id']
  if ((type === 'human' || type === 'agent') && typeof id === 'string' && id !== '') {
    return { type, id }
  }
  return null
}

function actorsFromValue(value: unknown, multi: boolean): ActorRef[] {
  if (value === null || value === undefined) return []
  if (multi) return Array.isArray(value) ? value.flatMap((item) => parseActor(item) ?? []) : []
  const actor = parseActor(value)
  return actor === null ? [] : [actor]
}

function stableHash(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export function expectedToolInvocation(
  body: unknown,
): { tool: string; argsSha256: string; destructive: boolean } | undefined {
  if (!isRecord(body) || body['method'] !== 'tools/call') return undefined
  const params = body['params']
  if (!isRecord(params) || typeof params['name'] !== 'string') return undefined
  const rawArgs = params['arguments']
  const args = rawArgs === undefined ? {} : rawArgs
  if (!isRecord(args)) return undefined
  const tool = params['name']
  return {
    tool,
    argsSha256: stableHash(args),
    destructive: isDestructiveTool(tool),
  }
}

function isDestructiveTool(tool: string): boolean {
  return tool === 'crm_merge_records'
    || tool === 'crm_unmerge'
    || tool === 'crm_record_delete'
    || tool === 'crm_record_erase'
    || tool === 'crm_export'
    || tool === 'crm_webhook_set'
    || tool === 'crm_webhook_delete'
}

async function enforceTokenVersion(
  db: Db,
  principal: Principal,
): Promise<void> {
  if (principal.tokenVersion === null) return
  const rows = await db.$queryRaw<Array<{ token_version: bigint }>>`
    INSERT INTO principal_token_versions (uoa_user_id, token_version)
    VALUES (${principal.uoaUserId}, ${principal.tokenVersion})
    ON CONFLICT (uoa_user_id) DO UPDATE
      SET token_version = EXCLUDED.token_version, updated_at = now()
      WHERE principal_token_versions.token_version <= EXCLUDED.token_version
    RETURNING token_version
  `
  if (rows.length !== 1) throw new TokenVersionRegressionError()
}

export async function recordPrincipalSeen(
  db: Db,
  ctx: ActorContext,
  principal: Principal,
): Promise<void> {
  await enforceTokenVersion(db, principal)
  await db.$transaction(async (tx) => {
    await tx.principalLastSeen.upsert({
      where: {
        teamId_uoaUserId: {
          teamId: ctx.tenant.teamId,
          uoaUserId: principal.uoaUserId,
        },
      },
      create: {
        teamId: ctx.tenant.teamId,
        uoaUserId: principal.uoaUserId,
        lastSeenAt: ctx.now,
      },
      update: { lastSeenAt: ctx.now },
    })
    const activeWebhooks = await tx.webhook.count({
      where: {
        ...tenantWhere(ctx.tenant),
        active: true,
        subscribingUoaUserId: principal.uoaUserId,
      },
    })
    if (activeWebhooks === 0) return
    const bucket = Math.floor(ctx.now.getTime() / 30_000)
    await enqueue(tx, {
      ...ctx.tenant,
      type: 'change.deliver',
      payload: ctx.tenant,
      idempotencyKey: `deliver-resume:${ctx.tenant.teamId}:${principal.uoaUserId}:${bucket}`,
      priority: 100,
      maxAttempts: 6,
    })
  })
}

export async function consumeSeenRequestId(
  db: Db,
  ctx: ActorContext,
  tool: string,
  argsSha256: string,
): Promise<boolean> {
  const requestId = ctx.provenance?.requestId ?? ctx.requestId
  const now = ctx.now
  await db.$executeRaw`DELETE FROM seen_request_ids WHERE expires_at <= ${now}`
  const expiresAt = new Date(now.getTime() + REQUEST_REPLAY_TTL_MS)
  const inserted = await db.$queryRaw<Array<{ request_id: string }>>`
    INSERT INTO seen_request_ids (
      organization_id, team_id, app, request_id, tool, args_sha256, seen_at, expires_at
    ) VALUES (
      ${ctx.tenant.organizationId}::uuid, ${ctx.tenant.teamId}::uuid, ${ctx.app},
      ${requestId}, ${tool}, ${argsSha256}, ${now}, ${expiresAt}
    )
    ON CONFLICT (team_id, request_id) DO NOTHING
    RETURNING request_id
  `
  return inserted.length === 1
}

function actorReferenceValues(schema: LoadedSchema, input: RecordInput): ActorRef[] {
  const objectType = schema.objectTypesBySlug.get(input.objectType)
  if (objectType === undefined) return []
  return objectType.attributes.flatMap((attribute) => {
    if (attribute.type !== 'actor_reference') return []
    return actorsFromValue(input.data[attribute.slug], attribute.isMulti)
  })
}

function agentReferenceAllowed(ctx: ActorContext, id: string): boolean {
  return id.startsWith(`agent:${ctx.app}:`) || (ctx.actor.type === 'agent' && id === ctx.actor.id)
}

export async function validateActorReferences(
  db: Db,
  ctx: ActorContext,
  schema: LoadedSchema,
  input: RecordInput,
): Promise<void> {
  const actors = [
    ...(input.owner === undefined || input.owner === null ? [] : [input.owner]),
    ...actorReferenceValues(schema, input),
  ]
  const humanIds = new Set([
    ...(input.visibleTo ?? []),
    ...actors.flatMap((actor) => (actor.type === 'human' ? [actor.id] : [])),
  ])
  const badAgent = actors.find((actor) => actor.type === 'agent' && !agentReferenceAllowed(ctx, actor.id))
  if (badAgent !== undefined) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Actor reference is invalid', {
      issues: [{ path: '', message: 'Agent actor references must use the current app namespace' }],
    })
  }
  humanIds.delete(ctx.onBehalfOf.uoaUserId)
  if (humanIds.size === 0) return
  const seen = await db.principalLastSeen.findMany({
    where: { teamId: ctx.tenant.teamId, uoaUserId: { in: [...humanIds] } },
    select: { uoaUserId: true },
  })
  const seenIds = new Set(seen.map((row) => row.uoaUserId))
  const unseen = [...humanIds].find((id) => !seenIds.has(id))
  if (unseen === undefined) return
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Actor reference is invalid', {
    issues: [{ path: '', message: 'Human actor reference has not been seen in this team' }],
  })
}
