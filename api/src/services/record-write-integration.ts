import type { AuditTx } from '@deepcrm/db'

export type RecordWriteIntegration = {
  tool: string
  afterWrite: (tx: Pick<AuditTx, '$executeRaw'>) => Promise<void>
}

export function standardRecordWrite(tool: string): RecordWriteIntegration {
  return { tool, afterWrite: async () => {} }
}
