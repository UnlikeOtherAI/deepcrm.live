import type { AuditTx } from '@deepcrm/db'

export type RecordWriteIntegration = {
  tool: string
  /** Runs inside the write's transaction, after the record write. */
  afterWrite: (tx: AuditTx) => Promise<void>
}

export function standardRecordWrite(tool: string): RecordWriteIntegration {
  return { tool, afterWrite: async () => {} }
}
