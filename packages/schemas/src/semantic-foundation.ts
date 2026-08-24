import { z } from 'zod'

import { ActorType, IsoDateTime, Slug, Uuid } from './primitives.js'
import { AttributeType } from './attribute-config.js'

const FoundationSensitivity = z.enum(['public', 'internal', 'confidential', 'restricted'])
  .describe('redaction level for a semantic metadata value')

export const AttributeValueSource = z.enum([
  'stored', 'formula', 'rollup', 'relation_sync', 'score', 'system',
]).describe('where an attribute value comes from')
export type AttributeValueSourceValue = z.infer<typeof AttributeValueSource>

export const PipelineStageCategory = z.enum(['open', 'won', 'lost', 'neutral'])
  .describe('terminal/open category used for pipeline reporting')
export const DerivationRefreshState = z.enum(['ready', 'pending', 'refreshing', 'failed'])
  .describe('state of a materialized derived attribute value')
export const ListKind = z.enum(['static', 'dynamic']).describe('static curated list or dynamic segment')
export const ListRefreshState = z.enum(['ready', 'refreshing', 'failed'])
  .describe('state of dynamic-list membership evaluation')
export const FileLinkTargetType = z.enum(['record', 'activity', 'event'])
  .describe('generic target type for a file attachment link')

export const AttributeGroupDetail = z.object({
  id: Uuid.describe('attribute group id'),
  object_type: Slug.describe('object type owning the group'),
  slug: Slug.describe('stable group slug'),
  name: z.string().min(1).describe('group display name'),
  description: z.string().describe('agent-facing group purpose'),
  position: z.number().int().min(0).describe('display order among groups'),
  archived_at: IsoDateTime.nullable().describe('null when the group is active'),
})
export type AttributeGroupDetail = z.infer<typeof AttributeGroupDetail>

export const RelationEdgeLimit = z.object({
  max_active_edges_from: z.number().int().positive().nullable()
    .describe('maximum active outgoing edges per source record, after cardinality'),
  max_active_edges_to: z.number().int().positive().nullable()
    .describe('maximum active incoming edges per target record, after cardinality'),
  label_limits: z.record(z.object({
    max_active_edges_from: z.number().int().positive().optional()
      .describe('label-specific outgoing active-edge limit'),
    max_active_edges_to: z.number().int().positive().optional()
      .describe('label-specific incoming active-edge limit'),
  })).default({}).describe('optional per-label limits that cannot loosen the base limit'),
})
export type RelationEdgeLimit = z.infer<typeof RelationEdgeLimit>

export const PipelineStageDetail = z.object({
  id: Uuid.describe('pipeline stage id'),
  slug: Slug.describe('stable stage slug'),
  name: z.string().min(1).describe('stage display name'),
  position: z.number().int().min(0).describe('stage order inside the pipeline'),
  probability: z.number().min(0).max(1).nullable().describe('optional expected close probability'),
  category: PipelineStageCategory.describe('open, won, lost or neutral stage category'),
  archived_at: IsoDateTime.nullable().describe('null when active'),
})
export const PipelineDetail = z.object({
  id: Uuid.describe('pipeline id'),
  object_type: Slug.describe('object type this pipeline applies to'),
  slug: Slug.describe('stable pipeline slug'),
  name: z.string().min(1).describe('pipeline display name'),
  description: z.string().describe('agent-facing pipeline purpose'),
  is_default: z.boolean().describe('default pipeline for new records of this object type'),
  stages: z.array(PipelineStageDetail).describe('ordered stage catalog'),
  archived_at: IsoDateTime.nullable().describe('null when active'),
})
export type PipelineDetail = z.infer<typeof PipelineDetail>

export const RecordStageHistoryInterval = z.object({
  id: Uuid.describe('stage history interval id'),
  record_id: Uuid.describe('record that occupied the stage'),
  pipeline: Slug.describe('pipeline slug'),
  stage: Slug.describe('stage slug'),
  started_at: IsoDateTime.describe('interval start timestamp'),
  ended_at: IsoDateTime.nullable().describe('interval end timestamp; null means current'),
  change_id: Uuid.nullable().describe('record change that produced the interval, when available'),
})
export type RecordStageHistoryInterval = z.infer<typeof RecordStageHistoryInterval>

export const AttributeDerivationDetail = z.object({
  attribute: Slug.describe('derived attribute slug'),
  type: AttributeType.describe('materialized value type'),
  sensitivity: FoundationSensitivity.describe('redaction level for the derived value'),
  value_source: AttributeValueSource.exclude(['stored']).describe('non-stored value source'),
  materialized: z.boolean().describe('true when the value is stored in records.data'),
  config: z.record(z.unknown()).describe('source-specific deterministic derivation config'),
  refresh_state: DerivationRefreshState.describe('current refresh state'),
  refresh_error_code: z.string().nullable().describe('machine error code for failed refreshes'),
  last_refreshed_at: IsoDateTime.nullable().describe('last successful materialization time'),
  dependencies: z.array(z.object({
    source_kind: z.string().min(1).describe('attribute, relation, stage, event or activity dependency'),
    source_path: z.array(z.string()).describe('bounded typed dependency path'),
    source_attribute: Slug.nullable().describe('source attribute slug when applicable'),
    relation_type: Slug.nullable().describe('source relation type when applicable'),
  })).describe('dependency edges for refresh scheduling'),
})
export type AttributeDerivationDetail = z.infer<typeof AttributeDerivationDetail>

export const DynamicListDefinitionState = z.object({
  list: Slug.describe('list slug'),
  object_type: Slug.describe('object type evaluated by the dynamic list'),
  filter: z.record(z.unknown()).describe('validated structured filter used for membership'),
  evaluation_version: z.number().int().nonnegative().describe('monotonic definition version'),
  refresh_state: ListRefreshState.describe('membership cache state'),
  refresh_error_code: z.string().nullable().describe('machine error code for failed evaluation'),
  last_evaluated_at: IsoDateTime.nullable().describe('last completed evaluation time'),
})
export type DynamicListDefinitionState = z.infer<typeof DynamicListDefinitionState>

export const FileObjectDetail = z.object({
  id: Uuid.describe('file metadata id'),
  provider: z.string().min(1).describe('storage provider key'),
  provider_key: z.string().min(1).describe('provider object key, never a signed URL'),
  filename: z.string().min(1).describe('original filename'),
  mime_type: z.string().min(1).describe('validated MIME type'),
  size_bytes: z.string().regex(/^\d+$/).describe('non-negative byte size as decimal string'),
  checksum_sha256: z.string().nullable().describe('hex sha256 checksum when supplied'),
  metadata: z.record(z.unknown()).describe('provider metadata allowed by policy'),
  created_at: IsoDateTime.describe('registration time'),
})
export const FileLinkDetail = z.object({
  id: Uuid.describe('file link id'),
  file_id: Uuid.describe('linked file id'),
  target_type: FileLinkTargetType.describe('record, activity or event target'),
  record_id: Uuid.nullable().describe('record/activity target id when target_type is record or activity'),
  event_id: Uuid.nullable().describe('event target id when target_type is event'),
  purpose: z.string().min(1).describe('typed attachment purpose'),
  metadata: z.record(z.unknown()).describe('link metadata allowed by policy'),
})
export type FileObjectDetail = z.infer<typeof FileObjectDetail>
export type FileLinkDetail = z.infer<typeof FileLinkDetail>

export const EventTypeDetail = z.object({
  id: Uuid.describe('event type id'),
  slug: Slug.describe('stable event type slug'),
  name: z.string().min(1).describe('event type display name'),
  description: z.string().describe('agent-facing event meaning'),
  subject_object_type: Slug.nullable().describe('required subject object type, when constrained'),
  property_schema: z.record(z.unknown()).describe('closed typed property schema'),
  archived_at: IsoDateTime.nullable().describe('null when active'),
})
export const EventDetail = z.object({
  id: Uuid.describe('event id'),
  event_type: Slug.describe('event type slug'),
  source: z.string().min(1).describe('stable integration/source key'),
  external_id: z.string().min(1).describe('source-scoped idempotency key'),
  occurred_at: IsoDateTime.describe('event occurrence time'),
  subject_record_id: Uuid.nullable().describe('visible subject record id, when present'),
  actor: z.object({ type: ActorType, id: z.string().min(1) }).nullable().describe('event actor reference'),
  properties: z.record(z.unknown()).describe('typed properties after policy redaction'),
  correction_of_event_id: Uuid.nullable().describe('corrected event id when this is a correction'),
})
export type EventTypeDetail = z.infer<typeof EventTypeDetail>
export type EventDetail = z.infer<typeof EventDetail>

export const MigrationReportDetail = z.object({
  migration_name: z.string().min(1).describe('migration that produced the report'),
  code: z.string().min(1).describe('machine-readable report code'),
  resource_type: z.string().min(1).describe('generic resource kind needing attention'),
  resource_id: z.string().nullable().describe('resource id when known'),
  details: z.record(z.unknown()).describe('redacted structured details'),
  created_at: IsoDateTime.describe('report creation time'),
})
export type MigrationReportDetail = z.infer<typeof MigrationReportDetail>
