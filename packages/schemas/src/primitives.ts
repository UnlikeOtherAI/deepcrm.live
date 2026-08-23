import { z } from 'zod'

export const Uuid = z.string().uuid().describe('UUID')
export const Slug = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/).describe('snake_case identifier, 2–63 chars, starts with a letter')
export const IsoDateTime = z.string().datetime({ offset: true }).describe('ISO 8601 timestamp')
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD')
export const Limit = z.number().int().min(1).max(200).default(50).describe('page size, 1–200')
export const Cursor = z.string().min(1).optional().describe('opaque cursor from a previous page')
export const Reason = z.string().max(500).optional().describe('why this change is being made; stored on the change history')
export const IdempotencyKey = z.string().min(8).max(128).optional().describe('replay-safe key: same key + same arguments within 24h returns the original result')
export const ExpectedVersion = z.number().int().positive().optional().describe('fail with VERSION_CONFLICT if the record version differs (optimistic concurrency)')
export const ActorType = z.enum(['human', 'agent', 'system'])
export const Actor = z.object({ type: z.enum(['human', 'agent']).describe('human = UOA user, agent = Nessie agent'), id: z.string().min(1).describe('UOA user id or agent id') })
export type Actor = z.infer<typeof Actor>
