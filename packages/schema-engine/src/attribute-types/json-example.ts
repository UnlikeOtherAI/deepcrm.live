import type { ExampleValue } from './types.js'

const MAX_EXAMPLE_DEPTH = 8

type SchemaObject = { [key: string]: ExampleValue }

function isSchemaObject(value: ExampleValue | undefined): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberAtLeast(schema: SchemaObject, integer: boolean): number {
  const minimum = typeof schema['minimum'] === 'number' ? schema['minimum'] : undefined
  const exclusive = typeof schema['exclusiveMinimum'] === 'number' ? schema['exclusiveMinimum'] : undefined
  const floor = exclusive === undefined ? minimum ?? 0 : Math.max(minimum ?? -Infinity, exclusive + 1)
  return integer ? Math.ceil(floor) : floor
}

function typed(schema: SchemaObject, type: string, depth: number): ExampleValue {
  switch (type) {
    case 'object': {
      const properties = isSchemaObject(schema['properties']) ? schema['properties'] : {}
      const required = Array.isArray(schema['required']) ? schema['required'] : []
      return Object.fromEntries(required.filter((key): key is string => typeof key === 'string')
        .map((key) => [key, instanceOf(properties[key], depth + 1)]))
    }
    case 'array': {
      const minItems = typeof schema['minItems'] === 'number' ? Math.min(schema['minItems'], 3) : 0
      return Array.from({ length: minItems }, () => instanceOf(schema['items'], depth + 1))
    }
    case 'string': {
      const minLength = typeof schema['minLength'] === 'number' ? schema['minLength'] : 0
      return 'example'.padEnd(minLength, 'x')
    }
    case 'integer': return numberAtLeast(schema, true)
    case 'number': return numberAtLeast(schema, false)
    case 'boolean': return true
    default: return null
  }
}

/**
 * A small instance for a Draft 2020-12 schema: its own `examples`/`default`/`const`/`enum`
 * first, else the smallest value its `type` and `required` keys describe. The caller proves
 * the result against the compiled validator; this function only proposes.
 */
export function instanceOf(schema: ExampleValue | undefined, depth = 0): ExampleValue {
  if (!isSchemaObject(schema) || depth > MAX_EXAMPLE_DEPTH) return {}
  const examples = schema['examples']
  if (Array.isArray(examples) && examples[0] !== undefined) return examples[0]
  if (schema['default'] !== undefined) return schema['default']
  if (schema['const'] !== undefined) return schema['const']
  const enumValues = schema['enum']
  if (Array.isArray(enumValues) && enumValues[0] !== undefined) return enumValues[0]
  for (const combinator of ['anyOf', 'oneOf', 'allOf']) {
    const branches = schema[combinator]
    if (Array.isArray(branches) && branches[0] !== undefined) return instanceOf(branches[0], depth + 1)
  }
  const type = Array.isArray(schema['type']) ? schema['type'][0] : schema['type']
  if (typeof type === 'string') return typed(schema, type, depth)
  return isSchemaObject(schema['properties']) ? typed(schema, 'object', depth) : {}
}
