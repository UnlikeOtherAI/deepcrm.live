import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'
import type { AppDeps } from '../deps.js'
import { getSchema, listSchemaTemplates } from '../services/schema.js'
import { presentObjectType, presentSchema } from './schema-presenters.js'

function jsonResource(uri: URL, value: Record<string, unknown>) {
  return {
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value) }],
  }
}

export function registerResources(server: McpServer, ctx: ActorContext, deps: AppDeps): void {
  server.registerResource('schema', 'crm://schema', {
    title: 'Workspace schema',
    description: 'Current object types, relation types, and matching rules for this workspace.',
    mimeType: 'application/json',
  }, async (uri) => jsonResource(uri, presentSchema(await getSchema(deps, ctx))))

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

  server.registerResource('templates', 'crm://templates', {
    title: 'Schema templates',
    description: 'Available schema template slugs and descriptions for crm_template_apply.',
    mimeType: 'application/json',
  }, async (uri) => jsonResource(uri, {
    templates: await listSchemaTemplates(deps, ctx),
  }))
}
