import { createDb, seedTenant, writeAudit, type AuditEntryInput } from './index.js'
import { afterAll, expect, it } from 'vitest'

const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(url)

afterAll(async () => { await db.$disconnect() })

it('chains audit hashes', async () => {
  const tenant = await seedTenant(db)
  const entry: AuditEntryInput = { organizationId: tenant.organizationId, teamId: tenant.teamId, actorType: 'system', actorId: 'test', onBehalfOf: null, action: 'test', resourceType: 'test', resourceId: null, outcome: 'success', reason: null, metadata: null, requestId: crypto.randomUUID(), ipAddress: null, userAgent: null }
  const first = await db.$transaction((tx) => writeAudit(tx, entry))
  const second = await db.$transaction((tx) => writeAudit(tx, { ...entry, requestId: crypto.randomUUID() }))
  expect(second.prevHash).toBe(first.entryHash)
  await db.organization.delete({ where: { id: tenant.organizationId } })
})

it('chains auth failure audit hashes without a tenant', async () => {
  const entry: AuditEntryInput = { organizationId: null, teamId: null, actorType: 'system', actorId: 'mcp-auth', onBehalfOf: null, action: 'auth.failed', resourceType: 'mcp', resourceId: null, outcome: 'denied', reason: 'missing_bearer', metadata: { stage: 'mcp_http' }, requestId: crypto.randomUUID(), ipAddress: '127.0.0.1', userAgent: 'audit-test' }
  const first = await db.$transaction((tx) => writeAudit(tx, entry))
  const second = await db.$transaction((tx) => writeAudit(tx, { ...entry, requestId: crypto.randomUUID() }))

  expect(first.organizationId).toBeNull()
  expect(second.prevHash).toBe(first.entryHash)
})
