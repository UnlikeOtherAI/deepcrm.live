import type { AuditTx, Db } from '@deepcrm/db'

export type SchemaTx = AuditTx & Pick<Db, 'team' | 'objectType' | 'attribute' | 'relationType' | 'matchingRule'>

export type RecordTx = AuditTx & Pick<Db,
  'team' | 'record' | 'recordLink' | 'recordUniqueKey' | 'recordMatchKey' | 'recordChange' | 'queueJob' | 'idempotencyReplay'
>
