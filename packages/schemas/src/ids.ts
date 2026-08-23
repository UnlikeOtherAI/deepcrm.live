import { z } from 'zod'

export const UuidSchema = z.string().uuid()
export const SlugSchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/)
