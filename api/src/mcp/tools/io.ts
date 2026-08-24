import {
  CrmChangesSince,
  CrmExportInputShape,
  CrmWebhookDelete,
  CrmWebhookList,
  CrmWebhookSet,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { changesSince } from '../../services/io.js'
import { enqueueExport } from '../../services/exports.js'
import { deleteWebhook, listWebhooks, setWebhook } from '../../services/webhooks.js'
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
    handler: async (args) => {
      const result = await enqueueExport(deps, ctx, {
        objectType: args.object_type,
        view: args.view,
        format: args.format,
        attributes: args.attributes,
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      })
      return taskCreated(result.task)
    },
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
    name: 'crm_webhook_set',
    description: 'Register or update an owner-approved HMAC webhook from now on. Creation or explicit rotation returns secret material once; integration code must keep it out of model context.',
    input: CrmWebhookSet.in.shape,
    handler: async (args) => {
      const result = await setWebhook(deps, ctx, {
        url: args.url,
        events: args.events,
        active: args.active,
        rotateSecret: args.rotate_secret,
      })
      return ok(result, JSON.stringify(result))
    },
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
    handler: async (args) => {
      const result = await deleteWebhook(deps, ctx, args.id)
      return ok(result, JSON.stringify(result))
    },
  })
}
