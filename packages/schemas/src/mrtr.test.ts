import { describe, expect, it } from 'vitest'
import {
  ApprovalContent,
  ConfirmContent,
  ElicitationRequest,
  ElicitResult,
  InputRequests,
  InputResponses,
} from './mrtr.js'

const confirmation = {
  method: 'elicitation/create' as const,
  params: {
    mode: 'form' as const,
    message: 'Proceed?',
    requestedSchema: {
      type: 'object',
      properties: { confirmed: { type: 'boolean' } },
      required: ['confirmed'],
    },
  },
}

describe('MRTR contracts', () => {
  it('accepts the normative elicitation maps and results', () => {
    expect(ElicitationRequest.parse(confirmation)).toEqual(confirmation)
    expect(InputRequests.parse({ confirm: confirmation })).toEqual({ confirm: confirmation })
    expect(ElicitResult.parse({ action: 'accept', content: { confirmed: true } })).toEqual({
      action: 'accept', content: { confirmed: true },
    })
    expect(InputResponses.parse({ confirm: { action: 'decline' } })).toEqual({
      confirm: { action: 'decline' },
    })
  })

  it('validates confirmation and approval response content', () => {
    expect(ConfirmContent.parse({ confirmed: true })).toEqual({ confirmed: true })
    expect(ApprovalContent.parse({ approved: false, note: 'Not this record' })).toEqual({
      approved: false, note: 'Not this record',
    })
    expect(() => ApprovalContent.parse({ approved: true, note: 'x'.repeat(501) })).toThrow()
  })
})

