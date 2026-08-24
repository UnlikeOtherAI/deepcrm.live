import type { ActorContext } from '@deepcrm/schemas'

import type { ChangeIntent } from '../records/changes.js'
import type { JsonValue } from '../records/json.js'
import type { LinkWriter, LinkWriteResult, RecordWriteResult } from '../records/write.js'
import type { LoadedSchema } from '../schema/load.js'
import type { RecordTx } from '../schema/tx.js'

export type LinkInput = {
  relationType: string
  fromRecordId: string
  toRecordId: string
  data?: Record<string, unknown>
  label?: string
}

export type ResolvedLinkOperation = {
  relationTypeId: string
  endpointRecordIds: readonly string[]
  conflictLinkIds: readonly string[]
}

export type ResolvedLinkOperationHandler = (resolved: ResolvedLinkOperation) => Promise<void>

export type LinkOperationResult = {
  link: { id: string; relationTypeId: string; fromRecordId: string; toRecordId: string }
  endedLinks: readonly string[]
  changes: readonly ChangeIntent[]
  touchedRecordIds: readonly string[]
}

export type LinkSnapshot = JsonValue

export type DirectLinkResult = {
  result: LinkOperationResult
  writes: readonly RecordWriteResult[]
}

export type ProjectionLinkWriter = LinkWriter
export type LinkContext = { tx: RecordTx; ctx: ActorContext; schema: LoadedSchema }
export type LinkWrite = LinkWriteResult
