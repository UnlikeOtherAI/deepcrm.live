/**
 * The eight tool groups and the two access classes every tool carries in its
 * `tools/list` `_meta` (docs/mcp-surface.md §10, docs/spec/nessie-integration.md §3).
 * Group ids are stable; a label may change without moving a tool. Callers such
 * as Nessie store what the wire says and order groups by `order`.
 */
export const TOOL_GROUPS = {
  schema: { label: 'Schema', order: 1 },
  records: { label: 'Records', order: 2 },
  links: { label: 'Links', order: 3 },
  'lists-views': { label: 'Lists and views', order: 4 },
  activity: { label: 'Activities, tasks and pipelines', order: 5 },
  'search-quality': { label: 'Search, quality and merge', order: 6 },
  compliance: { label: 'Compliance', order: 7 },
  io: { label: 'Files, exports, changes and webhooks', order: 8 },
} as const satisfies Record<string, { label: string; order: number }>

export type ToolGroupId = keyof typeof TOOL_GROUPS

/**
 * `standard` tools are on for a caller's agents by default; `explicit` tools
 * (destructive or structural) stay off until an owner grants them per agent.
 */
export const TOOL_ACCESS_CLASSES = ['standard', 'explicit'] as const
export type ToolAccess = typeof TOOL_ACCESS_CLASSES[number]

export const TOOL_GROUP_META_KEY = 'live.deepcrm/group'
export const TOOL_ACCESS_META_KEY = 'live.deepcrm/access'

export function isToolGroupId(value: unknown): value is ToolGroupId {
  return typeof value === 'string' && Object.hasOwn(TOOL_GROUPS, value)
}

export function isToolAccess(value: unknown): value is ToolAccess {
  return TOOL_ACCESS_CLASSES.some((access) => access === value)
}

/** The `Tool._meta` block a tool is registered with. */
export function toolClassMeta(group: ToolGroupId, access: ToolAccess): Record<string, unknown> {
  return {
    [TOOL_GROUP_META_KEY]: { id: group, label: TOOL_GROUPS[group].label, order: TOOL_GROUPS[group].order },
    [TOOL_ACCESS_META_KEY]: access,
  }
}
