import { z } from 'zod'
import { IsoDateTime, Slug, Uuid } from './primitives.js'

/** A current form-entry decision, never a grant for submitted values or a later write. */
export const CrmRecordCreateAdmission = {
  in: z.object({
    object_type: Slug.describe('active object type slug; evaluate for the authenticated caller and tenant'),
  }).strict(),
  out: z.object({
    object_type_id: Uuid,
    schema_version: z.number().int().nonnegative(),
    create: z.enum(['allowed', 'approval_required', 'denied']),
    observed_at: IsoDateTime,
  }).strict(),
}
