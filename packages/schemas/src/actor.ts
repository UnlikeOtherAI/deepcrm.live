import { z } from 'zod'

export const ActorTypeSchema = z.enum(['human', 'agent', 'system'])
export const ActorSchema = z.object({ type: ActorTypeSchema, id: z.string().min(1) })
export type Actor = z.infer<typeof ActorSchema>
