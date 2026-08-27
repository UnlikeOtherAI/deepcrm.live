import { createHash } from 'node:crypto'
import { canonicalJson, createDb, seedTenant, writeAudit, type AuditEntryInput } from './index.js'
import { afterAll, expect, it } from 'vitest'

const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(url)

afterAll(async () => { await db.$disconnect() })

function auditEntry(
  organizationId: string | null,
  teamId: string | null,
  input: Partial<AuditEntryInput> = {},
): AuditEntryInput {
  return {
    organizationId,
    teamId,
    actorType: 'system',
    actorId: 'test',
    onBehalfOf: null,
    action: 'test',
    resourceType: 'test',
    resourceId: null,
    outcome: 'success',
    reason: null,
    metadata: null,
    requestId: crypto.randomUUID(),
    ipAddress: null,
    userAgent: null,
    ...input,
  }
}

it('chains audit hashes', async () => {
  const tenant = await seedTenant(db)
  const entry = auditEntry(tenant.organizationId, tenant.teamId)
  const first = await db.$transaction((tx) => writeAudit(tx, entry))
  const second = await db.$transaction((tx) => writeAudit(tx, { ...entry, requestId: crypto.randomUUID() }))
  expect(second.prevHash).toBe(first.entryHash)
  await db.organization.delete({ where: { id: tenant.organizationId } })
})

it('chains auth failure audit hashes without a tenant', async () => {
  const entry = auditEntry(null, null, {
    actorId: 'mcp-auth',
    action: 'auth.failed',
    resourceType: 'mcp',
    outcome: 'denied',
    reason: 'missing_bearer',
    metadata: { stage: 'mcp_http' },
    ipAddress: '127.0.0.1',
    userAgent: 'audit-test',
  })
  const first = await db.$transaction((tx) => writeAudit(tx, entry))
  const second = await db.$transaction((tx) => writeAudit(tx, { ...entry, requestId: crypto.randomUUID() }))

  expect(first.organizationId).toBeNull()
  expect(second.prevHash).toBe(first.entryHash)
})

it('chains concurrent audit writes inside one transaction', async () => {
  const tenant = await seedTenant(db)
  const entry = auditEntry(tenant.organizationId, tenant.teamId)
  const rows = await db.$transaction((tx) => Promise.all([
    writeAudit(tx, { ...entry, requestId: crypto.randomUUID() }),
    writeAudit(tx, { ...entry, requestId: crypto.randomUUID() }),
    writeAudit(tx, { ...entry, requestId: crypto.randomUUID() }),
  ]))
  const roots = rows.filter((row) => row.prevHash === null)
  const linked = rows.filter((row) => row.prevHash !== null)

  expect(roots).toHaveLength(1)
  expect(new Set(linked.map((row) => row.prevHash)).size).toBe(linked.length)
  await db.organization.delete({ where: { id: tenant.organizationId } })
})

it('uses hash links instead of timestamp order when selecting the previous audit row', async () => {
  const tenant = await seedTenant(db)
  const createdAt = new Date('2026-08-27T12:00:00.000Z')
  const firstId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const secondId = '00000000-0000-4000-8000-000000000000'
  const baseEntry = auditEntry(tenant.organizationId, tenant.teamId)
  const firstHashEntry = { ...baseEntry, createdAt: createdAt.toISOString() }
  const firstHash = createHash('sha256').update(`\n${canonicalJson(firstHashEntry)}`, 'utf8').digest('hex')
  await db.auditLog.create({
    data: { ...baseEntry, id: firstId, metadata: undefined, createdAt, prevHash: null, entryHash: firstHash },
  })

  const secondEntry = { ...baseEntry, requestId: crypto.randomUUID() }
  const secondHashEntry = { ...secondEntry, createdAt: createdAt.toISOString() }
  const secondHash = createHash('sha256').update(`${firstHash}\n${canonicalJson(secondHashEntry)}`, 'utf8').digest('hex')
  await db.auditLog.create({
    data: { ...secondEntry, id: secondId, metadata: undefined, createdAt, prevHash: firstHash, entryHash: secondHash },
  })

  const third = await db.$transaction((tx) => writeAudit(tx, { ...baseEntry, requestId: crypto.randomUUID() }))

  expect(third.prevHash).toBe(secondHash)
  await db.organization.delete({ where: { id: tenant.organizationId } })
})
