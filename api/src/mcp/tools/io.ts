import { CrmChangesSince, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { changesSince } from '../../services/io.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

export function registerIoTools(
  server: Parameters<typeof defineTool>[0],
  ctx: ActorContext,
  deps: AppDeps,
): void {
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
}

