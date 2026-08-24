export type LinkIntent = {
  kind: 'record_reference'
  attributeSlug: string
  relationTypeId: string
  cardinality: 'many_to_one' | 'many_to_many'
  targetIds: string[]
}

export type ValidationIssue = { path: string; message: string }
export type ValidatedRecordData = {
  data: Record<string, unknown>
  linkOps: LinkIntent[]
  issues: ValidationIssue[]
}
