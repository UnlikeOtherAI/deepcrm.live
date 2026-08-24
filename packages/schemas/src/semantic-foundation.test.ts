import { describe, expect, it } from 'vitest'

import {
  AttributeDerivationDetail,
  DynamicListDefinitionState,
  EventDetail,
  FileLinkDetail,
  PipelineDetail,
  RelationEdgeLimit,
} from './semantic-foundation.js'

describe('semantic foundation contracts', () => {
  it('describe every object field exposed to discovery resources', () => {
    for (const schema of [
      AttributeDerivationDetail,
      DynamicListDefinitionState,
      EventDetail,
      FileLinkDetail,
      PipelineDetail,
      RelationEdgeLimit,
    ]) {
      for (const value of Object.values(schema.shape)) {
        expect(value.description).toBeTruthy()
      }
    }
  })

  it('parses representative generic semantic metadata', () => {
    expect(RelationEdgeLimit.parse({
      max_active_edges_from: 1,
      max_active_edges_to: null,
      label_limits: { primary: { max_active_edges_to: 1 } },
    })).toMatchObject({ max_active_edges_from: 1 })
    expect(DynamicListDefinitionState.parse({
      list: 'open_companies',
      object_type: 'company',
      filter: { op: 'eq', attribute: 'lifecycle', value: 'customer' },
      evaluation_version: 2,
      refresh_state: 'ready',
      refresh_error_code: null,
      last_evaluated_at: null,
    })).toMatchObject({ list: 'open_companies' })
  })
})
