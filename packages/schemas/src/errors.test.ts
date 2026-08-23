import { describe, expect, it } from 'vitest'

import { ErrorCode, ErrorCodeSchema, isServiceError, ServiceError } from './errors.js'

describe('isServiceError', () => {
  it('returns true for a ServiceError', () => {
    const err = new ServiceError(ErrorCode.NOT_FOUND, 'record not found')
    expect(isServiceError(err)).toBe(true)
  })

  it('returns false for other values', () => {
    expect(isServiceError(new Error('boom'))).toBe(false)
    expect(isServiceError({ code: 'NOT_FOUND', message: 'x' })).toBe(false)
    expect(isServiceError(null)).toBe(false)
    expect(isServiceError(undefined)).toBe(false)
    expect(isServiceError('NOT_FOUND')).toBe(false)
  })
})

describe('ErrorCode', () => {
  it('has unique codes', () => {
    const values = Object.values(ErrorCode)
    expect(new Set(values).size).toBe(values.length)
  })

  it('covers every code in ErrorCodeSchema', () => {
    for (const value of Object.values(ErrorCode)) {
      expect(ErrorCodeSchema.safeParse(value).success).toBe(true)
    }
  })
})
