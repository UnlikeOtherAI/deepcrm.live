import type { AttributeSpec } from '@deepcrm/schemas'

export type AuditActor = {
  type: 'human' | 'agent' | 'system'
  id: string
  onBehalfOf: string | null
  requestId: string
}

export type ObjectInput = {
  slug: string
  singularName: string
  pluralName: string
  description: string
  icon?: string
  kind?: 'system' | 'standard' | 'custom'
  primaryAttribute?: string
}

export type AttributeInput = AttributeSpec & { objectType: string; isSystem?: boolean }

export type RelationInput = {
  slug: string
  fromObjectType: string | null
  toObjectType: string | null
  forwardName: string
  inverseName: string
  description?: string
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many'
  onDelete?: 'unlink' | 'cascade' | 'restrict'
  edgeAttributes?: AttributeSpec[]
  isSystem?: boolean
}
