import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ErrorCode, ServiceError, Slug, type ActorContext } from '@deepcrm/schemas'
import type { AppDeps } from '../deps.js'
import { getView, listViews } from '../services/lists.js'
import { getSchema, listSchemaTemplates } from '../services/schema.js'
import { presentObjectType, presentSchema } from './schema-presenters.js'

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value) }],
  }
}

const filteringHelp = {
  caps: { max_depth: 8, max_nodes: 100, max_json_bytes: 16_384 },
  grammar: {
    combinators: ['and', 'or', 'not'],
    leaves: ['attribute', 'system', 'linked_to', 'quality', 'text'],
    null_ops: ['is_null', 'is_not_null'],
    value_arity: {
      one: ['eq', 'neq', 'contains', 'starts_with', 'gt', 'gte', 'lt', 'lte'],
      array_1_to_100: ['in', 'not_in'],
      pair: ['between'],
    },
  },
  operators_by_type: [
    { types: ['all'], ops: ['is_null', 'is_not_null'] },
    { types: ['non_json'], ops: ['eq', 'neq', 'in', 'not_in'] },
    { types: ['text', 'email', 'url', 'domain', 'registry_id', 'personal_name', 'select'], ops: ['contains', 'starts_with'] },
    { types: ['rich_text'], ops: ['contains'] },
    { types: ['number', 'percent', 'rating', 'date', 'datetime', 'timestamp_system'], ops: ['gt', 'gte', 'lt', 'lte', 'between'] },
    { types: ['currency'], ops: ['gt', 'gte', 'lt', 'lte', 'between'], note: 'requires fixedCurrency' },
    { types: ['actor_reference (multi)'], ops: ['contains'], note: 'canonical {type,id} element membership' },
    { types: ['record_reference (multi)'], ops: ['contains'], note: 'active backing-link membership' },
    { types: ['system:display_name'], ops: ['eq', 'neq', 'in', 'not_in', 'contains', 'starts_with', 'is_null', 'is_not_null'] },
    { types: ['system:created_at', 'system:updated_at', 'system:last_activity_at'], ops: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'is_not_null'] },
    { types: ['system:owner'], ops: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'], note: 'filter only; not sortable' },
  ],
  examples: [
    {
      name: 'qualified_or_proposal_deals_over_amount',
      filter: { and: [
        { attribute: 'stage', op: 'in', value: ['qualified', 'proposal'] },
        { attribute: 'amount', op: 'gte', value: 10000 },
        { not: { attribute: 'close_date', op: 'is_null' } },
      ] },
    },
    {
      name: 'owned_or_enterprise_tag',
      filter: { or: [
        { system: 'owner', op: 'eq', value: { type: 'human', id: 'usr_1' } },
        { attribute: 'tags', op: 'contains', value: 'enterprise' },
      ] },
    },
    {
      name: 'company_linked_deals_with_recent_activity_filter',
      filter: { and: [
        { linked_to: { relation: 'deal_for_company', record_id: '018f2e65-7a7b-7d2f-8c4d-111111111111', direction: 'from' } },
        { system: 'last_activity_at', op: 'lt', value: '2026-07-01T00:00:00Z' },
        { text: 'packaging' },
      ] },
    },
    {
      name: 'visible_line_items_for_sku',
      filter: { attribute: 'sku', op: 'eq', value: 'SKU-123' },
    },
    {
      name: 'data_quality_orphans',
      filter: { quality: { category: 'orphans' } },
    },
  ],
}

function limitsHelp(deps: AppDeps) {
  return {
    numeric_caps: {
      default_page_limit: 50,
      max_page_limit: 200,
      max_projection_attributes: 50,
      max_filter_depth: 8,
      max_filter_nodes: 100,
      max_filter_json_bytes: 16_384,
      max_bulk_rows: deps.maxBulkRows,
      max_export_rows: deps.maxExportRows,
      search_limit: 50,
    },
    choice_points: [
      {
        topic: 'static_vs_dynamic_lists',
        static: 'Use a static list when a human or integration curates explicit memberships.',
        dynamic: 'Use a dynamic list when membership is the current result of a structured filter.',
      },
      {
        topic: 'product_vs_line_item',
        product: 'Use product for current catalogue state.',
        line_item: 'Use line_item for copied commercial snapshots; later product or parent edits do not rewrite it.',
      },
      {
        topic: 'activity_vs_event',
        activity: 'Use activity/note/task for CRM interactions and timeline work.',
        event: 'Use behavioural events for immutable product/integration facts.',
      },
      {
        topic: 'stored_vs_derived_attributes',
        stored: 'Write ordinary facts to stored attributes.',
        derived: 'Read formula/rollup/relation_sync/score attributes; direct writes fail.',
      },
      {
        topic: 'pipeline_vs_lifecycle',
        pipeline: 'Use pipeline tools for process stage movement and summaries.',
        lifecycle: 'Use lifecycle/status attributes for tenant-customizable labels that are not a process engine.',
      },
    ],
  }
}

export function registerResources(server: McpServer, ctx: ActorContext, deps: AppDeps): void {
  server.registerResource('filtering-help', 'crm://help/filtering', {
    title: 'Filtering grammar',
    description: 'Filter operators, limits, and examples for crm_records_query.',
    mimeType: 'application/json',
  }, async (uri) => jsonResource(uri, filteringHelp))

  server.registerResource('limits-help', 'crm://help/limits', {
    title: 'DeepCRM limits and modelling choices',
    description: 'Numeric MCP caps and guidance for choosing equivalent CRM capability shapes.',
    mimeType: 'application/json',
  }, async (uri) => jsonResource(uri, limitsHelp(deps)))

  server.registerResource('schema', 'crm://schema', {
    title: 'Workspace schema',
    description: 'Current object types, relation types, and matching rules for this workspace.',
    mimeType: 'application/json',
  }, async (uri) => {
    const [schema, views] = await Promise.all([getSchema(deps, ctx), listViews(deps, ctx)])
    return jsonResource(uri, presentSchema(schema, views))
  })

  server.registerResource('schema-object', new ResourceTemplate('crm://schema/{object_type}', {
    list: undefined,
  }), {
    title: 'Object type schema',
    description: 'Full schema detail for one object type addressed by slug.',
    mimeType: 'application/json',
  }, async (uri, variables) => {
    const objectType = variables['object_type']
    if (typeof objectType !== 'string') {
      throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Object type resource is invalid')
    }
    const schema = await getSchema(deps, ctx)
    const selected = schema.objectTypesBySlug.get(objectType)
    if (selected === undefined) throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Unknown object type')
    return jsonResource(uri, presentObjectType(schema, selected))
  })

  server.registerResource('views', 'crm://views', {
    title: 'Saved views',
    description: 'Policy-filtered saved view index with slug, name, and object type.',
    mimeType: 'application/json',
  }, async (uri) => jsonResource(uri, { views: await listViews(deps, ctx) }))

  server.registerResource('view', new ResourceTemplate('crm://views/{slug}', {
    list: undefined,
  }), {
    title: 'Saved view definition',
    description: 'Full policy-filtered saved view definition addressed by slug.',
    mimeType: 'application/json',
  }, async (uri, variables) => {
    const slug = Slug.safeParse(variables['slug'])
    if (!slug.success) {
      throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'View resource is invalid')
    }
    return jsonResource(uri, await getView(deps, ctx, slug.data))
  })

  server.registerResource('templates', 'crm://templates', {
    title: 'Schema templates',
    description: 'Available schema template slugs and descriptions for crm_template_apply.',
    mimeType: 'application/json',
  }, async (uri) => jsonResource(uri, {
    templates: await listSchemaTemplates(deps, ctx),
  }))
}
