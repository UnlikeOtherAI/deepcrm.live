import { z } from 'zod'

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
