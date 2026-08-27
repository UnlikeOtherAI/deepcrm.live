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

const auditQueues = new WeakMap<AuditTx, Promise<void>>()

async function queueAuditWrite<T>(tx: AuditTx, operation: () => Promise<T>): Promise<T> {
  const previous = auditQueues.get(tx) ?? Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => current)
  auditQueues.set(tx, queued)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (auditQueues.get(tx) === queued) auditQueues.delete(tx)
  }
}

export async function writeAudit(tx: AuditTx, entry: AuditEntryInput): Promise<AuditLog> {
  return queueAuditWrite(tx, async () => writeAuditQueued(tx, entry))
}

async function writeAuditQueued(tx: AuditTx, entry: AuditEntryInput): Promise<AuditLog> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(5, hashtext(${entry.organizationId ?? 'auth:null'}))`
  const previous = entry.organizationId === null
    ? await tx.$queryRaw<Array<{ entry_hash: string }>>`
        SELECT current.entry_hash
        FROM audit_logs current
        WHERE current.organization_id IS NULL
          AND current.entry_hash IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM audit_logs child
            WHERE child.organization_id IS NULL
              AND child.prev_hash = current.entry_hash
          )
      `
    : await tx.$queryRaw<Array<{ entry_hash: string }>>`
        SELECT current.entry_hash
        FROM audit_logs current
        WHERE current.organization_id = ${entry.organizationId}::uuid
          AND current.entry_hash IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM audit_logs child
            WHERE child.organization_id = ${entry.organizationId}::uuid
              AND child.prev_hash = current.entry_hash
          )
      `
  if (previous.length > 1) throw new Error('audit chain has multiple heads')
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
