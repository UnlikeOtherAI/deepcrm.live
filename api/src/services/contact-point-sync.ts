import { tenantWhere } from '@deepcrm/db'
import {
  contactAttributes,
  FIRST_SOURCE_ATTRIBUTE_SLUGS,
  syncContactPoints,
  type ContactPointTx,
  type JsonValue,
  type LoadedSchema,
  type RecordWriteResult,
} from '@deepcrm/schema-engine'
import { SourceRef, type ActorContext } from '@deepcrm/schemas'

function contactSlugs(schema: LoadedSchema): ReadonlySet<string> {
  return new Set(schema.objectTypes.flatMap((objectType) => contactAttributes(objectType).map((item) => item.slug)))
}

/**
 * Keeps contact points in step with a person's own record write
 * (schema-engine §4d‴): every email or phone the write added gets a row
 * naming the person and, for a create with a named source, that source —
 * confirmed, since a person entered it; a value the write removed loses its
 * row unless archived.
 */
export async function recordContactPointWrite(
  tx: ContactPointTx, ctx: ActorContext, schema: LoadedSchema, result: RecordWriteResult,
): Promise<void> {
  const recordId = result.record.id
  const slugs = contactSlugs(schema)
  const changes = result.changes.filter((change) => (
    change.recordId === recordId && change.attributeSlug !== null && slugs.has(change.attributeSlug)
    && (change.kind === 'set' || change.kind === 'unset')
  ))
  if (changes.length === 0) return
  const row = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: recordId }, select: { objectTypeId: true },
  })
  const objectType = row === null ? undefined : schema.objectTypesById.get(row.objectTypeId)
  if (objectType === undefined) return
  const before: Record<string, JsonValue> = {}
  const after: Record<string, JsonValue> = {}
  for (const change of changes) {
    if (change.attributeSlug === null) continue
    if (change.oldValue !== null) before[change.attributeSlug] = change.oldValue
    if (change.kind === 'set' && change.newValue !== null) after[change.attributeSlug] = change.newValue
  }
  const data = result.record.data
  const source = result.created ? SourceRef.safeParse({
    kind: data[FIRST_SOURCE_ATTRIBUTE_SLUGS.kind], id: data[FIRST_SOURCE_ATTRIBUTE_SLUGS.id],
    name: data[FIRST_SOURCE_ATTRIBUTE_SLUGS.name],
  }) : null
  await syncContactPoints(tx, ctx, objectType, recordId, { before, after }, {
    source: source?.success === true ? source.data : null, confirmed: true,
  })
}
