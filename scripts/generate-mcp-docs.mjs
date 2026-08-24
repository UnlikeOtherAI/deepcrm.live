import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const surfacePath = fileURLToPath(new URL('../docs/mcp-surface.md', import.meta.url))
const markerSections = ['2', '3', '4', '5', '6', '7', '7a', '8']

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCatalog() {
  execFileSync('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@deepcrm/api^...'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  const output = execFileSync('pnpm', ['exec', 'tsx', 'api/src/mcp/print-catalog.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const parsed = JSON.parse(output)
  if (!Array.isArray(parsed)) throw new Error('MCP catalog must be an array')
  return parsed.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.name !== 'string'
      || typeof entry.description !== 'string'
      || !isRecord(entry.inputSchema)
    ) {
      throw new Error('MCP catalog contains an invalid tool document')
    }
    return {
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
    }
  })
}

function splitTableRow(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    throw new Error(`Invalid MCP tool table row: ${line}`)
  }

  const cells = []
  let cell = ''
  let escaped = false
  for (const character of trimmed.slice(1, -1)) {
    if (character === '|' && !escaped) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += character
    }
    escaped = character === '\\' && !escaped
  }
  cells.push(cell.trim())
  return cells
}

function parseToolRows(block, section) {
  const rows = []
  for (const line of block.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = splitTableRow(line)
    const name = /^`(crm_[a-z0-9_]+)`$/.exec(cells[0] ?? '')?.[1]
    if (name === undefined) continue
    if (cells.length !== 4) {
      throw new Error(`Tool '${name}' in marker ${section} does not have four columns`)
    }
    rows.push({
      name,
      description: cells[1],
      input: cells[2],
      output: cells[3],
    })
  }
  if (rows.length === 0) throw new Error(`Marker ${section} contains no MCP tools`)
  return rows
}

function markerBlocks(markdown) {
  const pattern = /<!-- tools:start:([2-8](?:a)?) -->\n([\s\S]*?)\n<!-- tools:end -->/g
  const blocks = new Map()
  for (const match of markdown.matchAll(pattern)) {
    const section = match[1]
    const block = match[2]
    if (section === undefined || block === undefined) throw new Error('Invalid MCP tool marker')
    if (blocks.has(section)) throw new Error(`Duplicate MCP tool marker ${section}`)
    blocks.set(section, block)
  }
  if (
    blocks.size !== markerSections.length
    || markerSections.some((section) => !blocks.has(section))
  ) {
    throw new Error(`Expected MCP tool markers: ${markerSections.join(', ')}`)
  }
  return blocks
}

function resolveLocalRef(root, reference) {
  if (!reference.startsWith('#/')) throw new Error(`Unsupported JSON schema reference: ${reference}`)
  let value = root
  for (const encodedPart of reference.slice(2).split('/')) {
    const part = encodedPart.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!isRecord(value) && !Array.isArray(value)) {
      throw new Error(`JSON schema reference does not resolve: ${reference}`)
    }
    value = value[part]
    if (value === undefined) throw new Error(`JSON schema reference does not resolve: ${reference}`)
  }
  return value
}

function schemaType(schema, root, followedRefs = new Set()) {
  if (!isRecord(schema)) throw new Error('JSON schema property must be an object')
  if (typeof schema.$ref === 'string') {
    if (followedRefs.has(schema.$ref)) throw new Error(`Circular JSON schema reference: ${schema.$ref}`)
    const nextRefs = new Set(followedRefs)
    nextRefs.add(schema.$ref)
    return schemaType(resolveLocalRef(root, schema.$ref), root, nextRefs)
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ')
  }
  if ('const' in schema) return JSON.stringify(schema.const)
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map((part) => schemaType(part, root, followedRefs)).join(' | ')
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map((part) => schemaType(part, root, followedRefs)).join(' | ')
  }
  if (Array.isArray(schema.type)) return schema.type.join(' | ')
  if (typeof schema.type === 'string') return schema.type
  const annotationKeys = new Set([
    '$comment', 'default', 'deprecated', 'description', 'examples', 'readOnly', 'title', 'writeOnly',
  ])
  if (Object.keys(schema).every((key) => annotationKeys.has(key))) return 'unknown'
  throw new Error(`Unsupported JSON schema property: ${JSON.stringify(schema)}`)
}

function inputPropertyList(inputSchema) {
  const properties = inputSchema.properties
  if (properties === undefined) return '{}'
  if (!isRecord(properties)) throw new Error('Tool input schema properties must be an object')
  const requiredValue = inputSchema.required
  if (requiredValue !== undefined && !Array.isArray(requiredValue)) {
    throw new Error('Tool input schema required must be an array')
  }
  const required = new Set(requiredValue ?? [])
  const fields = Object.entries(properties).map(([name, schema]) => {
    const optional = required.has(name) ? '' : '?'
    return `${name}${optional}: ${schemaType(schema, inputSchema)}`
  })
  return fields.length === 0 ? '{}' : `{ ${fields.join(', ')} }`
}

function escapeTableCell(value) {
  return value.replaceAll('\n', ' ').replaceAll('|', '\\|').trim()
}

function renderTable(rows, catalogByName) {
  const rendered = [
    '| Tool | Description | Input | Output |',
    '|---|---|---|---|',
  ]
  for (const row of rows) {
    const tool = catalogByName.get(row.name)
    const description = tool === undefined
      ? row.description
      : escapeTableCell(tool.description)
    const input = tool === undefined
      ? row.input
      : `\`${escapeTableCell(inputPropertyList(tool.inputSchema))}\``
    rendered.push(`| \`${row.name}\` | ${description} | ${input} | ${row.output} |`)
  }
  return rendered.join('\n')
}

const catalog = readCatalog()
const catalogByName = new Map()
for (const tool of catalog) {
  if (catalogByName.has(tool.name)) throw new Error(`Duplicate catalog tool '${tool.name}'`)
  catalogByName.set(tool.name, tool)
}

const markdown = readFileSync(surfacePath, 'utf8')
const blocks = markerBlocks(markdown)
const documentedNames = new Set()
for (const section of markerSections) {
  const block = blocks.get(section)
  if (block === undefined) throw new Error(`Missing MCP tool marker ${section}`)
  for (const row of parseToolRows(block, section)) {
    if (documentedNames.has(row.name)) throw new Error(`Duplicate documented tool '${row.name}'`)
    documentedNames.add(row.name)
  }
}
for (const name of catalogByName.keys()) {
  if (!documentedNames.has(name)) throw new Error(`Catalog tool '${name}' has no documented table row`)
}

const rewritten = markdown.replace(
  /<!-- tools:start:([2-8](?:a)?) -->\n([\s\S]*?)\n<!-- tools:end -->/g,
  (_match, section, block) => {
    if (typeof section !== 'string' || typeof block !== 'string') throw new Error('Invalid MCP tool marker')
    return `<!-- tools:start:${section} -->\n${renderTable(parseToolRows(block, section), catalogByName)}\n<!-- tools:end -->`
  },
)
writeFileSync(surfacePath, rewritten, 'utf8')
