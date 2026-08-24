import { describe, expect, it } from 'vitest'

import {
  CrmListAdd,
  CrmListCreate,
  CrmViewRun,
  CrmViewSave,
  CrmViewSaveToolInput,
} from './tools-lists.js'

describe('list and view tool contracts', () => {
  it('accepts typed list attributes and entry data', () => {
    const list = CrmListCreate.in.parse({
      slug: 'q4_targets',
      name: 'Q4 targets',
      object_type: 'company',
      attributes: [{
        slug: 'priority',
        name: 'Priority',
        description: 'Outreach priority',
        type: 'select',
        config: {
          options: [{ id: 'high', label: 'High' }, { id: 'low', label: 'Low' }],
        },
      }],
    })
    expect(list.attributes?.[0]?.slug).toBe('priority')
    expect(CrmListAdd.in.parse({
      list: 'q4_targets',
      entries: [{
        record_id: '00000000-0000-4000-8000-000000000001',
        data: { priority: 'high' },
      }],
    }).entries).toHaveLength(1)
  })

  it('pins stored and MCP-safe saved-view inputs', () => {
    const filter = { attribute: 'stage', op: 'eq', value: 'proposal' }
    expect(CrmViewSave.in.parse({
      slug: 'open_pipeline',
      name: 'Open pipeline',
      object_type: 'deal',
      filter,
    }).filter).toEqual(filter)
    expect(CrmViewSaveToolInput.parse({
      slug: 'open_pipeline',
      name: 'Open pipeline',
      object_type: 'deal',
      filter,
    }).filter).toEqual(filter)
    expect(CrmViewRun.in.parse({ view: 'open_pipeline' }).limit).toBe(50)
  })
})
