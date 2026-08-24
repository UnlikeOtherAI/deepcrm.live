import type { TenantRef } from '@deepcrm/db'
import type { ActorContext, Filter, Sort } from '@deepcrm/schemas'

import type { JsonValue } from '../records/json.js'
import type { LoadedObjectType, LoadedSchema } from '../schema/load.js'

export type QueryFilter = Filter

export type QueryOperator =
  | 'eq' | 'neq' | 'in' | 'not_in' | 'is_null' | 'is_not_null'
  | 'contains' | 'starts_with' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'

export type QuerySystemField = 'created_at' | 'updated_at' | 'last_activity_at' | 'display_name' | 'owner'

export type QuerySort = Sort

export type QueryCursorState = {
  values: readonly { isNull: boolean; value: JsonValue }[]
  id: string
}

export type QueryInput = {
  filter?: QueryFilter
  sort?: QuerySort
  after?: QueryCursorState
  limit?: number
  includeTotal?: boolean
}

export type QueryRequest = {
  tenant: TenantRef
  ctx: ActorContext
  schema: LoadedSchema
  objectType: LoadedObjectType
  input: QueryInput
}
