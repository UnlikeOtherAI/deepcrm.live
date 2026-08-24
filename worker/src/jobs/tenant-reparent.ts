import { Prisma, type Db } from '@deepcrm/db'
import { z } from 'zod'

import type { JobHandler } from '../index.js'

export const TENANT_REPARENT_JOB = 'tenant.reparent'
const BATCH_SIZE = 1_000

const Payload = z.object({
  teamId: z.string().uuid(),
  sourceOrganizationId: z.string().uuid(),
  targetOrganizationId: z.string().uuid(),
  externalOrgId: z.string().min(1),
  externalTeamId: z.string().min(1),
  requestId: z.string().min(1),
  uoaUserId: z.string().min(1),
}).strict()

const TENANT_TABLES = [
  'object_types',
  'attributes',
  'relation_types',
  'matching_rule_generations',
  'matching_rules',
  'records',
  'record_links',
  'record_unique_keys',
  'record_match_keys',
  'record_match_lookup_keys',
  'suppression_entries',
  'record_changes',
  'record_search',
  'lists',
  'views',
  'policy_rules',
  'approval_requests',
  'audit_logs',
  'queue_jobs',
  'webhooks',
  'idempotency_replays',
] as const

type TenantTable = typeof TENANT_TABLES[number]
type ReparentTx = Pick<Db, '$queryRaw'>

function tableSql(table: TenantTable): Prisma.Sql {
  return Prisma.raw(`"${table}"`)
}

async function rewriteBatch(
  tx: ReparentTx,
  table: TenantTable,
  input: z.infer<typeof Payload>,
): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
    WITH picked AS (
      SELECT ctid FROM ${tableSql(table)}
      WHERE team_id = ${input.teamId}::uuid
        AND organization_id = ${input.sourceOrganizationId}::uuid
      LIMIT ${BATCH_SIZE}
    ),
    updated AS (
      UPDATE ${tableSql(table)} target
      SET organization_id = ${input.targetOrganizationId}::uuid
      FROM picked
      WHERE target.ctid = picked.ctid
      RETURNING 1
    )
    SELECT count(*)::bigint AS count FROM updated
  `
  return Number(rows[0]?.count ?? 0n)
}

async function rewriteTable(
  tx: ReparentTx,
  table: TenantTable,
  input: z.infer<typeof Payload>,
): Promise<number> {
  let changed = 0
  for (;;) {
    const count = await rewriteBatch(tx, table, input)
    changed += count
    if (count < BATCH_SIZE) return changed
  }
}

export const tenantReparentHandler: JobHandler = async (jobInput) => {
  const payload = Payload.parse(jobInput.job.payload)
  await jobInput.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(3, hashtext(${payload.externalTeamId}))`
    const [team, targetOrg] = await Promise.all([
      tx.team.findUnique({
        where: { externalTeamId: payload.externalTeamId },
        select: { id: true, organizationId: true, externalTeamId: true },
      }),
      tx.organization.findUnique({
        where: { externalOrgId: payload.externalOrgId },
        select: { id: true, externalOrgId: true },
      }),
    ])
    if (
      team === null
      || targetOrg === null
      || team.id !== payload.teamId
      || targetOrg.id !== payload.targetOrganizationId
    ) throw new Error('tenant.reparent authoritative pairing changed')
    if (team.organizationId !== payload.targetOrganizationId) {
      for (const table of TENANT_TABLES) await rewriteTable(tx, table, payload)
      await tx.team.update({
        where: { id: payload.teamId },
        data: { organizationId: payload.targetOrganizationId },
      })
    }
    await jobInput.writeAudit(tx, {
      organizationId: payload.targetOrganizationId,
      teamId: payload.teamId,
      actorType: 'system',
      actorId: 'tenant.reparent',
      onBehalfOf: payload.uoaUserId,
      action: 'tenant.reparent.completed',
      resourceType: 'team',
      resourceId: payload.teamId,
      outcome: 'success',
      reason: null,
      metadata: {
        sourceOrganizationId: payload.sourceOrganizationId,
        externalOrgId: payload.externalOrgId,
        externalTeamId: payload.externalTeamId,
      },
      requestId: payload.requestId,
      ipAddress: null,
      userAgent: null,
    })
  })
}
