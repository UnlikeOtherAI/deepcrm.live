import { describe, expect, it } from 'vitest'

import { systemAttributeConflict, templateAttributeSpecs } from '../src/schema/system-attributes.js'
import standardCrm from '../src/templates/standard_crm.json' with { type: 'json' }

const [kind, , name] = templateAttributeSpecs(standardCrm, 'person', [
  'first_source_kind', 'first_source_id', 'first_source_name',
])

const compatibleName = {
  type: 'text', config: { type: 'text', maxLength: 200 }, isMulti: false, isUnique: false,
  valueSource: 'stored', archivedAt: null,
}

describe('system attribute compatibility', () => {
  it('adopts a same-slug attribute that can hold the values', () => {
    if (name === undefined || kind === undefined) throw new Error('standard_crm lacks the first-source attributes')
    expect(systemAttributeConflict(compatibleName, name)).toBeNull()
    expect(systemAttributeConflict({ ...compatibleName, config: {} }, name)).toBeNull()
    expect(systemAttributeConflict({
      ...compatibleName, type: 'select', config: { type: 'select', options: [
        { id: 'contact_form' }, { id: 'signup_form' }, { id: 'website_chat' }, { id: 'import' }, { id: 'event' },
      ] },
    }, kind)).toBeNull()
  })

  it('names why a same-slug attribute cannot hold them', () => {
    if (name === undefined || kind === undefined) throw new Error('standard_crm lacks the first-source attributes')
    expect(systemAttributeConflict({ ...compatibleName, archivedAt: new Date() }, name)).toBe('first_source_name_archived')
    expect(systemAttributeConflict({ ...compatibleName, type: 'number' }, name)).toBe('first_source_name_type')
    expect(systemAttributeConflict({ ...compatibleName, isMulti: true }, name)).toBe('first_source_name_type')
    expect(systemAttributeConflict({ ...compatibleName, valueSource: 'formula' }, name)).toBe('first_source_name_type')
    expect(systemAttributeConflict({ ...compatibleName, isUnique: true }, name)).toBe('first_source_name_unique')
    expect(systemAttributeConflict({ ...compatibleName, config: { type: 'text', maxLength: 119 } }, name))
      .toBe('first_source_name_length')
    expect(systemAttributeConflict({
      ...compatibleName, type: 'select', config: { type: 'select', options: [{ id: 'contact_form' }] },
    }, kind)).toBe('first_source_kind_options')
  })
})
