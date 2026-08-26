import { z } from 'zod'
import { Cursor, IsoDateTime, Limit, Slug } from './primitives.js'

export const SuppressionKind = z.enum(['email', 'phone', 'domain', 'company_number', 'postal'])
export const SuppressionChannel = z.enum(['all', 'email', 'phone_call', 'sms', 'post'])
export const SuppressionReason = z.enum(['objection', 'erasure', 'bounce', 'manual'])
export const EraseReason = z.enum(['gdpr_request', 'retention_policy', 'legal_order', 'other'])

const suppressionKind = SuppressionKind.describe('structural fact kind to normalize and hash')
const suppressionValue = z.string().min(1).max(320)
  .describe('raw value normalized in memory only; phone must be E.164 and postal must be caller-pre-normalized')
const suppressionChannel = SuppressionChannel.default('all')
  .describe('channel being suppressed; all suppresses every channel')
const suppressionReason = SuppressionReason.describe('reason for suppression')

export const CrmSuppressionAdd = {
  in: z.object({
    kind: suppressionKind,
    value: suppressionValue,
    channel: suppressionChannel,
    reason: suppressionReason,
    sub_reason: Slug.optional().describe('queryable refinement such as opt_out, complaint, or not_interested'),
    expires_at: IsoDateTime.optional().describe('expiry for time-boxed entries; refused for objection and erasure'),
  }),
  out: z.object({ added: z.literal(true) }),
}

export const CrmSuppressionCheck = {
  in: z.object({
    entries: z.array(z.object({
      kind: suppressionKind,
      value: suppressionValue,
      channel: suppressionChannel,
    })).min(1).max(100).describe('values to test before outbound use'),
  }),
  out: z.object({
    results: z.array(z.object({
      kind: SuppressionKind,
      suppressed: z.boolean(),
      reason: SuppressionReason.optional(),
      sub_reason: Slug.optional(),
    })),
  }),
}

export const CrmSuppressionList = {
  in: z.object({
    kind: SuppressionKind.optional().describe('optional kind filter'),
    channel: SuppressionChannel.optional().describe('optional channel filter'),
    reason: SuppressionReason.optional().describe('optional reason filter'),
    sub_reason: Slug.optional().describe('optional sub-reason filter'),
    cursor: Cursor,
    limit: Limit,
  }),
  out: z.object({
    entries: z.array(z.object({
      kind: SuppressionKind,
      channel: SuppressionChannel,
      key_hash: z.string(),
      reason: SuppressionReason,
      sub_reason: Slug.nullable(),
      expires_at: IsoDateTime.nullable(),
      created_at: IsoDateTime,
    })),
    next_cursor: z.string().nullable(),
  }),
}

export const CrmSuppressionRemove = {
  in: z.object({
    kind: suppressionKind,
    value: suppressionValue,
    channel: suppressionChannel,
    reason: z.string().min(1).max(500).describe('operator reason for removing suppression'),
  }),
  out: z.object({ removed: z.boolean() }),
}

export const CrmRecordErase = {
  in: z.object({
    id: z.string().uuid().describe('record id to erase permanently; direct reads return ERASED after success'),
    reason: EraseReason.describe('closed reason enum; no free-text personal data is accepted'),
    suppress: z.boolean().default(true)
      .describe('when true, hash-suppress email, phone, domain, and registry_id values before scrubbing'),
  }),
  out: z.object({
    erased: z.literal(true),
    suppressed: z.array(z.object({
      kind: SuppressionKind,
      count: z.number().int().nonnegative(),
    })),
  }),
}

export const CrmWriteGuardSet = {
  in: z.object({
    rejected_origins: z.array(z.string().min(1).max(64))
      .max(50)
      .optional()
      .describe('complete set of origin classes refused with ORIGIN_REJECTED'),
    require_origin: z.boolean()
      .optional()
      .describe('refuse writes that declare no origin'),
    team_visibility_only_apps: z.array(z.string().min(1).max(64))
      .max(20)
      .optional()
      .describe('app keys whose writes must remain visibility: team; otherwise VISIBILITY_REJECTED'),
  }),
  out: z.object({
    rejected_origins: z.array(z.string()),
    require_origin: z.boolean(),
    team_visibility_only_apps: z.array(z.string()),
  }),
}
