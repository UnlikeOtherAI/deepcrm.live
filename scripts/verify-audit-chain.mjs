import { createHash } from 'node:crypto'
import { createDb } from '../packages/db/dist/index.js'

const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(url)
const rows = await db.auditLog.findMany({ orderBy: { createdAt: 'asc' } })
const canonical = (value) => {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key.normalize('NFC'))}:${canonical(value[key])}`).join(',')}}`
}
const last = new Map()
for (const row of rows) {
  const previous = last.get(row.organizationId) ?? null
  const entry = { organizationId: row.organizationId, teamId: row.teamId, actorType: row.actorType, actorId: row.actorId, onBehalfOf: row.onBehalfOf, action: row.action, resourceType: row.resourceType, resourceId: row.resourceId, outcome: row.outcome, reason: row.reason, metadata: row.metadata, requestId: row.requestId, ipAddress: row.ipAddress, userAgent: row.userAgent, createdAt: row.createdAt.toISOString() }
  const hash = createHash('sha256').update(`${previous ?? ''}\n${canonical(entry)}`, 'utf8').digest('hex')
  if (row.prevHash !== previous || row.entryHash !== hash) throw new Error(`broken audit row ${row.id}`)
  last.set(row.organizationId, row.entryHash)
}
await db.$disconnect()
