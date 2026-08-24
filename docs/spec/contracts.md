# Contracts — shared types and every tool's input/output (zod)

Normative. `packages/schemas/src/*` is a verbatim copy of the code blocks below, split by the file names in the headings. Tool registrations in `api/src/mcp/tools/*` import these and nothing else for argument shapes. `docs/mcp-surface.md` is the prose; this file is the types.

Conventions: import lines are shown only in the first block — every other file imports `z` and its sibling modules as used. Every field has `.describe()` (the text agents see). Outputs are **not** validated at runtime (types only) except where noted. `z` is `zod@3.25`.

## `primitives.ts`

```ts
import { z } from 'zod'

export const Uuid = z.string().uuid().describe('UUID')
export const Slug = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/)
  .describe('snake_case identifier, 2–63 chars, starts with a letter')
export const IsoDateTime = z.string().datetime({ offset: true }).describe('ISO 8601 timestamp')
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD')
export const Limit = z.number().int().min(1).max(200).default(50).describe('page size, 1–200')
export const Cursor = z.string().min(1).optional().describe('opaque cursor from a previous page')
export const Reason = z.string().max(500).optional()
  .describe('why this change is being made; stored on the change history')
export const IdempotencyKey = z.string().min(8).max(128).optional()
  .describe('replay-safe key: same key + same arguments within 24h returns the original result')
export const ExpectedVersion = z.number().int().positive().optional()
  .describe('fail with VERSION_CONFLICT if the record version differs (optimistic concurrency)')

export const ActorType = z.enum(['human', 'agent', 'system'])
export const Actor = z.object({
  type: z.enum(['human', 'agent']).describe('human = UOA user, agent = Nessie agent'),
  id: z.string().min(1).describe('UOA user id or agent id'),
})
export type Actor = z.infer<typeof Actor>
```

## `attribute-values.ts` — value shapes per attribute type

```ts
import { code as findCurrency } from 'currency-codes'

// Backed by the maintained finite set of currently supported ISO 4217 codes.
// A regex alone is not a currency validator: withdrawn, reserved, and
// otherwise unassigned three-letter strings must be rejected.
const isSupportedIso4217Code = (value: string): boolean => findCurrency(value) !== undefined
export const SupportedIso4217CurrencyCode = z.string().refine(isSupportedIso4217Code,
  'must be a supported ISO 4217 currency code')
export const CurrencyValue = z.object({
  amount: z.string().regex(/^-?\d+(\.\d{1,4})?$/).describe('canonical non-exponent decimal string; never rounded'),
  currency: SupportedIso4217CurrencyCode.describe('supported ISO 4217 uppercase code; a three-letter pattern alone is invalid'),
})
export const LocationValue = z.object({
  line1: z.string().max(200).optional(), line2: z.string().max(200).optional(),
  city: z.string().max(120).optional(), region: z.string().max(120).optional(),
  postal: z.string().max(32).optional(),
  country: z.string().length(2).toUpperCase().optional().describe('ISO 3166-1 alpha-2'),
  lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(),
})
export const PersonalNameValue = z.object({
  first: z.string().max(120).optional(), last: z.string().max(120).optional(),
  full: z.string().max(250).optional().describe('derived from first+last when absent'),
}).refine(v => v.full || v.first || v.last, 'at least one of first, last, full')
export const SelectOption = z.object({
  id: Slug,
  label: z.string().min(1).max(120),
  color: z.string().min(1).max(32).optional(),
})
export const StatusOption = SelectOption.extend({
  category: z.enum(['open', 'won', 'lost', 'neutral']).describe('pipeline semantics of this stage'),
  position: z.number().int().min(0),
})
```

## `attribute-config.ts` — `attributes.config` per type

```ts
export const AttributeType = z.enum([
  'text','rich_text','number','currency','percent','boolean','date','datetime','select','status',
  'rating','email','phone','url','domain','registry_id','location','personal_name','actor_reference',
  'record_reference','timestamp_system','json',
])
export const AttributeConfig = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), maxLength: z.number().int().min(1).max(4000).default(4000) }),
  z.object({ type: z.literal('rich_text') }),
  z.object({ type: z.literal('number'), precision: z.number().int().min(0).max(10).optional(),
             min: z.number().optional(), max: z.number().optional() }),
  z.object({ type: z.literal('currency'), defaultCurrency: SupportedIso4217CurrencyCode.default('USD'),
             fixedCurrency: SupportedIso4217CurrencyCode.optional()
               .describe('pin every value to one currency so range filters are comparable') }),
  z.object({ type: z.literal('percent') }),
  z.object({ type: z.literal('boolean') }),
  z.object({ type: z.literal('date') }),
  z.object({ type: z.literal('datetime') }),
  z.object({ type: z.literal('select'), options: z.array(SelectOption).min(1).max(200).describe('option ids are unique') }),
  z.object({ type: z.literal('status'), options: z.array(StatusOption).min(2).max(50).describe('ids unique; positions contiguous from zero') }),
  z.object({ type: z.literal('rating'), max: z.number().int().min(1).max(10).default(5) }),
  z.object({ type: z.literal('email') }),
  z.object({ type: z.literal('phone') }),
  z.object({ type: z.literal('url') }),
  z.object({ type: z.literal('domain') }),
  z.object({ type: z.literal('registry_id'), jurisdiction: z.string().length(2).optional() }),
  z.object({ type: z.literal('location') }),
  z.object({ type: z.literal('personal_name') }),
  z.object({ type: z.literal('actor_reference'),
             allow: z.array(z.enum(['human','agent'])).default(['human','agent']) }),
  z.object({ type: z.literal('record_reference'),
             objectTypes: z.array(Slug).min(1).describe('allowed target object types'),
             relationTypeSlug: Slug.optional().describe('backing relation (one per attribute, never shared — schema-engine §4f); generated as <objectType>_<attr> when absent') }),
  z.object({ type: z.literal('timestamp_system'),
             source: z.enum(['created_at','updated_at','last_activity_at'])
               .describe('virtual source; timestamp_system is computed and read-only; T12 owns write-time rejection') }),
  z.object({ type: z.literal('json'), schema: z.record(z.unknown()).optional()
             .describe('optional Draft 2020-12 JSON Schema; Ajv v8, no external refs; value max 64 KiB') }),
])
```

## `schema-specs.ts` — definitions and details

```ts
export const Sensitivity = z.enum(['public','internal','confidential','restricted'])
export const Cardinality = z.enum(['one_to_one','one_to_many','many_to_one','many_to_many'])
export const OnDelete = z.enum(['unlink','cascade','restrict'])

export const AttributeSpec = z.object({
  slug: Slug, name: z.string().min(1).max(120),
  description: z.string().max(500).describe('shown to agents; say what the value means'),
  type: AttributeType,
  config: z.record(z.unknown()).optional().describe('type-specific config; see attribute-config.ts'),
  is_multi: z.boolean().default(false).describe('accepts an array of values'),
  is_required: z.boolean().default(false),
  is_unique: z.boolean().default(false).describe('enforced; enables crm_record_assert on this attribute'),
  is_indexed: z.boolean().default(false).describe('creates an index for filtering/sorting'),
  sensitivity: Sensitivity.default('internal'),
  default_value: z.unknown().optional(),
})
export type AttributeSpec = z.infer<typeof AttributeSpec>

export const AttributeDetail = AttributeSpec.extend({
  id: Uuid, is_system: z.boolean(), position: z.number().int(), archived_at: IsoDateTime.nullable(),
})
export const ObjectTypeDetail = z.object({
  id: Uuid, slug: Slug, singular_name: z.string(), plural_name: z.string(), description: z.string(),
  icon: z.string().nullable(), kind: z.enum(['system','standard','custom']),
  primary_attribute: Slug.nullable(), attributes: z.array(AttributeDetail),
  relation_types: z.array(z.object({ slug: Slug, direction: z.enum(['from','to']), name: z.string(),
    other_object_type: Slug.nullable(), cardinality: Cardinality })),
  archived_at: IsoDateTime.nullable(),
})
export const RelationTypeDetail = z.object({
  id: Uuid, slug: Slug, from_object_type: Slug.nullable(), to_object_type: Slug.nullable(),
  forward_name: z.string(), inverse_name: z.string(), description: z.string(),
  cardinality: Cardinality, on_delete: OnDelete, edge_attributes: z.array(AttributeSpec),
  is_system: z.boolean(), archived_at: IsoDateTime.nullable(),
})
export const MatchingRule = z.object({
  attributes: z.array(Slug).min(1).max(4),
  method: z.enum(['exact','normalized','fuzzy']),
  threshold: z.number().min(0.5).max(1).optional().describe('fuzzy only; trigram similarity'),
  action: z.enum(['block','warn']),
})
export const ViewSummary = z.object({
  slug: Slug, name: z.string(), object_type: Slug,
})
export const SchemaSnapshot = z.object({
  schema_version: z.number().int(),
  object_types: z.array(ObjectTypeDetail.pick({ id: true, slug: true, singular_name: true,
    plural_name: true, description: true, kind: true, primary_attribute: true })
    .extend({ attribute_count: z.number().int() })),
  relation_types: z.array(RelationTypeDetail),
  matching_rules: z.record(Slug, z.array(MatchingRule)).describe('by object type slug'),
  views: z.array(ViewSummary),
})
```

## `records.ts` — record shapes

```ts
export const RecordData = z.record(Slug, z.unknown()).describe('attribute slug → value')

export const RecordSummary = z.object({
  id: Uuid, object_type: Slug, display_name: z.string(),
})
export const RecordOut = RecordSummary.extend({
  version: z.number().int(), data: RecordData,
  visibility: Visibility, origin: z.string().nullable(),
  owner: Actor.nullable(),
  created_at: IsoDateTime, updated_at: IsoDateTime, last_activity_at: IsoDateTime.nullable(),
  redacted_attributes: z.array(Slug).describe('attributes hidden by policy'),
  redirected_from: Uuid.optional().describe('present when the requested id was merged into this record'),
})
export type RecordOut = z.infer<typeof RecordOut>

export const LinkInput = z.object({
  relation_type: Slug, to_record_id: Uuid,
  data: z.record(Slug, z.unknown()).optional().describe('edge attribute values'),
  label: z.string().max(120).optional(),
})
export const LinkOut = z.object({
  id: Uuid, relation_type: Slug, from_record_id: Uuid, to_record_id: Uuid,
  label: z.string().nullable(), data: z.record(z.unknown()),
  active_from: IsoDateTime, active_until: IsoDateTime.nullable(),
})
export const Candidate = z.object({
  record: RecordSummary, rule_position: z.number().int().nullable(),
  evidence: z.array(z.object({ kind: z.enum(['unique','exact','normalized','fuzzy','semantic']),
    attribute: Slug.nullable(), matched: z.literal(true), value: z.unknown().optional(),
    score: z.number().optional() })),
})
export const Change = z.object({
  id: Uuid, seq: z.string().describe('per-team, commit-ordered decimal cursor value'),
  resulting_version: z.number().int().describe('version after this change applied: the record\'s version on record rows, the current schema version on kind "schema" rows — never null'),
  record: RecordSummary.nullable().describe('null for kind "schema"'),
  group_id: Uuid.nullable().describe('shared by the paired rows of a link/unlink and by cascade groups'),
  kind: z.enum(['create','set','unset','link','unlink','delete','restore','merge','unmerge','schema']),
  attribute: Slug.nullable(), relation_type: Slug.nullable(), link_id: Uuid.nullable(),
  old_value: z.unknown().optional(), new_value: z.unknown().optional(),
  actor: z.object({ type: ActorType, id: z.string() }), on_behalf_of: z.string().nullable(),
  provenance: z.object({ run_id: z.string().nullable(), tool_call_id: z.string().nullable(),
    request_id: z.string() }),
  reason: z.string().nullable(), occurred_at: IsoDateTime,
})
export const TimelineItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('activity'), record: RecordOut, about: z.array(RecordSummary),
    occurred_at: IsoDateTime }),
  z.object({ kind: z.literal('note'), record: RecordOut, about: z.array(RecordSummary),
    occurred_at: IsoDateTime }),
  z.object({ kind: z.literal('task'), record: RecordOut, about: z.array(RecordSummary),
    occurred_at: IsoDateTime }),
  z.object({ kind: z.literal('change'), change: Change, occurred_at: IsoDateTime }),
])
```

## `filter.ts` — query grammar

```ts
export const FilterOp = z.enum(['eq','neq','in','not_in','is_null','is_not_null','contains',
  'starts_with','gt','gte','lt','lte','between'])
  .describe('comparison operator; valid operators depend on the attribute or system-field type')
export const SystemField = z.enum(['created_at','updated_at','last_activity_at','display_name','owner'])
  .describe('read-only record field outside data')

export type Filter =
  | { and: Filter[] } | { or: Filter[] } | { not: Filter }
  | { attribute: string; op: z.infer<typeof FilterOp>; value?: unknown }
  | { system: z.infer<typeof SystemField>; op: z.infer<typeof FilterOp>; value?: unknown }
  | { linked_to: { relation: string; record_id: string; direction?: 'from' | 'to' } }
  | { text: string }

export const Filter: z.ZodType<Filter> = z.lazy(() => z.union([
  z.object({ and: z.array(Filter).min(1).describe('all child filters must match') }).strict(),
  z.object({ or: z.array(Filter).min(1).describe('at least one child filter must match') }).strict(),
  z.object({ not: Filter.describe('child filter whose result is inverted') }).strict(),
  z.object({
    attribute: Slug.describe('attribute slug on the selected object type'),
    op: FilterOp.describe('operator valid for this attribute type'),
    value: z.unknown().optional().describe('typed operand; omitted only for is_null/is_not_null'),
  }).strict(),
  z.object({
    system: SystemField.describe('system field to compare'),
    op: FilterOp.describe('operator valid for this system field'),
    value: z.unknown().optional().describe('typed operand; omitted only for is_null/is_not_null'),
  }).strict(),
  z.object({ linked_to: z.object({
    relation: Slug.describe('active relation type slug'),
    record_id: Uuid.describe('record id at the requested end of the relation'),
    direction: z.enum(['from','to']).default('from')
      .describe('from matches selected records at the link source; to matches them at the target'),
  }).strict().describe('match records joined to this record by an active link') }).strict(),
  z.object({ text: z.string().min(1).max(200).describe('full-text match on the search document') }).strict(),
])).describe('structured filter; grammar + examples in resource crm://help/filtering. Caps: depth 8, 100 nodes, 16 KiB')

export const Sort = z.array(z.object({
  attribute: Slug.optional().describe('sortable scalar attribute slug; mutually exclusive with system'),
  system: SystemField.optional()
    .describe('sortable system field except owner; mutually exclusive with attribute'),
  direction: z.enum(['asc','desc']).default('asc').describe('sort direction; nulls are always last'),
}).strict()
  .refine(s => !!s.attribute !== !!s.system, 'exactly one of attribute or system')
  .refine(s => s.system !== 'owner', 'owner is filter-only and cannot be sorted'))
  .max(3).describe('ordered sort keys; defaults to created_at descending when omitted')
export type Sort = z.infer<typeof Sort>
```

Op validity by type (enforced by the compiler; `VALIDATION_FAILED` otherwise):

| ops | types |
|---|---|
| `is_null is_not_null` | all attributes; global null tests, not a type capability |
| `eq neq in not_in` | every non-`json` type |
| `contains starts_with` | text, email, url, domain, registry_id, personal_name, select (multi); rich_text, multi actor_reference and multi record_reference support `contains` only |
| `gt gte lt lte between` | number, currency (compares `amount`), percent, rating, date, datetime, timestamp_system, system timestamps |

Multi `actor_reference` membership is canonical JSONB containment; multi
`record_reference` membership is an active backing-link `EXISTS`, never a JSON
projection lookup. Rich-text `contains` compiles to the full-text document; T32
owns document materialisation, so T15 proves its SQL shape but does not claim
populated full-text results.

## `tools.ts` — every tool's input and output

(The implementation may split this across `tools-schema.ts`, `tools-records.ts`, … to honour the 500-line file cap; the export names below are the contract.)

```ts
// ── schema ───────────────────────────────────────────────────────────────────
export const CrmSchemaGet = { in: z.object({ object_type: Slug.optional() }),
  out: z.union([SchemaSnapshot, ObjectTypeDetail]) }
export const CrmObjectTypeDefine = { in: z.object({
  slug: Slug, singular_name: z.string().min(1).max(80), plural_name: z.string().min(1).max(80),
  description: z.string().min(1).max(500).describe('what a record of this type represents'),
  icon: z.string().max(64).optional(), attributes: z.array(AttributeSpec).max(100).optional(),
  primary_attribute: Slug.optional().describe('attribute used as display name') }),
  out: ObjectTypeDetail }
export const CrmObjectTypeUpdate = { in: z.object({ object_type: Slug,
  singular_name: z.string().min(1).max(80).optional(), plural_name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(), icon: z.string().max(64).optional(),
  primary_attribute: Slug.optional() }), out: ObjectTypeDetail }
export const CrmObjectTypeArchive = { in: z.object({ object_type: Slug, reason: Reason }),
  out: z.object({ archived: z.literal(true), records: z.number().int() }) }
export const CrmAttributeDefine = { in: AttributeSpec.extend({ object_type: Slug }), out: AttributeDetail }
export const CrmAttributeUpdate = { in: z.object({ object_type: Slug, attribute: Slug,
  name: z.string().min(1).max(120).optional(), description: z.string().max(500).optional(),
  config: z.record(z.unknown()).optional(), is_required: z.boolean().optional(),
  is_unique: z.boolean().optional(), is_indexed: z.boolean().optional(),
  sensitivity: Sensitivity.optional(), default_value: z.unknown().optional() }), out: AttributeDetail }
export const CrmAttributeArchive = { in: z.object({ object_type: Slug, attribute: Slug, reason: Reason }),
  out: z.object({ archived: z.literal(true), records_with_values: z.number().int() }) }
export const CrmRelationTypeDefine = { in: z.object({ slug: Slug,
  from_object_type: Slug.nullable().describe('null = any object type'),
  to_object_type: Slug.nullable().describe('null = any object type'),
  forward_name: z.string().min(1).max(80).describe('e.g. "works at"'),
  inverse_name: z.string().min(1).max(80).describe('e.g. "employs"'),
  description: z.string().max(500).optional(), cardinality: Cardinality,
  on_delete: OnDelete.default('unlink'), edge_attributes: z.array(AttributeSpec).max(20).optional() }),
  out: RelationTypeDetail }
export const CrmRelationTypeArchive = { in: z.object({ relation_type: Slug, reason: Reason }),
  out: z.object({ archived: z.literal(true), links: z.number().int() }) }
export const MatchingRuleActivation = z.discriminatedUnion('state', [
  z.object({ state: z.literal('active'), taskId: z.null() }),
  z.object({ state: z.literal('pending_backfill'), taskId: z.string() }),
  z.object({ state: z.literal('collision_blocked'), taskId: z.string(),
    group_count: z.number().int(), record_count: z.number().int() }),
])
export const CrmMatchingRuleSet = { in: z.object({ object_type: Slug,
  rules: z.array(MatchingRule).max(10), retry_backfill: z.boolean().default(false) }),
  out: z.object({ rules: z.array(MatchingRule), activation: MatchingRuleActivation }) }
export const CrmTemplateApply = { in: z.object({ template: Slug.describe('a slug from crm://templates; unknown ⇒ UNKNOWN_TEMPLATE') }),
  out: z.object({ added: z.object({ object_types: z.number().int(), attributes: z.number().int(),
    relation_types: z.number().int(), matching_rules: z.number().int() }) }) }

// ── records ──────────────────────────────────────────────────────────────────
const WriteCommon = { reason: Reason, idempotency_key: IdempotencyKey }
export const Visibility = z.enum(['team','users','private'])
  .describe('who can see the record: team (default), an explicit user list, or the creator only — admins are NOT exempt')
const VisibilityArgs = {
  visibility: Visibility.optional(),
  visible_to: z.array(z.string().min(1)).max(100).optional()
    .describe('UOA user ids granted access (implies visibility: users); agents see it when acting for a granted human'),
  origin: z.string().max(64).optional()
    .describe('declared source class of this data (set-once); refused when in the team\'s rejected origins'),
}
export const CrmRecordCreate = { in: z.object({ object_type: Slug, data: RecordData,
  links: z.array(LinkInput).max(50).optional(), owner: Actor.optional(), ...VisibilityArgs, ...WriteCommon }),
  out: z.object({ record: RecordOut, duplicates: z.array(Candidate).optional() }) }
export const CrmRecordUpdate = { in: z.object({ id: Uuid, data: RecordData.describe('null clears a value'),
  owner: Actor.nullable().optional(), ...VisibilityArgs, expected_version: ExpectedVersion, ...WriteCommon }),
  out: z.object({ record: RecordOut }) }
export const CrmRecordAssert = { in: z.object({ object_type: Slug,
  match_attribute: Slug.describe('a unique attribute present in data'), data: RecordData,
  links: z.array(LinkInput).max(50).optional(), owner: Actor.optional(), ...WriteCommon }),
  out: z.object({ record: RecordOut, created: z.boolean(),
    duplicates: z.array(Candidate).optional() }) }
export const CrmRecordGet = { in: z.object({ id: Uuid.optional(), object_type: Slug.optional(),
  match_attribute: Slug.optional(), value: z.unknown().optional(),
  include_links: z.boolean().default(false), include_timeline: z.number().int().min(0).max(50).default(0)
    .describe('number of recent timeline items to include') })
  .refine(a => a.id || (a.object_type && a.match_attribute && a.value !== undefined),
    'id, or object_type + match_attribute + value'),
  out: z.object({ record: RecordOut, links: z.record(Slug, z.array(z.object({ link: LinkOut,
    related: RecordSummary }))).optional(), timeline: z.array(TimelineItem).optional() }) }
export const CrmRecordsQuery = { in: z.object({ object_type: Slug, filter: Filter.optional(),
  sort: Sort.optional(), attributes: z.array(Slug).max(50).optional().describe('project only these'),
  include_total: z.boolean().default(false), cursor: Cursor, limit: Limit }),
  out: z.object({ records: z.array(RecordOut), next_cursor: z.string().nullable(),
    total: z.number().int().optional() }) }
export const CrmRecordsCount = { in: z.object({ object_type: Slug, filter: Filter.optional() }),
  out: z.object({ count: z.number().int() }) }
export const CrmRecordsGetMany = { in: z.object({ ids: z.array(Uuid).min(1).max(100) }),
  out: z.object({ records: z.array(RecordOut), missing: z.array(Uuid) }) }
export const McpTask = z.object({ taskId: Uuid,
  status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
  ttl: z.number().int().nonnegative().nullable(), createdAt: IsoDateTime,
  lastUpdatedAt: IsoDateTime, pollInterval: z.number().int().positive().optional(),
  statusMessage: z.string().optional() }).strict()
export const CrmRecordsBulkAssert = { in: z.object({ object_type: Slug, match_attribute: Slug,
  rows: z.array(z.object({ data: RecordData, links: z.array(LinkInput).max(20).optional() })).min(1).max(10_000)
    .describe('hard cap mirrors DEEPCRM_MAX_BULK_ROWS; see crm://help/limits'),
  reason: Reason, idempotency_key: IdempotencyKey }), out: z.object({ task: McpTask }) }
export const BulkAssertResult = z.object({ created: z.number().int(), updated: z.number().int(),
  failed: z.array(z.object({ index: z.number().int(), code: z.string(), message: z.string() })) })
export const CrmRecordDelete = { in: z.object({ id: Uuid, expected_version: ExpectedVersion, reason: Reason }),
  out: z.object({ deleted: z.literal(true) }) }
export const CrmRecordRestore = { in: z.object({ id: Uuid }), out: z.object({ record: RecordOut }) }
export const CrmRecordAt = { in: z.object({ id: Uuid, at: IsoDateTime }),
  out: z.object({ record_at: z.object({ data: RecordData, links: z.record(Slug, z.array(LinkOut))
    .describe('reference/link state as of `at`; multi ordered by position'),
    version_at: z.number().int(), as_of: IsoDateTime }) }) }
export const CrmRecordHistory = { in: z.object({ id: Uuid, attributes: z.array(Slug).optional(),
  cursor: Cursor, limit: Limit }), out: z.object({ changes: z.array(Change), next_cursor: z.string().nullable() }) }

// ── links ────────────────────────────────────────────────────────────────────
export const CrmLink = { in: z.object({ relation_type: Slug, from_record_id: Uuid, to_record_id: Uuid,
  data: z.record(Slug, z.unknown()).optional(), label: z.string().max(120).optional(), ...WriteCommon }),
  out: z.object({ link: LinkOut, ended_links: z.array(Uuid).describe('links ended by cardinality replacement') }) }
export const CrmUnlink = { in: z.object({ link_id: Uuid.optional(), relation_type: Slug.optional(),
  from_record_id: Uuid.optional(), to_record_id: Uuid.optional(), reason: Reason })
  .refine(a => a.link_id || (a.relation_type && a.from_record_id && a.to_record_id), 'link_id or triple'),
  out: z.object({ link_id: Uuid.describe('the link that was ended (newest active when the triple was ambiguous)') }) }
export const CrmLinksList = { in: z.object({ record_id: Uuid, relation_type: Slug.optional(),
  direction: z.enum(['from','to','both']).default('both'), include_history: z.boolean().default(false),
  cursor: Cursor, limit: Limit }),
  out: z.object({ links: z.array(z.object({ link: LinkOut, related: RecordSummary })),
    next_cursor: z.string().nullable() }) }

// ── lists & views ────────────────────────────────────────────────────────────
export const ListDetail = z.object({ id: Uuid, slug: Slug, name: z.string(), description: z.string(),
  object_type: Slug.nullable(), attributes: z.array(AttributeDetail), entry_count: z.number().int() })
export const CrmListCreate = { in: z.object({ slug: Slug, name: z.string().min(1).max(120),
  description: z.string().max(500).optional(), object_type: Slug.optional(),
  attributes: z.array(AttributeSpec).max(20).optional() }), out: ListDetail }
export const CrmListAdd = { in: z.object({ list: Slug, entries: z.array(z.object({ record_id: Uuid,
  data: z.record(Slug, z.unknown()).optional() })).min(1).max(500) }), out: z.object({ added: z.number().int() }) }
export const CrmListRemove = { in: z.object({ list: Slug, record_ids: z.array(Uuid).min(1).max(500) }),
  out: z.object({ removed: z.number().int() }) }
export const CrmListEntries = { in: z.object({ list: Slug, cursor: Cursor, limit: Limit }),
  out: z.object({ entries: z.array(z.object({ entry: z.object({ id: Uuid, data: z.record(z.unknown()),
    position: z.number().int() }), record: RecordOut })), next_cursor: z.string().nullable() }) }
export const ViewDetail = z.object({ id: Uuid, slug: Slug, name: z.string(), description: z.string(),
  object_type: Slug, filter: Filter, sort: Sort, attributes: z.array(Slug) })
export const CrmViewSave = { in: z.object({ slug: Slug, name: z.string().min(1).max(120), object_type: Slug,
  filter: Filter, sort: Sort.optional(), attributes: z.array(Slug).optional(),
  description: z.string().max(500).optional() }), out: ViewDetail }
export const CrmViewRun = { in: z.object({ view: Slug, cursor: Cursor, limit: Limit }), out: CrmRecordsQuery.out }
export const CrmViewDelete = { in: z.object({ view: Slug }), out: z.object({ deleted: z.literal(true) }) }

// ── activity, tasks, pipeline ────────────────────────────────────────────────
export const ActivityKind = z.enum(['email','call','meeting','note','message','task_event','custom'])
export const CrmActivityLog = { in: z.object({ kind: ActivityKind, occurred_at: IsoDateTime,
  subject: z.string().max(300).optional(), body: z.string().max(100_000).optional(),
  direction: z.enum(['inbound','outbound','internal']).optional(),
  participants: z.array(Actor).max(50).optional(), about: z.array(Uuid).min(1).max(20),
  external_ref: z.string().max(300).optional().describe('source id; re-logging the same ref updates'),
  reason: Reason }), out: z.object({ record: RecordOut }) }
export const CrmNoteAdd = { in: z.object({ title: z.string().max(300).optional(),
  body: z.string().min(1).max(100_000), about: z.array(Uuid).min(1).max(20) }),
  out: z.object({ record: RecordOut }) }
export const CrmRecordTimeline = { in: z.object({ id: Uuid, hops: z.union([z.literal(0), z.literal(1)]).default(0)
  .describe('1 = merge in linked records\' items (policy-filtered; limit is total items)'),
  relation_types: z.array(Slug).optional().describe('with hops 1: only these relations'),
  kinds: z.array(z.enum(['activity','change','note','task'])).optional(),
  since: IsoDateTime.optional(), cursor: Cursor, limit: Limit }),
  out: z.object({ items: z.array(TimelineItem), next_cursor: z.string().nullable() }) }
export const TaskStatus = z.enum(['open','in_progress','done','cancelled'])
export const TaskPriority = z.enum(['low','normal','high','urgent'])
export const CrmTaskCreate = { in: z.object({ title: z.string().min(1).max(300), body: z.string().max(20_000).optional(),
  due_at: IsoDateTime.optional(), assignee: Actor.optional(), priority: TaskPriority.default('normal'),
  about: z.array(Uuid).max(20).optional() }), out: z.object({ record: RecordOut }) }
export const CrmTaskUpdate = { in: z.object({ id: Uuid, status: TaskStatus.optional(), assignee: Actor.nullable().optional(),
  due_at: IsoDateTime.nullable().optional(), priority: TaskPriority.optional(),
  title: z.string().min(1).max(300).optional(), body: z.string().max(20_000).optional() }),
  out: z.object({ record: RecordOut }) }
export const CrmTasksList = { in: z.object({ status: TaskStatus.optional(), assignee: Actor.optional(),
  due_before: IsoDateTime.optional(), due_after: IsoDateTime.optional(), about: Uuid.optional(),
  cursor: Cursor, limit: Limit }), out: CrmRecordsQuery.out }
export const CrmPipelineSummary = { in: z.object({ object_type: Slug,
  status_attribute: Slug.optional().describe('defaults to the only status attribute'),
  amount_attribute: Slug.optional(), filter: Filter.optional(), since: IsoDateTime.optional() }),
  out: z.object({ stages: z.array(z.object({ id: Slug, label: z.string(), category: StatusOption.shape.category,
    count: z.number().int(), amount_sum: CurrencyValue.nullable(), avg_days_in_stage: z.number().nullable() })),
    conversions: z.array(z.object({ from: Slug, to: Slug, count: z.number().int() })) }) }

// ── search, quality, merge ───────────────────────────────────────────────────
export const CrmSearch = { in: z.object({ query: z.string().min(1).max(500).optional(),
  similar_to: Uuid.optional().describe('nearest neighbours of this record\'s stored embedding'),
  object_types: z.array(Slug).optional(),
  mode: z.enum(['keyword','semantic','hybrid']).default('hybrid'), limit: z.number().int().min(1).max(50).default(10) })
  .refine(a => !!a.query !== !!a.similar_to, 'exactly one of query or similar_to'),
  out: z.object({ hits: z.array(z.object({ record: RecordSummary, score: z.number(),
    match: z.enum(['keyword','semantic','both']) })) }) }
export const CrmFindDuplicates = { in: z.object({ object_type: Slug, filter: Filter.optional(),
  include_semantic: z.boolean().default(true) }), out: z.object({ taskId: z.string() }) }
export const FindDuplicatesResult = z.object({ groups: z.array(z.object({ records: z.array(RecordSummary),
  evidence: z.array(Candidate.shape.evidence.element) })) })
export const CrmMergeRecords = { in: z.object({ survivor_id: Uuid, merged_ids: z.array(Uuid).min(1).max(10),
  field_choices: z.record(Slug, Uuid).optional().describe('attribute → record whose value wins'),
  reason: z.string().min(1).max(500) }),
  out: z.object({ record: RecordOut, merge_change_id: Uuid, repointed_links: z.number().int(), ended_links: z.array(Uuid) }) }
export const CrmUnmerge = { in: z.object({ merge_change_id: Uuid, reason: z.string().min(1).max(500) }),
  out: z.object({ restored: z.array(Uuid),
    conflicts: z.array(z.object({ kind: z.enum(['unique_key','matching_rule','link','list_entry']),
      attribute: Slug.optional(), rule_position: z.number().int().optional(),
      link_id: Uuid.optional(), held_by: Uuid.optional() })) }) }
const QualityBucket = z.object({ count: z.number().int(),
  items: z.array(z.object({ record: RecordSummary, detail: z.string() })).max(100),
  query_filter: Filter.describe('run via crm_records_query to paginate the full set') })
export const CrmDataQuality = { in: z.object({ object_type: Slug.optional(),
  stale_days: z.number().int().min(1).max(3650).default(90) }),
  out: z.object({ missing_required: QualityBucket, stale: QualityBucket, orphans: QualityBucket, collisions: QualityBucket }) }

// ── compliance: erasure, suppression, origin guard ───────────────────────────
export const SuppressionKind = z.enum(['email','phone','domain','company_number','postal'])
export const SuppressionChannel = z.enum(['all','email','phone_call','sms','post'])
export const SuppressionReason = z.enum(['objection','erasure','bounce','manual'])
export const EraseReason = z.enum(['gdpr_request','retention_policy','legal_order','other'])
export const CrmRecordErase = { in: z.object({ id: Uuid, reason: EraseReason,
  suppress: z.boolean().default(true).describe('write hashed suppression entries for contact values before scrubbing') }),
  out: z.object({ erased: z.literal(true), suppressed: z.array(z.object({ kind: SuppressionKind, count: z.number().int() })) }) }
export const CrmSuppressionAdd = { in: z.object({ kind: SuppressionKind, value: z.string().min(1).max(320)
    .describe('phone must be E.164; postal must be caller-pre-normalized (schema-engine §4d)'),
  channel: SuppressionChannel.default('all'), reason: SuppressionReason,
  sub_reason: Slug.optional().describe('queryable refinement, e.g. not_interested, opt_out, complaint'),
  expires_at: IsoDateTime.optional().describe('time-boxed suppression; refused on objection/erasure'),
  note: z.string().max(500).optional() }), out: z.object({ added: z.literal(true) }) }
export const CrmSuppressionCheck = { in: z.object({ entries: z.array(z.object({ kind: SuppressionKind,
  value: z.string().min(1).max(320), channel: SuppressionChannel.default('all') })).min(1).max(100) }),
  out: z.object({ results: z.array(z.object({ kind: SuppressionKind, suppressed: z.boolean(),
    reason: SuppressionReason.optional(), sub_reason: Slug.optional() })) }) }
export const CrmSuppressionList = { in: z.object({ kind: SuppressionKind.optional(),
  channel: SuppressionChannel.optional(), reason: SuppressionReason.optional(), sub_reason: Slug.optional(),
  cursor: Cursor, limit: Limit }),
  out: z.object({ entries: z.array(z.object({ kind: SuppressionKind, channel: SuppressionChannel,
    key_hash: z.string(), reason: SuppressionReason, sub_reason: Slug.nullable(),
    expires_at: IsoDateTime.nullable(), note: z.string().nullable(), created_at: IsoDateTime })),
    next_cursor: z.string().nullable() }) }
export const CrmSuppressionRemove = { in: z.object({ kind: SuppressionKind, value: z.string().min(1).max(320),
  channel: SuppressionChannel.default('all'), reason: z.string().min(1).max(500) }),
  out: z.object({ removed: z.boolean() }) }
export const CrmWriteGuardSet = { in: z.object({
  rejected_origins: z.array(z.string().min(1).max(64)).max(50).optional(),
  require_origin: z.boolean().optional().describe('refuse writes that declare no origin'),
  team_visibility_only_apps: z.array(z.string().min(1).max(64)).max(20).optional()
    .describe('app keys whose writes must be visibility: team (VISIBILITY_REJECTED otherwise)') }),
  out: z.object({ rejected_origins: z.array(z.string()), require_origin: z.boolean(),
    team_visibility_only_apps: z.array(z.string()) }) }

// ── io, feed, webhooks ───────────────────────────────────────────────────────
export const CrmExport = { in: z.object({ object_type: Slug.optional(), view: Slug.optional(),
  format: z.enum(['jsonl','csv']), attributes: z.array(Slug).optional(), reason: Reason, idempotency_key: IdempotencyKey })
  .refine(a => !!a.object_type !== !!a.view, 'object_type or view'), out: z.object({ taskId: z.string() }) }
export const ExportResult = z.object({ url: z.string().url(), rows: z.number().int(), expires_at: IsoDateTime })
export const CrmChangesSince = { in: z.object({
  cursor: z.string().optional().describe('decimal seq from a previous page; omit to receive a fresh cursor at now'),
  from: z.literal('beginning').optional().describe('explicit opt-in to replay full retained history'),
  object_types: z.array(Slug).optional(), kinds: z.array(Change.shape.kind).optional(), limit: Limit }),
  out: z.object({ changes: z.array(Change), next_cursor: z.string(), has_more: z.boolean() }) }
export const WebhookEvent = z.enum(['record.created','record.updated','record.deleted','record.merged',
  'link.created','link.ended','schema.changed'])
export const CrmWebhookSet = { in: z.object({ url: z.string().url().describe('https only, public host; identity — set upserts by URL'),
  events: z.array(WebhookEvent).min(1), active: z.boolean().default(true),
  rotate_secret: z.boolean().default(false).describe('mint a new secret for an existing webhook') }),
  out: z.object({ webhook: z.object({ id: Uuid, url: z.string(), events: z.array(WebhookEvent), active: z.boolean() }),
    secret: z.string().optional().describe('creation or rotation only; secret material — never place in model context') }) }
export const CrmWebhookList = { in: z.object({}), out: z.object({ webhooks: z.array(CrmWebhookSet.out.shape.webhook) }) }
export const CrmWebhookDelete = { in: z.object({ id: Uuid }), out: z.object({ deleted: z.literal(true) }) }
```

## `errors.ts` — the single source of truth for codes (as-const map; zod derived from it)

```ts
export const ErrorCode = {
  POLICY_DENIED: 'POLICY_DENIED', APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  UNKNOWN_OBJECT_TYPE: 'UNKNOWN_OBJECT_TYPE', UNKNOWN_ATTRIBUTE: 'UNKNOWN_ATTRIBUTE',
  ATTRIBUTE_ARCHIVED: 'ATTRIBUTE_ARCHIVED', ATTRIBUTE_READ_ONLY: 'ATTRIBUTE_READ_ONLY',
  VALIDATION_FAILED: 'VALIDATION_FAILED', VERSION_CONFLICT: 'VERSION_CONFLICT',
  DUPLICATE_FOUND: 'DUPLICATE_FOUND', NOT_FOUND: 'NOT_FOUND', MERGED: 'MERGED',
  CARDINALITY_VIOLATION: 'CARDINALITY_VIOLATION', DELETE_RESTRICTED: 'DELETE_RESTRICTED',
  RESTORE_CONFLICT: 'RESTORE_CONFLICT', SCHEMA_CONFLICT: 'SCHEMA_CONFLICT',
  IDEMPOTENCY_MISMATCH: 'IDEMPOTENCY_MISMATCH', IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  UNKNOWN_TEMPLATE: 'UNKNOWN_TEMPLATE', TENANT_MISMATCH: 'TENANT_MISMATCH',
  TENANT_REPARENTING: 'TENANT_REPARENTING', ORIGIN_REJECTED: 'ORIGIN_REJECTED',
  VISIBILITY_REJECTED: 'VISIBILITY_REJECTED', ERASED: 'ERASED',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED', INTERNAL: 'INTERNAL',
} as const
// APPEND-ONLY: codes are never renamed or removed (R8). Consumers may treat
// unknown codes as fatal-and-surface.
export type ErrorCodeValue = typeof ErrorCode[keyof typeof ErrorCode]
export const ErrorCodeSchema = z.enum(Object.values(ErrorCode) as [ErrorCodeValue, ...ErrorCodeValue[]])

export class ServiceError extends Error {
  constructor(public code: ErrorCodeValue, message: string, public details: Record<string, unknown> = {}) {
    super(message)
  }
}
export function isServiceError(e: unknown): e is ServiceError { return e instanceof ServiceError }

export const NextHint = z.enum(['retry_with_approval','fetch_and_retry','use_redirect','fix_input','fatal'])
export const ErrorPayload = z.object({
  code: ErrorCodeSchema, message: z.string().describe('template text; never echoes submitted values'),
  next: NextHint.describe('what the agent should do next'),
  issues: z.array(z.object({ path: z.string().describe('RFC 6901 JSON Pointer'), message: z.string() })).optional(), // VALIDATION_FAILED
  current: z.number().int().optional(),                                              // VERSION_CONFLICT
  attribute: Slug.optional(), record_id: Uuid.optional(), candidates: z.array(Candidate).optional(), // DUPLICATE_FOUND
  redirect_to: Uuid.optional(),                                                      // MERGED
  resource: z.string().optional(), action: z.string().optional(),                    // POLICY_DENIED / APPROVAL_REQUIRED
  link_id: Uuid.optional(),                                                          // CARDINALITY_VIOLATION / DELETE_RESTRICTED
  held_by: Uuid.optional(),                                                          // RESTORE_CONFLICT
  limit: z.number().int().optional(),                                                // LIMIT_EXCEEDED
  available: z.array(Slug).optional(),                                               // UNKNOWN_TEMPLATE
  origin: z.string().nullable().optional(),                                          // ORIGIN_REJECTED
  correlation_id: z.string().optional(),                                             // INTERNAL
  detail: z.string().optional(),
})
```

## MRTR shapes (`mrtr.ts`) — spec 2026-07-28 conformant

`inputRequests` values are standard `elicitation/create` requests; `inputResponses` values are `ElicitResult`s; both live at `tools/call` **params** level (sibling of `arguments`), with the AEAD `requestState` echoed verbatim. See `mcp-surface.md` §0.4 for the wire examples.

```ts
export const ElicitationRequest = z.object({
  method: z.literal('elicitation/create'),
  params: z.object({
    mode: z.literal('form'),
    message: z.string(),
    requestedSchema: z.record(z.unknown()).describe('JSON Schema for the requested object'),
  }),
})
export const InputRequests = z.record(z.string(), ElicitationRequest)
export const ElicitResult = z.object({
  action: z.enum(['accept','decline','cancel']),
  content: z.record(z.unknown()).optional(),
})
export const InputResponses = z.record(z.string(), ElicitResult)

// What DeepCRM seals inside requestState (AEAD; keyring key id 'mrtr'):
export type RequestStatePayload = {
  app: string; uoaUserId: string
  tool: string; argumentsHash: string       // canonical JSON hash, auth-and-tenancy §4
  impact: string                            // the human-readable consequence shown in the elicitation
  approvalId?: string                       // approvals only; row is the single-use authority
  exp: number                               // unix seconds, <= 24 h
}
// Server-side request shapes the confirm/approval elicitations ask for:
export const ConfirmContent = z.object({ confirmed: z.boolean() })
export const ApprovalContent = z.object({ approved: z.boolean(), note: z.string().max(500).optional() })
```
