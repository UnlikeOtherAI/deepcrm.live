import { getAttributeType } from '../attribute-types/index.js'
import type { LoadedAttribute, LoadedSchema } from '../schema/load.js'

const MAX_CONTENT_BYTES = 8 * 1024
const MAX_RICH_TEXT_BYTES = 2 * 1024
const SEPARATOR = ' · '

export type SearchContentRecord = Readonly<{
  objectTypeId: string
  displayName: string
  data: Readonly<Record<string, unknown>>
}>

export type SearchContentLink = Readonly<{
  relationTypeId: string
  direction: 'forward' | 'inverse'
  relatedDisplayName: string
}>

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value
  let bytes = 0
  let result = ''
  for (const character of value) {
    const width = Buffer.byteLength(character, 'utf8')
    if (bytes + width > maximumBytes) break
    result += character
    bytes += width
  }
  return result
}

function attributeSearchText(attribute: LoadedAttribute, raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  let values: readonly unknown[]
  if (attribute.isMulti) {
    if (!Array.isArray(raw)) throw new Error('Stored multi-value attribute is invalid')
    values = raw
  } else {
    values = [raw]
  }
  const definition = getAttributeType(attribute.type)
  return values.flatMap((value) => {
    const text = definition.toSearchText(value, attribute.config)
    if (text === null || text === '') return []
    return [attribute.type === 'rich_text' ? truncateUtf8(text, MAX_RICH_TEXT_BYTES) : text]
  })
}

function joinWithinBudget(segments: readonly string[]): string {
  let result = ''
  for (const segment of segments) {
    if (segment === '') continue
    const prefix = result === '' ? '' : SEPARATOR
    const remaining = MAX_CONTENT_BYTES - Buffer.byteLength(result + prefix, 'utf8')
    if (remaining <= 0) break
    const fitted = truncateUtf8(segment, remaining)
    if (fitted === '') break
    result += prefix + fitted
    if (fitted !== segment) break
  }
  return result
}

/** Builds the deterministic, non-sensitive one-hop search document for a record. */
export function buildSearchContent(
  schema: LoadedSchema,
  record: SearchContentRecord,
  links: readonly SearchContentLink[],
): string {
  const objectType = schema.objectTypesById.get(record.objectTypeId)
  if (objectType === undefined) throw new Error('Record object type is not active')
  const attributes = [...objectType.attributes]
    .filter((attribute) => attribute.sensitivity === 'public' || attribute.sensitivity === 'internal')
    .sort((left, right) => left.position - right.position || left.slug.localeCompare(right.slug))
  const attributeText = attributes.flatMap((attribute) => (
    attributeSearchText(attribute, record.data[attribute.slug])
  ))
  const linkText = links.flatMap((link) => {
    const relation = schema.relationTypesById.get(link.relationTypeId)
    if (relation === undefined || relation.archivedAt !== null || link.relatedDisplayName === '') return []
    const name = link.direction === 'forward' ? relation.forwardName : relation.inverseName
    return [`${name} ${link.relatedDisplayName}`]
  })
  return joinWithinBudget([record.displayName, ...attributeText, ...linkText])
}
