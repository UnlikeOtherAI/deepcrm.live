import { createHash } from 'node:crypto'
import { canonicalJson } from '@deepcrm/db'
import {
  ConfirmContent,
  CrmAttributeArchive,
  CrmAttributeDefine,
  CrmAttributeUpdate,
  CrmMatchingRuleSet,
  CrmObjectTypeArchive,
  CrmObjectTypeDefine,
  CrmObjectTypeUpdate,
  CrmRelationTypeArchive,
  CrmRelationTypeDefine,
  CrmSchemaGet,
  CrmTemplateApply,
  ErrorCode,
  ServiceError,
  type ActorContext,
} from '@deepcrm/schemas'
import type { AppDeps } from '../../deps.js'
import {
  applySchemaTemplate,
  archiveSchemaAttribute,
  archiveSchemaObject,
  archiveSchemaRelation,
  defineSchemaAttribute,
  defineSchemaObjectWithAttributes,
  defineSchemaRelation,
  getSchema,
  previewSchemaAttributeArchive,
  previewSchemaObjectArchive,
  previewSchemaRelationArchive,
  replaceSchemaMatchingRules,
  updateSchemaAttribute,
  updateSchemaObject,
} from '../../services/schema.js'
import { presentAttribute, presentObjectType, presentRelation, presentSchema } from '../schema-presenters.js'
import { inputRequired, verifyRequestState, type MrtrInput } from './input-required.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

function jsonResult<T extends Record<string, unknown>>(value: T) {
  return ok(value, JSON.stringify(value))
}

function argumentsHash(args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex')
}

function confirmationMessage(impact: string): string {
  return `${impact} Proceed?`
}

function freshConfirmation(
  deps: AppDeps,
  ctx: ActorContext,
  tool: string,
  args: Record<string, unknown>,
  impact: string,
) {
  return inputRequired({
    confirm: {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: confirmationMessage(impact),
        requestedSchema: {
          type: 'object',
          properties: { confirmed: { type: 'boolean' } },
          required: ['confirmed'],
        },
      },
    },
  }, {
    app: ctx.app,
    uoaUserId: ctx.onBehalfOf.uoaUserId,
    tool,
    argumentsHash: argumentsHash(args),
    impact,
    exp: Math.floor(ctx.now.getTime() / 1_000) + 900,
  }, deps.secretBox)
}

function invalidState(error: unknown): boolean {
  return error instanceof ServiceError
    && error.code === ErrorCode.VALIDATION_FAILED
    && error.details['detail'] === 'request_state_invalid'
}

function confirmedOrChallenge(
  deps: AppDeps,
  ctx: ActorContext,
  tool: string,
  args: Record<string, unknown>,
  impact: string,
  mrtr: MrtrInput,
) {
  if (mrtr.requestState === undefined || mrtr.inputResponses === undefined) {
    return freshConfirmation(deps, ctx, tool, args, impact)
  }
  try {
    verifyRequestState(mrtr.requestState, ctx, tool, argumentsHash(args), deps.secretBox)
  } catch (error) {
    if (invalidState(error)) return freshConfirmation(deps, ctx, tool, args, impact)
    throw error
  }
  const response = mrtr.inputResponses['confirm']
  const content = response?.action === 'accept' ? ConfirmContent.safeParse(response.content) : undefined
  if (content === undefined || !content.success || !content.data.confirmed) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Confirmation is required', {
      detail: 'confirmation_required',
    })
  }
  return undefined
}

async function latestSchema(deps: AppDeps, ctx: ActorContext) {
  return getSchema(deps, ctx)
}

export function registerSchemaTools(server: Parameters<typeof defineTool>[0], ctx: ActorContext, deps: AppDeps): void {
  defineTool(server, {
    name: 'crm_schema_get',
    description: 'Get the workspace data model: object types, their attributes, relation types and matching rules. Call this first in a session; cache by schema_version.',
    input: CrmSchemaGet.in.shape,
    handler: async (args) => {
      const schema = await latestSchema(deps, ctx)
      if (args.object_type === undefined) return jsonResult(presentSchema(schema))
      const objectType = schema.objectTypesBySlug.get(args.object_type)
      if (objectType === undefined) throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Unknown object type')
      return jsonResult(presentObjectType(schema, objectType))
    },
  })

  defineTool(server, {
    name: 'crm_object_type_define',
    description: 'Create a custom object type (a new kind of record, e.g. "subscription"). Attributes can be added now or later with crm_attribute_define.',
    input: CrmObjectTypeDefine.in.shape,
    handler: async (args) => {
      await defineSchemaObjectWithAttributes(deps, ctx, {
        slug: args.slug,
        singularName: args.singular_name,
        pluralName: args.plural_name,
        description: args.description,
        icon: args.icon,
        attributes: args.attributes,
        primaryAttribute: args.primary_attribute,
      })
      const schema = await latestSchema(deps, ctx)
      const objectType = schema.objectTypesBySlug.get(args.slug)
      if (objectType === undefined) throw new Error('Object type was not found after creation')
      return jsonResult(presentObjectType(schema, objectType))
    },
  })

  defineTool(server, {
    name: 'crm_object_type_update',
    description: 'Rename or re-describe an object type, or change its primary attribute.',
    input: CrmObjectTypeUpdate.in.shape,
    handler: async (args) => {
      await updateSchemaObject(deps, ctx, args.object_type, {
        singularName: args.singular_name,
        pluralName: args.plural_name,
        description: args.description,
        icon: args.icon,
        primaryAttribute: args.primary_attribute,
      })
      const schema = await latestSchema(deps, ctx)
      const objectType = schema.objectTypesBySlug.get(args.object_type)
      if (objectType === undefined) throw new Error('Object type was not found after update')
      return jsonResult(presentObjectType(schema, objectType))
    },
  })

  defineTool(server, {
    name: 'crm_object_type_archive',
    description: 'Archive a custom object type. Records are kept but hidden; MRTR confirmation states the record count.',
    input: CrmObjectTypeArchive.in.shape,
    handler: async (args, mrtr) => {
      const impact = await previewSchemaObjectArchive(deps, ctx, args.object_type)
      if (impact.records > 0) {
        const pending = confirmedOrChallenge(deps, ctx, 'crm_object_type_archive', args, (
          `Archiving object type '${args.object_type}' will hide ${impact.records} records.`
        ), mrtr)
        if (pending !== undefined) return pending
      }
      await archiveSchemaObject(deps, ctx, args.object_type, args.reason)
      return jsonResult({ archived: true, records: impact.records })
    },
  })

  defineTool(server, {
    name: 'crm_attribute_define',
    description: 'Add an attribute (field) to an object type. Use record_reference to relate to other object types. Unique attributes enable crm_record_assert.',
    input: CrmAttributeDefine.in.shape,
    handler: async (args) => {
      await defineSchemaAttribute(deps, ctx, {
        objectType: args.object_type,
        slug: args.slug,
        name: args.name,
        description: args.description,
        type: args.type,
        config: args.config,
        is_multi: args.is_multi,
        is_required: args.is_required,
        is_unique: args.is_unique,
        is_indexed: args.is_indexed,
        sensitivity: args.sensitivity,
        default_value: args.default_value,
      })
      return jsonResult(presentAttribute(await latestSchema(deps, ctx), args.object_type, args.slug))
    },
  })

  defineTool(server, {
    name: 'crm_attribute_update',
    description: 'Change an attribute name, description, options, required/indexed/sensitivity flags. Type, slug and is_multi are immutable. Tightening may require MRTR; normalize-affecting config changes require a key-recompute backfill; sensitivity raises trigger a reindex Task.',
    input: CrmAttributeUpdate.in.shape,
    handler: async (args) => {
      await updateSchemaAttribute(deps, ctx, args.object_type, args.attribute, {
        name: args.name,
        description: args.description,
        config: args.config,
        is_required: args.is_required,
        is_unique: args.is_unique,
        is_indexed: args.is_indexed,
        sensitivity: args.sensitivity,
        default_value: args.default_value,
      })
      return jsonResult(presentAttribute(await latestSchema(deps, ctx), args.object_type, args.attribute))
    },
  })

  defineTool(server, {
    name: 'crm_attribute_archive',
    description: 'Archive an attribute; values are retained in history. MRTR confirmation states how many records carry a value.',
    input: CrmAttributeArchive.in.shape,
    handler: async (args, mrtr) => {
      const impact = await previewSchemaAttributeArchive(deps, ctx, args.object_type, args.attribute)
      if (impact.recordsWithValues > 0) {
        const pending = confirmedOrChallenge(deps, ctx, 'crm_attribute_archive', args, (
          `Archiving attribute '${args.attribute}' will hide ${impact.recordsWithValues} existing values.`
        ), mrtr)
        if (pending !== undefined) return pending
      }
      await archiveSchemaAttribute(deps, ctx, args.object_type, args.attribute, args.reason)
      return jsonResult({ archived: true, records_with_values: impact.recordsWithValues })
    },
  })

  defineTool(server, {
    name: 'crm_relation_type_define',
    description: 'Define a named, typed relationship between object types (e.g. person —works_at→ company) with cardinality and optional attributes on the link itself. All four cardinalities are supported; a record_reference attribute owns exactly one backing relation, never shared.',
    input: CrmRelationTypeDefine.in.shape,
    handler: async (args) => {
      await defineSchemaRelation(deps, ctx, {
        slug: args.slug,
        fromObjectType: args.from_object_type,
        toObjectType: args.to_object_type,
        forwardName: args.forward_name,
        inverseName: args.inverse_name,
        description: args.description,
        cardinality: args.cardinality,
        onDelete: args.on_delete,
        edgeAttributes: args.edge_attributes,
      })
      return jsonResult(presentRelation(await latestSchema(deps, ctx), args.slug))
    },
  })

  defineTool(server, {
    name: 'crm_relation_type_archive',
    description: 'Archive a relation type; links are kept but inactive.',
    input: CrmRelationTypeArchive.in.shape,
    handler: async (args, mrtr) => {
      const impact = await previewSchemaRelationArchive(deps, ctx, args.relation_type)
      if (impact.links > 0) {
        const pending = confirmedOrChallenge(deps, ctx, 'crm_relation_type_archive', args, (
          `Archiving relation type '${args.relation_type}' will deactivate ${impact.links} active links.`
        ), mrtr)
        if (pending !== undefined) return pending
      }
      await archiveSchemaRelation(deps, ctx, args.relation_type, args.reason)
      return jsonResult({ archived: true, links: impact.links })
    },
  })

  defineTool(server, {
    name: 'crm_matching_rule_set',
    description: 'Replace duplicate rules for an object type. Existing live data may require an internal backfill; until collision-free activation, the old generation remains effective. Re-call to inspect; set retry_backfill only after resolving reported collisions or a terminal job failure/cancel.',
    input: CrmMatchingRuleSet.in.shape,
    handler: async (args) => jsonResult(await replaceSchemaMatchingRules(deps, ctx, args.object_type, {
      rules: args.rules,
      retryBackfill: args.retry_backfill,
    })),
  })

  defineTool(server, {
    name: 'crm_template_apply',
    description: 'Apply a schema template by slug (see crm://templates), e.g. standard_crm: people, companies, deals. Idempotent: existing slugs untouched. Unknown slug ⇒ UNKNOWN_TEMPLATE {available}.',
    input: CrmTemplateApply.in.shape,
    handler: async (args) => {
      const result = await applySchemaTemplate(deps, ctx, args.template)
      return jsonResult({
        added: {
          object_types: result.added.objectTypes,
          attributes: result.added.attributes,
          relation_types: result.added.relationTypes,
          matching_rules: result.added.matchingRules,
        },
      })
    },
  })
}
