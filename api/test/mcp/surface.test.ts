import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer } from './harness.js'

const NOT_YET: string[] = [
  'crm_data_quality',
  'crm_record_erase',
  'crm_suppression_add',
  'crm_suppression_check',
  'crm_suppression_list',
  'crm_suppression_remove',
  'crm_write_guard_set',
  'crm_export',
]

function numberedSection(markdown: string, section: number): string {
  const start = new RegExp(`^## ${section}\\.\\s`, 'm').exec(markdown)
  if (start?.index === undefined) throw new Error(`Missing MCP surface section ${section}`)

  const bodyStart = start.index + start[0].length
  const remainder = markdown.slice(bodyStart)
  const end = new RegExp(`^## ${section + 1}\\.\\s`, 'm').exec(remainder)
  if (end?.index === undefined) throw new Error(`Missing boundary after MCP surface section ${section}`)
  return remainder.slice(0, end.index)
}

function tableToolNames(section: string): string[] {
  const names: string[] = []
  for (const match of section.matchAll(/^\|\s*`(crm_[a-z0-9_]+)`\s*\|/gm)) {
    const name = match[1]
    if (name === undefined) throw new Error('MCP surface tool row did not contain a tool name')
    names.push(name)
  }
  return names
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort()
}

let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>

beforeAll(async () => {
  const started = await startTestServer()
  client = started.client
  closeServer = started.close
})

afterAll(async () => {
  await closeServer()
})

describe('documented MCP tool surface', () => {
  it('lists exactly the documented tools implemented so far', async () => {
    const markdown = await readFile(new URL('../../../docs/mcp-surface.md', import.meta.url), 'utf8')
    const toolsBySection = new Map<number, string[]>()

    for (let section = 2; section <= 8; section += 1) {
      const names = tableToolNames(numberedSection(markdown, section))
      expect(names, `section ${section} tool table`).not.toHaveLength(0)
      toolsBySection.set(section, names)
    }

    const documentedNames = Array.from(toolsBySection.values()).flat()
    expect(new Set(documentedNames).size, 'documented tool names are unique').toBe(documentedNames.length)

    expect(new Set(NOT_YET).size, 'NOT_YET entries are unique').toBe(NOT_YET.length)

    const listed = (await client.listTools()).tools.map((tool) => tool.name)
    const documented = new Set(documentedNames)
    const listedSet = new Set(listed)
    const notYet = new Set(NOT_YET)
    const implemented = documentedNames.filter((name) => !notYet.has(name))

    expect(new Set(listed).size, 'listed tool names are unique').toBe(listed.length)
    expect(sorted(listed.filter((name) => !documented.has(name))), 'listed tools are documented').toEqual([])
    expect(sorted(NOT_YET), 'NOT_YET is exactly the documented tools not registered')
      .toEqual(sorted(documentedNames.filter((name) => !listedSet.has(name))))
    expect(sorted(implemented.filter((name) => !listedSet.has(name))), 'implemented tools are listed').toEqual([])
    expect(sorted(listed), 'NOT_YET tracks the only documented tools not registered').toEqual(sorted(implemented))
  })
})
