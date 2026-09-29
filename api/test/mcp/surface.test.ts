import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isToolGroupId, TOOL_GROUPS } from '../../src/mcp/tool-groups.js'
import { startTestServer } from './harness.js'

const NOT_YET: string[] = []

// The seed classification (docs/spec/nessie-integration.md §3): destructive and
// structural tools wait for an owner's grant; everything else is on by default.
const EXPLICIT_TOOLS = [
  'crm_object_type_define', 'crm_object_type_update', 'crm_object_type_archive',
  'crm_attribute_define', 'crm_attribute_update', 'crm_attribute_archive',
  'crm_attribute_group_define', 'crm_attribute_group_reorder', 'crm_attribute_group_archive',
  'crm_derived_attribute_define', 'crm_derived_attribute_update',
  'crm_relation_type_define', 'crm_relation_type_update', 'crm_relation_type_archive',
  'crm_matching_rule_set', 'crm_template_apply',
  'crm_record_delete', 'crm_merge_records', 'crm_unmerge',
  'crm_record_erase', 'crm_suppression_remove', 'crm_write_guard_set',
  'crm_export', 'crm_webhook_set', 'crm_webhook_delete',
  'crm_pipeline_define', 'crm_pipeline_update', 'crm_event_type_define',
]

// Every granted mutator ships with the read that resolves its ids.
const RESOLVING_READS = [
  'crm_schema_get', 'crm_record_get', 'crm_records_query', 'crm_links_list', 'crm_list_entries',
  'crm_view_run', 'crm_tasks_list', 'crm_suppression_list', 'crm_webhook_list', 'crm_file_list',
  'crm_pipeline_stages_list', 'crm_derived_refresh_status',
]

const GROUP_COUNTS = {
  schema: 18, records: 12, links: 3, 'lists-views': 9,
  activity: 14, 'search-quality': 5, compliance: 6, io: 8,
}

const ToolClassMeta = z.object({
  'live.deepcrm/group': z.object({ id: z.string(), label: z.string(), order: z.number().int() }).strict(),
  'live.deepcrm/access': z.enum(['standard', 'explicit']),
})

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
    expect(sorted(notYet), 'NOT_YET plus pre-T48 documented tools are exactly the documented tools not registered')
      .toEqual(sorted(documentedNames.filter((name) => !listedSet.has(name))))
    expect(sorted(implemented.filter((name) => !listedSet.has(name))), 'implemented tools are listed').toEqual([])
    expect(sorted(listed), 'NOT_YET tracks the only documented tools not registered').toEqual(sorted(implemented))
  })

  it('classifies every listed tool by group and access class in _meta', async () => {
    const tools = (await client.listTools()).tools.map((tool) => ({
      name: tool.name, ...ToolClassMeta.parse(tool._meta),
    }))
    expect(tools).toHaveLength(75)

    for (const tool of tools) {
      const group = tool['live.deepcrm/group']
      if (!isToolGroupId(group.id)) throw new Error(`${tool.name} names an unknown group '${group.id}'`)
      expect(group, `${tool.name} group`).toEqual({ id: group.id, ...TOOL_GROUPS[group.id] })
    }

    const counts: Record<string, number> = {}
    for (const tool of tools) {
      const id = tool['live.deepcrm/group'].id
      counts[id] = (counts[id] ?? 0) + 1
    }
    expect(counts).toEqual(GROUP_COUNTS)

    const explicit = tools.filter((tool) => tool['live.deepcrm/access'] === 'explicit').map((tool) => tool.name)
    expect(sorted(explicit)).toEqual(sorted(EXPLICIT_TOOLS))
    expect(tools.length - explicit.length).toBe(47)

    const access = new Map(tools.map((tool) => [tool.name, tool['live.deepcrm/access']]))
    for (const read of RESOLVING_READS) expect(access.get(read), `${read} is a resolving read`).toBe('standard')
  })

  it('gives every listed tool a unique, trimmed title of at most 40 characters', async () => {
    const tools = (await client.listTools()).tools
    expect(tools).toHaveLength(75)
    const titles = new Map<string, string>()
    for (const tool of tools) {
      const title = tool.title ?? ''
      expect(title, `${tool.name} title`).toMatch(/^\S(?:.*\S)?$/u)
      expect(title.length, `${tool.name} title length`).toBeLessThanOrEqual(40)
      expect(titles.get(title), `${tool.name} shares its title`).toBeUndefined()
      titles.set(title, tool.name)
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool.title]))
    expect(byName.get('crm_record_create')).toBe('Create record')
    expect(byName.get('crm_records_query')).toBe('Query records')
    expect(byName.get('crm_schema_get')).toBe('Read workspace model')
  })
})
