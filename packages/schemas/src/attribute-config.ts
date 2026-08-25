import { z } from 'zod'

import { SelectOption, StatusOption, SupportedIso4217CurrencyCode } from './attribute-values.js'
import { Slug } from './primitives.js'

export const AttributeType = z.enum([
  'text', 'rich_text', 'number', 'currency', 'percent', 'boolean', 'date', 'datetime', 'select', 'status',
  'rating', 'email', 'phone', 'url', 'domain', 'registry_id', 'location', 'personal_name', 'actor_reference',
  'record_reference', 'timestamp_system', 'json',
])
export const AttributeConfig = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), maxLength: z.number().int().min(1).max(4000).default(4000) }),
  z.object({ type: z.literal('rich_text') }),
  z.object({
    type: z.literal('number'),
    precision: z.number().int().min(0).max(10).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    type: z.literal('currency'),
    defaultCurrency: SupportedIso4217CurrencyCode.default('USD'),
    fixedCurrency: SupportedIso4217CurrencyCode.optional()
      .describe('pin every value to one currency so range filters are comparable'),
  }),
  z.object({ type: z.literal('percent') }),
  z.object({ type: z.literal('boolean') }),
  z.object({ type: z.literal('date') }),
  z.object({ type: z.literal('datetime') }),
  z.object({
    type: z.literal('select'),
    options: z.array(SelectOption).min(1).max(200).describe('option ids are unique'),
  }),
  z.object({
    type: z.literal('status'),
    options: z.array(StatusOption).min(2).max(50).describe('ids unique; positions contiguous from zero'),
  }),
  z.object({ type: z.literal('rating'), max: z.number().int().min(1).max(10).default(5) }),
  z.object({ type: z.literal('email') }),
  z.object({ type: z.literal('phone') }),
  z.object({ type: z.literal('url') }),
  z.object({ type: z.literal('domain') }),
  z.object({ type: z.literal('registry_id'), jurisdiction: z.string().length(2).optional() }),
  z.object({ type: z.literal('location') }),
  z.object({ type: z.literal('personal_name') }),
  z.object({
    type: z.literal('actor_reference'),
    allow: z.array(z.enum(['human', 'agent'])).default(['human', 'agent']),
    role: z.enum(['owner', 'collaborator', 'assignee', 'created_by', 'modified_by']).default('collaborator')
      .describe('semantic role for policy: owner, collaborator and assignee may grant edit access'),
  }),
  z.object({
    type: z.literal('record_reference'),
    objectTypes: z.array(Slug).min(1).describe('allowed target object types'),
    relationTypeSlug: Slug.optional()
      .describe('backing relation (one per attribute, never shared — schema-engine §4f); generated as <objectType>_<attr> when absent'),
  }),
  z.object({
    type: z.literal('timestamp_system'),
    source: z.enum(['created_at', 'updated_at', 'last_activity_at'])
      .describe('virtual source; timestamp_system is computed and read-only; T12 owns write-time rejection'),
  }),
  z.object({
    type: z.literal('json'),
    schema: z.record(z.unknown()).optional()
      .describe('optional Draft 2020-12 JSON Schema; Ajv v8, no external refs; value max 64 KiB'),
  }),
])
