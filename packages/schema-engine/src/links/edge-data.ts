import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import { attributeExample, attributeTypes, type AttributeTypeDef } from '../attribute-types/index.js'
import { canonicalJsonValue, type JsonValue } from '../records/json.js'
import type { ValidationIssue } from '../records/types.js'
import type { LoadedRelationType } from '../schema/load.js'

type EdgeSpec = { [key: string]: JsonValue }

function schemaConflict(): never {
  throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Relation edge attributes are invalid')
}

function invalidLinkData(issue: ValidationIssue): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Invalid link data', { issues: [issue] })
}

function edgeConfig(spec: EdgeSpec): Record<string, JsonValue> {
  const rawConfig = spec['config']
  if (rawConfig !== undefined && (rawConfig === null || Array.isArray(rawConfig) || typeof rawConfig !== 'object')) {
    throw new Error('invalid edge config')
  }
  return Object.fromEntries(Object.entries(rawConfig ?? {}).filter(([key]) => key !== 'type'))
}

/** Edge values are single values; name the type and one it accepts, never the refused one. */
function refusedEdgeValue(slug: string, definition: AttributeTypeDef | undefined, spec: EdgeSpec): never {
  const issue: ValidationIssue = { path: `/data/${slug}`, message: 'Invalid link data' }
  if (definition === undefined) invalidLinkData(issue)
  let expected: ValidationIssue['expected']
  try {
    expected = attributeExample({ type: definition.type, config: edgeConfig(spec), isMulti: false })
  } catch {
    expected = undefined
  }
  invalidLinkData({ ...issue, type: definition.type, ...(expected === undefined ? {} : { expected }) })
}

/** Validates `crm_link` edge data against the relation's edge attribute specs. */
export function validatedEdgeData(
  value: Record<string, unknown> | undefined,
  relationType: LoadedRelationType,
): { [key: string]: JsonValue } {
  const parsed = canonicalJsonValue(value ?? {})
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    invalidLinkData({ path: '/data', message: 'Invalid link data' })
  }
  const specs = canonicalJsonValue(relationType.edgeAttributes)
  if (!Array.isArray(specs)) schemaConflict()
  const result: Record<string, JsonValue> = {}
  for (const spec of specs) {
    if (spec === null || Array.isArray(spec) || typeof spec !== 'object') schemaConflict()
    const slug = spec['slug']
    const type = spec['type']
    if (typeof slug !== 'string' || typeof type !== 'string') schemaConflict()
    const definition = Object.entries(attributeTypes).find(([name]) => name === type)?.[1]
    const supplied = parsed[slug]
    if (supplied === undefined) {
      if (spec['is_required'] === true) refusedEdgeValue(slug, definition, spec)
      continue
    }
    let valid: JsonValue | undefined
    try {
      if (definition === undefined) throw new Error('unknown edge type')
      const parsedValue = definition.valueSchema(edgeConfig(spec)).safeParse(supplied)
      if (parsedValue.success) valid = canonicalJsonValue(parsedValue.data)
    } catch {
      valid = undefined
    }
    if (valid === undefined) refusedEdgeValue(slug, definition, spec)
    result[slug] = valid
  }
  for (const key of Object.keys(parsed)) {
    const known = specs.some((spec) => (
      spec !== null && !Array.isArray(spec) && typeof spec === 'object' && spec['slug'] === key
    ))
    if (!Object.hasOwn(result, key) && !known) {
      invalidLinkData({ path: `/data/${key}`, message: 'Unknown edge attribute' })
    }
  }
  return result
}
