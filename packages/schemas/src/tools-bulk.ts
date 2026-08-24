import { z } from 'zod'

import { ActorSchema } from './actor.js'
import { ErrorCodeSchema } from './errors.js'
import { IdempotencyKey, IsoDateTime, Reason, Slug, Uuid } from './primitives.js'
import { LinkInput, RecordData } from './tools-records.js'

export const McpTaskStatus = z.enum([
  'working', 'input_required', 'completed', 'failed', 'cancelled',
])

export const McpTask = z.object({
  taskId: Uuid.describe('opaque queue task id'),
  status: McpTaskStatus.describe('current MCP task lifecycle state'),
  ttl: z.number().int().nonnegative().nullable()
    .describe('milliseconds the task remains available; null means no expiry'),
  createdAt: IsoDateTime.describe('task creation timestamp'),
  lastUpdatedAt: IsoDateTime.describe('most recent task state timestamp'),
  pollInterval: z.number().int().positive().optional()
    .describe('suggested milliseconds between tasks/get polls'),
  statusMessage: z.string().optional().describe('safe terminal diagnostic without submitted data'),
}).strict()

export const BulkAssertProgress = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict()

export const BulkAssertFailure = z.object({
  index: z.number().int().nonnegative(),
  code: ErrorCodeSchema,
  message: z.string().describe('safe validation or policy message without submitted row values'),
}).strict()

export const BulkAssertResult = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  failed: z.array(BulkAssertFailure),
}).strict()

export const BulkAssertRow = z.object({
  data: RecordData.describe('complete record values including the unique match attribute'),
  links: z.array(LinkInput).max(20).optional().describe('links applied atomically with this row'),
}).strict()

export const CrmRecordsBulkAssert = {
  in: z.object({
    object_type: Slug.describe('object type slug shared by every row'),
    match_attribute: Slug.describe('unique attribute present in every row data object'),
    rows: z.array(BulkAssertRow).min(1).max(10_000)
      .describe('rows to upsert; server cap is advertised by server/discover'),
    reason: Reason,
    idempotency_key: IdempotencyKey,
  }).strict(),
  out: z.object({ task: McpTask }).strict(),
}

const Provenance = z.object({
  runId: z.string(),
  toolCallId: z.string(),
  requestId: z.string(),
}).strict()

export const BulkAssertActorContext = z.object({
  tenant: z.object({ organizationId: Uuid, teamId: Uuid }).strict(),
  app: z.string().min(1),
  actChain: z.array(z.object({ sub: z.string(), product: z.string() }).strict()),
  actor: ActorSchema,
  onBehalfOf: z.object({
    uoaUserId: z.string().min(1),
    role: z.enum(['owner', 'admin', 'member']).nullable(),
  }).strict(),
  provenance: Provenance.nullable(),
  requestId: z.string().min(1),
}).strict()

export const BulkAssertPayloadRow = BulkAssertRow.extend({
  idempotencyKey: z.string().min(8).max(128),
}).strict()

export const BulkAssertPayload = z.object({
  organizationId: Uuid,
  teamId: Uuid,
  objectType: Slug,
  matchAttribute: Slug,
  rows: z.array(BulkAssertPayloadRow).min(1).max(10_000),
  reason: z.string().max(500).optional(),
  argumentsHash: z.string().regex(/^[a-f0-9]{64}$/),
  actorContext: BulkAssertActorContext,
}).strict()

export const TaskIdInput = z.object({
  taskId: Uuid.describe('task id returned by the originating tool call'),
}).strict()
