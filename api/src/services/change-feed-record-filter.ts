/** Link events are written for both endpoints; a watch also accepts older single-ended history. */
export function changeLinkEndpoints(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const edge = value as Record<string, unknown>
  return [edge['from_record_id'], edge['to_record_id']]
    .filter((id): id is string => typeof id === 'string')
}

/** Explicit record filters narrow the feed, never the caller's entitlement. */
export function changeMatchesRecords(
  row: { recordId: string | null; kind: string; oldValue: unknown; newValue: unknown },
  recordIds: ReadonlySet<string> | undefined,
  watchedObjectTypes: ReadonlySet<string>,
): boolean {
  if (recordIds === undefined) return true
  if (row.recordId !== null && recordIds.has(row.recordId)) return true
  if (row.kind === 'link' || row.kind === 'unlink') {
    return changeLinkEndpoints(row.newValue ?? row.oldValue).some((id) => recordIds.has(id))
  }
  if (row.kind !== 'schema_change' || typeof row.newValue !== 'object'
    || row.newValue === null || Array.isArray(row.newValue)) return false
  const objectType = (row.newValue as Record<string, unknown>)['object_type']
  return typeof objectType === 'string' && watchedObjectTypes.has(objectType)
}
