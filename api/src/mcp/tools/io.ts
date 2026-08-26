import {
  CrmChangesSince,
  CrmEventIngest,
  CrmEventsQuery,
  CrmEventTypeDefine,
  CrmExportInputShape,
  CrmFileLink,
  CrmFileList,
  CrmFileRegister,
  CrmWebhookDelete,
  CrmWebhookList,
  CrmWebhookSet,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { changesSince } from '../../services/io.js'
import { enqueueExport } from '../../services/exports.js'
import {
  defineEventType,
  ingestEvent,
  linkFile,
  listFiles,
  queryEvents,
  registerFile,
} from '../../services/files-events.js'
import { deleteWebhook, listWebhooks, setWebhook } from '../../services/webhooks.js'
import { withApproval } from './approval.js'
import { defineTool } from './register.js'
import { ok, taskCreated } from './result.js'

export function registerIoTools(
  server: Parameters<typeof defineTool>[0],
  ctx: ActorContext,
  deps: AppDeps,
): void {
  defineTool(server, {
    name: 'crm_export',
    description: 'Export exactly one object type or saved view for offline analysis when paginated queries are unsuitable. Returns a Task with a redacted, row-capped CSV or JSONL result at a signed, single-use URL valid for at most one hour; may raise POLICY_DENIED or APPROVAL_REQUIRED.',
    input: CrmExportInputShape,
    handler: withApproval(deps, ctx, 'crm_export', CrmExportInputShape, {
      resourceType: 'export',
      reason: (args) => args.reason,
      message: (args) => `Approve exporting '${args.object_type ?? args.view}'? Requires an admin.`,
    }, async (args, _mrtr, approval) => {
      const result = await enqueueExport(deps, ctx, {
        objectType: args.object_type,
        view: args.view,
        format: args.format,
        attributes: args.attributes,
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      }, approval)
      return taskCreated(result.task)
    }),
  })
  defineTool(server, {
    name: 'crm_changes_since',
    description: 'Read the visible, policy-redacted team change feed by commit-ordered decimal cursor. Omit cursor to start now; use from=beginning only for retained-history replay.',
    input: CrmChangesSince.in.shape,
    handler: async (args) => {
      const result = await changesSince(deps, ctx, {
        cursor: args.cursor,
        from: args.from,
        objectTypes: args.object_types,
        kinds: args.kinds,
        limit: args.limit,
      })
      return ok(result, JSON.stringify(result))
    },
  })
  defineTool(server, {
    name: 'crm_file_register',
    description: 'Register external file metadata only. DeepCRM stores provider/key, size, MIME and checksum, never blobs, signed URLs or secrets. Conflicting provider keys fail.',
    input: CrmFileRegister.in.shape,
    handler: async (args) => ok(await registerFile(deps, ctx, {
      provider: args.provider, providerKey: args.provider_key, filename: args.filename,
      mimeType: args.mime_type, sizeBytes: args.size_bytes, checksumSha256: args.checksum_sha256,
      metadata: args.metadata,
    }), 'file registered'),
  })
  defineTool(server, {
    name: 'crm_file_link',
    description: 'Attach a registered file to a visible record/activity or event with a typed purpose. Target visibility is checked before the attachment is stored.',
    input: CrmFileLink.in.shape,
    handler: async (args) => ok(await linkFile(deps, ctx, {
      fileId: args.file_id, targetType: args.target_type, recordId: args.record_id,
      eventId: args.event_id, purpose: args.purpose, metadata: args.metadata,
    }), 'file linked'),
  })
  defineTool(server, {
    name: 'crm_file_list',
    description: 'List authorized file links and signed short-lived DeepCRM file access URLs. Provider keys stay metadata and are never embedded in the URL.',
    input: CrmFileList.in.shape,
    handler: async (args) => ok(await listFiles(deps, ctx, {
      targetType: args.target_type, recordId: args.record_id, eventId: args.event_id,
      limit: args.limit,
    }), 'files listed'),
  })
  defineTool(server, {
    name: 'crm_event_type_define',
    description: 'Define an immutable behavioural event vocabulary and property schema. Use this before ingesting product or integration events.',
    input: CrmEventTypeDefine.in.shape,
    handler: async (args) => ok(await defineEventType(deps, ctx, {
      slug: args.slug, name: args.name, description: args.description,
      subjectObjectType: args.subject_object_type, propertySchema: args.property_schema,
    }), 'event type defined'),
  })
  defineTool(server, {
    name: 'crm_event_ingest',
    description: 'Append one immutable behavioural event. source plus external_id is idempotent; corrections are new events linked to the original, never updates.',
    input: CrmEventIngest.in.shape,
    handler: async (args) => ok(await ingestEvent(deps, ctx, {
      eventType: args.event_type, source: args.source, externalId: args.external_id,
      occurredAt: args.occurred_at, subjectRecordId: args.subject_record_id,
      actor: args.actor, properties: args.properties, correctionOfEventId: args.correction_of_event_id,
    }), 'event ingested'),
  })
  defineTool(server, {
    name: 'crm_events_query',
    description: 'Query immutable behavioural events by type, source or visible subject record. Cross-tenant and hidden subjects return NOT_FOUND or are omitted.',
    input: CrmEventsQuery.in.shape,
    handler: async (args) => ok(await queryEvents(deps, ctx, {
      eventType: args.event_type, subjectRecordId: args.subject_record_id,
      source: args.source, cursor: args.cursor, limit: args.limit,
    }), 'events listed'),
  })
  defineTool(server, {
    name: 'crm_webhook_set',
    description: 'Register or update an owner-approved HMAC webhook from now on. Creation or explicit rotation returns secret material once; integration code must keep it out of model context.',
    input: CrmWebhookSet.in.shape,
    handler: withApproval(deps, ctx, 'crm_webhook_set', CrmWebhookSet.in.shape, {
      resourceType: 'webhook',
      message: (args) => `Approve webhook registration for '${args.url}'? Requires an owner.`,
    }, async (args, _mrtr, approval) => {
      const result = await setWebhook(deps, ctx, {
        url: args.url,
        events: args.events,
        active: args.active,
        rotateSecret: args.rotate_secret,
      }, approval)
      return ok(result, JSON.stringify(result))
    }),
  })
  defineTool(server, {
    name: 'crm_webhook_list',
    description: 'List all webhooks in the entitled tenant, including inactive delivery errors. Secrets are never returned.',
    input: CrmWebhookList.in.shape,
    handler: async () => {
      const result = await listWebhooks(deps, ctx)
      return ok(result, JSON.stringify(result))
    },
  })
  defineTool(server, {
    name: 'crm_webhook_delete',
    description: 'Delete one owner-approved webhook by id inside the entitled tenant.',
    input: CrmWebhookDelete.in.shape,
    handler: withApproval(deps, ctx, 'crm_webhook_delete', CrmWebhookDelete.in.shape, {
      resourceType: 'webhook',
      resourceId: (args) => args.id,
      message: () => 'Approve webhook deletion? Requires an owner.',
    }, async (args, _mrtr, approval) => {
      const result = await deleteWebhook(deps, ctx, args.id, approval)
      return ok(result, JSON.stringify(result))
    }),
  })
}
