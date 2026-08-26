import { createHash } from 'node:crypto'
import { Prisma, type AuditLog } from '@prisma/client'
import { canonicalJson } from './canonical-json.js'

export type AuditEntryInput = {
  organizationId: string | null; teamId: string | null; actorType: 'human' | 'agent' | 'system'; actorId: string
  onBehalfOf: string | null; action: string; resourceType: string; resourceId: string | null
  outcome: 'success' | 'denied' | 'failure'; reason: string | null; metadata: Prisma.InputJsonValue | null
  requestId: string; ipAddress: string | null; userAgent: string | null
}

export type AuditTx = {
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
  auditLog: { create(args: Prisma.AuditLogCreateArgs): Promise<AuditLog> }
}

export async function writeAudit(tx: AuditTx, entry: AuditEntryInput): Promise<AuditLog> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(5, hashtext(${entry.organizationId ?? 'auth:null'}))`
  const previous = entry.organizationId === null
    ? await tx.$queryRaw<Array<{ entry_hash: string | null }>>`
        SELECT entry_hash FROM audit_logs WHERE organization_id IS NULL
        ORDER BY created_at DESC, id DESC LIMIT 1
      `
    : await tx.$queryRaw<Array<{ entry_hash: string | null }>>`
        SELECT entry_hash FROM audit_logs WHERE organization_id = ${entry.organizationId}::uuid
        ORDER BY created_at DESC, id DESC LIMIT 1
      `
  const prevHash = previous[0]?.entry_hash ?? null
  const createdAt = new Date().toISOString()
  const hashEntry = { ...entry, createdAt }
  const entryHash = createHash('sha256').update(`${prevHash ?? ''}\n${canonicalJson(hashEntry)}`, 'utf8').digest('hex')
  return tx.auditLog.create({
    data: {
      ...entry,
      metadata: entry.metadata === null ? Prisma.JsonNull : entry.metadata,
      createdAt: new Date(createdAt),
      prevHash,
      entryHash,
    },
  })
}
