import { z } from 'zod'

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
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z.record(z.unknown()).optional(),
})
export const InputResponses = z.record(z.string(), ElicitResult)

// What DeepCRM seals inside requestState (AEAD; keyring key id 'mrtr'):
export type RequestStatePayload = {
  app: string; uoaUserId: string
  tool: string; argumentsHash: string
  impact: string
  approvalId?: string
  approvalToken?: string
  exp: number
}

// Server-side request shapes the confirm/approval elicitations ask for:
export const ConfirmContent = z.object({ confirmed: z.boolean() })
export const ApprovalContent = z.object({ approved: z.boolean(), note: z.string().max(500).optional() })
