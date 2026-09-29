import type { AttributeType } from '@deepcrm/db'

import type { ExampleValue } from '../attribute-types/index.js'

export type LinkIntent = {
  kind: 'record_reference'
  attributeSlug: string
  relationTypeId: string
  cardinality: 'many_to_one' | 'many_to_many'
  targetIds: string[]
}

/**
 * `type` and `expected` ride on an issue that refuses a value for its attribute type: the
 * attribute's type and one value it accepts (an array for a multi attribute). They never echo
 * the refused value.
 */
export type ValidationIssue = { path: string; message: string; type?: AttributeType; expected?: ExampleValue }
export type ValidatedRecordData = {
  data: Record<string, unknown>
  linkOps: LinkIntent[]
  issues: ValidationIssue[]
}
