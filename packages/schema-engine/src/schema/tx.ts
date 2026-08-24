import type { AuditTx, Db } from '@deepcrm/db'

export type SchemaTx = AuditTx & Pick<Db, 'team' | 'objectType' | 'attribute' | 'relationType' | 'matchingRule'>
