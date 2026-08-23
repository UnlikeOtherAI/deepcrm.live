import { z } from 'zod'
import { SlugSchema, UuidSchema } from './ids.js'

const Slug = SlugSchema
const Uuid = UuidSchema

const Candidate = z.object({
  record: z.object({ id: Uuid, object_type: Slug, display_name: z.string() }),
  rule_position: z.number().int().nullable(),
  evidence: z.array(z.object({
    kind: z.enum(['unique', 'exact', 'normalized', 'fuzzy', 'semantic']),
    attribute: Slug.nullable(),
    value: z.unknown(),
    score: z.number().optional(),
  })),
})

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

export const NextHint = z.enum(['retry_with_approval', 'fetch_and_retry', 'use_redirect', 'fix_input', 'fatal'])
export const ErrorPayload = z.object({
  code: ErrorCodeSchema, message: z.string().describe('template text; never echoes submitted values'),
  next: NextHint.describe('what the agent should do next'),
  issues: z.array(z.object({
    path: z.string().describe('RFC 6901 JSON Pointer'), message: z.string(),
  })).optional(), // VALIDATION_FAILED
  current: z.number().int().optional(),                                              // VERSION_CONFLICT
  attribute: Slug.optional(), record_id: Uuid.optional(),
  candidates: z.array(Candidate).optional(), // DUPLICATE_FOUND
  redirect_to: Uuid.optional(),                                                      // MERGED
  resource: z.string().optional(), action: z.string().optional(), // POLICY_DENIED / APPROVAL_REQUIRED
  link_id: Uuid.optional(), // CARDINALITY_VIOLATION / DELETE_RESTRICTED
  held_by: Uuid.optional(),                                                          // RESTORE_CONFLICT
  limit: z.number().int().optional(),                                                // LIMIT_EXCEEDED
  available: z.array(Slug).optional(),                                               // UNKNOWN_TEMPLATE
  origin: z.string().nullable().optional(),                                          // ORIGIN_REJECTED
  correlation_id: z.string().optional(),                                             // INTERNAL
  detail: z.string().optional(),
})
