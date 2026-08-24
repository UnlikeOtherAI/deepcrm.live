import type { ActorContext, Filter, Sort } from '@deepcrm/schemas'

export type ExportPageInput = {
  objectType: string
  filter?: Filter
  sort: Sort
  attributes: readonly string[]
  cursor?: string
  limit: number
  includeTotal: boolean
}

export type ExportPage = {
  records: Array<{ data: Record<string, unknown> }>
  nextCursor: string | null
  total?: number
}

export type ExportPagePort = (
  ctx: ActorContext,
  input: ExportPageInput,
) => Promise<ExportPage>
