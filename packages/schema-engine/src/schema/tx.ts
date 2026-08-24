import type { AuditTx, Db } from '@deepcrm/db'

export type SchemaTx = AuditTx & Pick<Db,
  'team' | 'objectType' | 'attribute' | 'relationType' | 'matchingRule' | 'matchingRuleGeneration'
  | 'queueJob' | 'record' | 'recordMatchKey' | 'recordMatchLookupKey'
>

export type RecordTx = AuditTx & Pick<Db,
  'team' | 'record' | 'recordLink' | 'recordUniqueKey' | 'recordMatchKey' | 'recordMatchLookupKey'
  | 'recordChange' | 'queueJob' | 'idempotencyReplay'
>
