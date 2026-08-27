import { createHash } from 'node:crypto'
import { createDb } from '../packages/db/dist/index.js'

const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(url)
const rows = await db.auditLog.findMany()
const canonical = (value) => {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key.normalize('NFC'))}:${canonical(value[key])}`).join(',')}}`
}

const rowGroups = new Map()
for (const row of rows) {
  const groupKey = row.organizationId ?? 'auth:null'
  const group = rowGroups.get(groupKey) ?? []
  group.push(row)
  rowGroups.set(groupKey, group)

  const entry = { organizationId: row.organizationId, teamId: row.teamId, actorType: row.actorType, actorId: row.actorId, onBehalfOf: row.onBehalfOf, action: row.action, resourceType: row.resourceType, resourceId: row.resourceId, outcome: row.outcome, reason: row.reason, metadata: row.metadata, requestId: row.requestId, ipAddress: row.ipAddress, userAgent: row.userAgent, createdAt: row.createdAt.toISOString() }
  const hash = createHash('sha256').update(`${row.prevHash ?? ''}\n${canonical(entry)}`, 'utf8').digest('hex')
  if (row.entryHash !== hash) throw new Error(`broken audit row ${row.id}`)
}

for (const group of rowGroups.values()) {
  const byHash = new Map()
  const childrenByPrevHash = new Map()
  let root = null

  for (const row of group) {
    if (row.entryHash === null) throw new Error(`missing audit hash ${row.id}`)
    if (byHash.has(row.entryHash)) throw new Error(`duplicate audit hash ${row.id}`)
    byHash.set(row.entryHash, row)
    if (row.prevHash === null) {
      if (root !== null) throw new Error(`multiple audit roots ${row.id}`)
      root = row
    } else {
      if (childrenByPrevHash.has(row.prevHash)) throw new Error(`branched audit chain ${row.id}`)
      childrenByPrevHash.set(row.prevHash, row)
    }
  }

  if (root === null) throw new Error('missing audit root')

  let current = root
  let count = 0
  while (current !== undefined) {
    count += 1
    const next = childrenByPrevHash.get(current.entryHash)
    current = next
  }
  if (count !== group.length) throw new Error(`disconnected audit chain ${root.id}`)
}
await db.$disconnect()
