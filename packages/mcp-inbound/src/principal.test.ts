import { PrincipalSchema } from '@deepcrm/schemas'
import { describe, expect, it } from 'vitest'
import { devPrincipal } from './principal.js'

describe('devPrincipal', () => {
  it('creates the exact development principal for the request', () => {
    const principal = devPrincipal('req_x')

    expect(PrincipalSchema.parse(principal)).toEqual(principal)
    expect(principal.provenance?.requestId).toBe('req_x')
  })
})
