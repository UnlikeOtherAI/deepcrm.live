import type { RecordTx } from '../schema/tx.js'

const RECORD_LOCK_NAMESPACE = 1
const KEY_LOCK_NAMESPACE = 2
const LINK_TOPOLOGY_LOCK_NAMESPACE = 7

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

async function lock(tx: RecordTx, namespace: number, teamId: string, keys: readonly string[]): Promise<void> {
  for (const key of sorted(keys)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${namespace}::integer, hashtext(${`${teamId}:${key}`}))`
  }
}

export function lockRecords(tx: RecordTx, teamId: string, recordIds: readonly string[]): Promise<void> {
  return lock(tx, RECORD_LOCK_NAMESPACE, teamId, recordIds)
}

export function lockKeys(tx: RecordTx, teamId: string, keys: readonly string[]): Promise<void> {
  return lock(tx, KEY_LOCK_NAMESPACE, teamId, keys)
}

/**
 * Serializes one team's link topology before a caller obtains record or key
 * locks. Link projection, direct cardinality replacement, and lifecycle
 * cascade discovery all may expand their affected-record set dynamically.
 */
export function lockLinkTopology(tx: RecordTx, teamId: string): Promise<void> {
  return lock(tx, LINK_TOPOLOGY_LOCK_NAMESPACE, teamId, ['topology'])
}
