import { eraseRecord, executeMerge, loadSchema, suppressionHash } from '@deepcrm/schema-engine'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { getContactPoints, setContactPoint } from '../../src/services/contact-points.js'
import { checkPolicy } from '../../src/services/policy.js'
import { submitIntake } from '../../src/services/intake.js'
import { createRecord, updateRecord } from '../../src/services/records.js'
import { withFirstSource } from '../../src/services/record-source.js'
import { intakeFixture } from './intake-fixture.js'

// Postgres-backed writes on a shared, loaded host take seconds each.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const { db, deps, subject, person, tenant, caught, submission, cleanup, personData } = intakeFixture()

afterAll(cleanup)

const A = '+442071838750'
const B = '+16502530000'
const C = '+33142685300'

function phones(read: Awaited<ReturnType<typeof getContactPoints>>) {
  const attribute = read.attributes.find((item) => item.slug === 'phones')
  if (attribute === undefined) throw new Error('expected phones')
  return attribute
}

describe('contact points', () => {
  it('records where each email and phone came from and keeps an intake addition unconfirmed', async () => {
    const target = await tenant()
    const created = await submitIntake(deps, subject(target), submission({
      email: 'ada@example.com', phone: A, data: { name: { full: 'Ada Lovelace' } },
    }))
    const id = created.record_id ?? ''
    await submitIntake(deps, subject(target), submission({
      source: { kind: 'website_chat', id: 'chat_works', name: 'nessie.works chat' }, email: 'ada@example.com', phone: B,
    }))
    const read = await getContactPoints(deps, person(target), { record_id: id })
    expect(read.record).toMatchObject({ id, object_type: 'person', display_name: 'Ada Lovelace' })
    expect(read.redacted_attributes).toEqual([])
    const subjectActor = { type: 'system', id: 'subject:nessie' }
    expect(phones(read)).toEqual({
      slug: 'phones', name: 'Phones', type: 'phone', is_multi: true, archived: [],
      values: [
        { value: A, confirmed: false, reached: null, archived: null, added: {
          at: expect.any(String), by: subjectActor,
          source: { kind: 'contact_form', id: 'form_spring', name: 'Spring newsletter form' },
        } },
        { value: B, confirmed: false, reached: null, archived: null, added: {
          at: expect.any(String), by: subjectActor, source: { kind: 'website_chat', id: 'chat_works', name: 'nessie.works chat' },
        } },
      ],
    })
    expect(read.attributes.find((item) => item.slug === 'emails')?.values).toEqual([expect.objectContaining({
      value: 'ada@example.com', confirmed: false,
    })])
  })

  it('records a colleague\'s additions as confirmed, with an import\'s source, and forgets a removed value', async () => {
    const target = await tenant()
    const source = { kind: 'import' as const, id: 'import_1', name: 'October contacts.csv' }
    const data = await withFirstSource(deps, person(target), 'person', { name: { full: 'Imported' }, phones: [A] }, source)
    const created = await createRecord(deps, person(target), { objectType: 'person', data })
    const id = created.record.id
    await updateRecord(deps, person(target), { recordId: id, data: { phones: [A, B] } })
    let read = phones(await getContactPoints(deps, person(target), { record_id: id }))
    expect(read.values).toEqual([
      expect.objectContaining({ value: A, confirmed: true, added: expect.objectContaining({ by: { type: 'human', id: 'uoa_admin' }, source }) }),
      expect.objectContaining({ value: B, confirmed: true, added: expect.objectContaining({ source: null }) }),
    ])
    await updateRecord(deps, person(target), { recordId: id, data: { phones: [B] } })
    read = phones(await getContactPoints(deps, person(target), { record_id: id }))
    expect(read.values.map((value) => value.value)).toEqual([B])
    expect(read.archived).toEqual([])
    expect(await db.recordContactPoint.count({ where: { ...target, recordId: id } })).toBe(1)
  })

  it('marks a number reached with a note, undoes it, and keeps a value as additional', async () => {
    const target = await tenant()
    const created = await submitIntake(deps, subject(target), submission({ phone: A, data: { name: { full: 'Ada' } } }))
    const id = created.record_id ?? ''
    const member = person(target, 'member', 'uoa_member')
    const before = await db.record.findFirstOrThrow({ where: { ...target, id }, select: { version: true } })
    const reached = await setContactPoint(deps, member, {
      record_id: id, attribute: 'phones', value: '+44 20 7183 8750', action: 'reach', note: 'Called, booked a demo',
    })
    expect(reached).toMatchObject({ record_id: id, version: before.version + 1 })
    expect(reached.attribute.values).toEqual([expect.objectContaining({
      value: A, confirmed: true, reached: { at: expect.any(String), by: { type: 'human', id: 'uoa_member' }, note: 'Called, booked a demo' },
    })])
    const change = await db.recordChange.findFirstOrThrow({
      where: { ...target, recordId: id, attributeSlug: null, kind: 'set', actorId: 'uoa_member' },
    })
    expect(change.newValue).toMatchObject({ system: 'contact_point', value: { attribute: 'phones', note: 'Called, booked a demo' } })
    expect(JSON.stringify(change.newValue)).not.toContain(A)
    const undone = await setContactPoint(deps, member, { record_id: id, attribute: 'phones', value: A, action: 'unreach' })
    expect(undone.attribute.values).toEqual([expect.objectContaining({ value: A, confirmed: true, reached: null })])
    await expect(caught(setContactPoint(deps, member, {
      record_id: id, attribute: 'phones', value: A, action: 'confirm', note: 'x',
    }))).resolves.toMatchObject({ code: 'VALIDATION_FAILED' })
    const again = await setContactPoint(deps, member, { record_id: id, attribute: 'phones', value: A, action: 'confirm' })
    expect(again.version).toBe(undone.version)
    expect(await db.auditLog.count({ where: { ...target, action: 'crm_contact_point_set' } })).toBe(2)
    await expect(caught(setContactPoint(deps, member, { record_id: id, attribute: 'phones', value: B, action: 'reach' })))
      .resolves.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('lets any team member replace every other number at once, keep them archived and restore one', async () => {
    const target = await tenant()
    const created = await createRecord(deps, person(target), {
      objectType: 'person', data: { name: { full: 'Ada' }, phones: [A, B, C] },
    })
    const id = created.record.id
    // phones is confidential: a member may not edit it, yet may replace and restore its values.
    const member = person(target, 'member', 'uoa_member')
    const replaced = await setContactPoint(deps, member, { record_id: id, attribute: 'phones', value: B, action: 'replace_others' })
    expect(replaced.attribute.values.map((value) => value.value)).toEqual([B])
    expect(replaced.attribute.archived.map((value) => value.value).sort()).toEqual([A, C].sort())
    expect(replaced.attribute.archived[0]).toMatchObject({ archived: { at: expect.any(String), by: { type: 'human', id: 'uoa_member' } } })
    expect(await personData(target, id)).toMatchObject({ phones: [B] })
    const restored = await setContactPoint(deps, member, { record_id: id, attribute: 'phones', value: A, action: 'restore' })
    expect(restored.attribute.values.map((value) => value.value)).toEqual([B, A])
    expect(restored.attribute.archived.map((value) => value.value)).toEqual([C])
    expect(await personData(target, id)).toMatchObject({ phones: [B, A] })
    const written = await db.recordChange.findMany({
      where: { ...target, recordId: id, attributeSlug: 'phones', actorId: 'uoa_member' }, select: { onBehalfOf: true },
    })
    expect(written).toEqual([{ onBehalfOf: 'uoa_member' }, { onBehalfOf: 'uoa_member' }])
    await expect(caught(setContactPoint(deps, member, { record_id: id, attribute: 'phones', value: A, action: 'restore' })))
      .resolves.toMatchObject({ code: 'NOT_FOUND' })
    // An admin keeps every action too.
    await expect(setContactPoint(deps, person(target), { record_id: id, attribute: 'phones', value: C, action: 'restore' }))
      .resolves.toMatchObject({ attribute: { values: [expect.objectContaining({ value: B }), expect.objectContaining({ value: A }),
        expect.objectContaining({ value: C })] } })
  })

  it('still refuses a member every other edit of a confidential attribute', async () => {
    const target = await tenant()
    const member = person(target, 'member', 'uoa_member')
    const ada = await createRecord(deps, person(target), {
      objectType: 'person', data: { name: { full: 'Ada' }, phones: [A, B] },
    })
    const company = await createRecord(deps, person(target), {
      objectType: 'company', data: { name: 'Analytical Engines', annual_revenue: { amount: '1000', currency: 'GBP' } },
    })
    await expect(caught(updateRecord(deps, member, { recordId: ada.record.id, data: { phones: [C] } })))
      .resolves.toMatchObject({ code: 'POLICY_DENIED', details: { resource: 'attribute', action: 'edit' } })
    await expect(caught(updateRecord(deps, member, {
      recordId: company.record.id, data: { annual_revenue: { amount: '9', currency: 'GBP' } },
    }))).resolves.toMatchObject({ code: 'POLICY_DENIED', details: { resource: 'attribute', action: 'edit' } })
    // The contact-point permission reaches emails and phones only.
    await expect(caught(setContactPoint(deps, member, {
      record_id: company.record.id, attribute: 'annual_revenue', value: '9', action: 'restore',
    }))).resolves.toMatchObject({ code: 'VALIDATION_FAILED' })
    const policy = { scopes: [{ scope: 'team' as const, id: target.teamId }] }
    await expect(checkPolicy(db, member, { ...policy, resourceType: 'attribute', action: 'edit', sensitivity: 'confidential' }))
      .resolves.toEqual({ allowed: false, requiresApproval: false })
    await expect(checkPolicy(db, member, { ...policy, resourceType: 'attribute', action: 'view', sensitivity: 'restricted' }))
      .resolves.toEqual({ allowed: false, requiresApproval: false })
    await expect(checkPolicy(db, member, { ...policy, resourceType: 'contact_point', action: 'edit', sensitivity: 'confidential' }))
      .resolves.toEqual({ allowed: true, requiresApproval: false })
    expect(await personData(target, ada.record.id)).toMatchObject({ phones: [A, B] })
    expect(await personData(target, company.record.id)).toMatchObject({ annual_revenue: { amount: '1000', currency: 'GBP' } })
  })

  it('matches an archived number to its person but never pairs on it alone, nor writes it back', async () => {
    const target = await tenant()
    const created = await createRecord(deps, person(target), {
      objectType: 'person', data: { name: { full: 'Ada' }, emails: ['ada@example.com'], phones: [A, B] },
    })
    const id = created.record.id
    await setContactPoint(deps, person(target), { record_id: id, attribute: 'phones', value: B, action: 'replace_others' })
    await expect(submitIntake(deps, subject(target), submission({ phone: A })))
      .resolves.toEqual({ outcome: 'pending', record_id: null })
    const match = await db.recordProposal.findFirstOrThrow({ where: { ...target, kind: 'match' } })
    expect(match.candidates).toEqual([{ record_id: id, matched_on: ['archived_phone'] }])
    await expect(submitIntake(deps, subject(target), submission({ email: 'ada@example.com', phone: A })))
      .resolves.toEqual({ outcome: 'paired', record_id: id })
    expect(await personData(target, id)).toMatchObject({ phones: [B] })
  })

  it('reads a merged-in record\'s points on the survivor and erases archived values with suppression', async () => {
    const target = await tenant()
    const survivor = await submitIntake(deps, subject(target), submission({ phone: A, data: { name: { full: 'Ada' } } }))
    const loser = await submitIntake(deps, subject(target), submission({
      source: { kind: 'website_chat', id: 'chat_works', name: 'nessie.works chat' }, phone: B, data: { name: { full: 'Ada L' } },
    }))
    const schema = await loadSchema(db, target)
    await db.$transaction((tx) => executeMerge(tx, person(target), schema, {
      survivorId: survivor.record_id ?? '', mergedIds: [loser.record_id ?? ''], reason: 'same person',
    }))
    const read = phones(await getContactPoints(deps, person(target), { record_id: survivor.record_id ?? '' }))
    expect(read.values).toEqual([
      expect.objectContaining({ value: A }),
      expect.objectContaining({ value: B, added: expect.objectContaining({ source: expect.objectContaining({ id: 'chat_works' }) }) }),
    ])
    await setContactPoint(deps, person(target), { record_id: survivor.record_id ?? '', attribute: 'phones', value: A, action: 'replace_others' })
    const fresh = await loadSchema(db, target)
    await db.$transaction((tx) => eraseRecord(tx, person(target), fresh, { id: survivor.record_id ?? '', reason: 'gdpr_request', suppress: true }))
    expect(await db.recordContactPoint.count({ where: { ...target, recordId: survivor.record_id ?? '' } })).toBe(0)
    const suppressed = await db.suppressionEntry.findMany({ where: { ...target, kind: 'phone' }, select: { keyHash: true } })
    expect(suppressed.map((row) => row.keyHash)).toContain(suppressionHash('phone', B))
  })
})
