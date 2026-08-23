function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isJsonObject(value)) {
    const object = value
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key.normalize('NFC'))}:${canonical(object[key])}`).join(',')}}`
  }
  throw new Error('canonicalJson accepts JSON values only')
}

export function canonicalJson(value: unknown): string {
  return canonical(value)
}
