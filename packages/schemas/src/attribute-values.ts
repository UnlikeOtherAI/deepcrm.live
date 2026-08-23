/* eslint-disable max-len */
import { z } from 'zod'
import { Slug } from './primitives.js'
export const CurrencyValue = z.object({ amount: z.string().regex(/^-?\d+(\.\d{1,4})?$/).describe('canonical non-exponent decimal string; never rounded'), currency: z.string().regex(/^[A-Z]{3}$/).describe('ISO 4217 uppercase code') })
export const LocationValue = z.object({ line1: z.string().max(200).optional(), line2: z.string().max(200).optional(), city: z.string().max(120).optional(), region: z.string().max(120).optional(), postal: z.string().max(32).optional(), country: z.string().length(2).toUpperCase().optional().describe('ISO 3166-1 alpha-2'), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() })
export const PersonalNameValue = z.object({ first: z.string().max(120).optional(), last: z.string().max(120).optional(), full: z.string().max(250).optional().describe('derived from first+last when absent') }).refine((value) => value.full || value.first || value.last, 'at least one of first, last, full')
export const SelectOption = z.object({ id: Slug, label: z.string().min(1).max(120), color: z.string().max(32).optional() })
export const StatusOption = SelectOption.extend({ category: z.enum(['open', 'won', 'lost', 'neutral']).describe('pipeline semantics of this stage'), position: z.number().int().min(0) })
