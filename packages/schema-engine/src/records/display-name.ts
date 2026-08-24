import { getAttributeType } from '../attribute-types/index.js'
import type { LoadedObjectType, LoadedSchema } from '../schema/load.js'

export function computeDisplayName(
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  data: Readonly<Record<string, unknown>>,
): string {
  if (objectType.primaryAttributeId === null) return ''
  const primaryAttribute = schema.attributesById.get(objectType.primaryAttributeId)
  if (primaryAttribute === undefined || primaryAttribute.objectTypeId !== objectType.id) return ''
  const value = data[primaryAttribute.slug]
  if (value === undefined || value === null) return ''
  return getAttributeType(primaryAttribute.type).toSearchText(value, primaryAttribute.config) ?? ''
}
