import type { RelationType } from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'
import { describe, expect, it } from 'vitest'

import { validatedEdgeData } from '../src/links/edge-data.js'

const now = new Date('2026-01-01T00:00:00.000Z')

function relation(edgeAttributes: RelationType['edgeAttributes']): RelationType {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    organizationId: '00000000-0000-4000-8000-000000000001',
    teamId: '00000000-0000-4000-8000-000000000002',
    slug: 'works_at',
    fromObjectTypeId: '00000000-0000-4000-8000-000000000003',
    toObjectTypeId: '00000000-0000-4000-8000-000000000004',
    forwardName: 'works at',
    inverseName: 'employs',
    description: '',
    cardinality: 'many_to_many',
    maxActiveEdgesFrom: null,
    maxActiveEdgesTo: null,
    edgeLimitConfig: {},
    onDelete: 'unlink',
    edgeAttributes,
    projectionAttributeSlug: null,
    isSystem: false,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

const worksAt = relation([
  { slug: 'role', name: 'Role', description: '', type: 'select', is_required: true, config: {
    type: 'select', options: [{ id: 'founder', label: 'Founder' }, { id: 'advisor', label: 'Advisor' }],
  } },
  { slug: 'since', name: 'Since', description: '', type: 'date' },
])

function refusal(action: () => unknown): ServiceError {
  try {
    action()
  } catch (error) {
    if (error instanceof ServiceError) return error
    throw error
  }
  throw new Error('Expected a ServiceError')
}

describe('link edge data', () => {
  it('accepts values of each edge attribute type and canonicalises them', () => {
    expect(validatedEdgeData({ role: 'advisor', since: '2024-02-29' }, worksAt))
      .toEqual({ role: 'advisor', since: '2024-02-29' })
  })

  it('names the edge attribute type and one accepted value when a value is refused', () => {
    const refused = refusal(() => validatedEdgeData({ role: 'Chief Executive' }, worksAt))
    expect(refused.code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(refused.details).toEqual({
      issues: [{ path: '/data/role', message: 'Invalid link data', type: 'select', expected: 'founder' }],
    })
    expect(JSON.stringify(refused.details)).not.toContain('Chief')
    expect(refusal(() => validatedEdgeData({ since: '29/02/2024', role: 'founder' }, worksAt)).details).toEqual({
      issues: [{ path: '/data/since', message: 'Invalid link data', type: 'date', expected: '2026-01-15' }],
    })
    expect(refusal(() => validatedEdgeData({ since: '2024-02-29' }, worksAt)).details).toEqual({
      issues: [{ path: '/data/role', message: 'Invalid link data', type: 'select', expected: 'founder' }],
    })
  })

  it('keeps structural refusals free of type hints', () => {
    expect(refusal(() => validatedEdgeData({ role: 'founder', tenure: 3 }, worksAt)).details).toEqual({
      issues: [{ path: '/data/tenure', message: 'Unknown edge attribute' }],
    })
    expect(refusal(() => validatedEdgeData({ x: 1 }, relation([{ slug: 'x', type: 'no_such_type' }]))).details)
      .toEqual({ issues: [{ path: '/data/x', message: 'Invalid link data' }] })
    expect(refusal(() => validatedEdgeData({}, relation({ not: 'an array' }))).code).toBe(ErrorCode.SCHEMA_CONFLICT)
  })
})
