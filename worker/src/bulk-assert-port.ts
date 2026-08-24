import type { ActorContext } from '@deepcrm/schemas'

export type BulkAssertRecordInput = {
  objectType: string
  matchAttribute: string
  data: Record<string, unknown>
  links?: ReadonlyArray<{
    relationType: string
    toRecordId: string
    data?: Record<string, unknown>
    label?: string
  }>
  reason?: string
  idempotencyKey: string
}

export type BulkAssertRecordPort = (
  ctx: ActorContext,
  input: BulkAssertRecordInput,
) => Promise<{ created: boolean }>
