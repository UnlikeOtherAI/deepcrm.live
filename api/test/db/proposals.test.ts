import { afterAll, describe, expect, it, vi } from 'vitest'

import { submitIntake } from '../../src/services/intake.js'
import { decideProposal } from '../../src/services/proposal-decide.js'
import { listProposals } from '../../src/services/proposals.js'
import { createRecord } from '../../src/services/records.js'
import { withFirstSource } from '../../src/services/record-source.js'
import { intakeFixture } from './intake-fixture.js'

// Postgres-backed writes on a shared, loaded host take seconds each.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const { db, deps, subject, person, tenant, caught, submission, cleanup, personData, activitiesAbout } = intakeFixture()

afterAll(cleanup)

const list = { limit: 50 } as const

async function amended(target: Awaited<ReturnType<typeof tenant>>) {
  const created = await submitIntake(deps, subject(target), submission({
    email: 'ada@example.com', data: { name: { full: 'Ada Lovelace' } },
  }))
  await submitIntake(deps, subject(target), submission({
    source: { kind: 'website_chat', id: 'chat_works', name: 'nessie.works chat' },
    email: 'ada@example.com', data: { name: { full: 'Augusta Ada King' } },
  }))
  return created.record_id ?? ''
}

describe('record proposals', () => {
  it('lists an amendment as a row a person can act on and approves it as that person', async () => {
    const target = await tenant()
    const id = await amended(target)
    const { proposals, next_cursor: next } = await listProposals(deps, person(target), { ...list, status: 'pending' })
    expect(next).toBeNull()
    expect(proposals).toEqual([expect.objectContaining({
      kind: 'amendment', status: 'pending', object_type: 'person',
      source: { kind: 'website_chat', id: 'chat_works', name: 'nessie.works chat' },
      record: { id, object_type: 'person', display_name: 'Ada Lovelace', version: expect.any(Number) },
      attribute: { slug: 'name', name: 'Name', type: 'personal_name', is_multi: false },
      proposed_value: expect.objectContaining({ full: 'Augusta Ada King' }),
      current_value: expect.objectContaining({ full: 'Ada Lovelace' }),
      redacted_attributes: [],
    })])
    const proposal = proposals[0]
    if (proposal?.record === null || proposal === undefined) throw new Error('expected an amendment')
    const version = proposal.record.version
    await expect(caught(decideProposal(deps, person(target), { id: proposal.id, decision: 'approve', expected_version: version + 7 })))
      .resolves.toMatchObject({ code: 'VERSION_CONFLICT' })
    await expect(decideProposal(deps, person(target, 'member', 'uoa_member'), {
      id: proposal.id, decision: 'approve', expected_version: version,
    })).resolves.toEqual({ id: proposal.id, status: 'approved', record_id: id })
    expect(await personData(target, id)).toMatchObject({ name: { full: 'Augusta Ada King' } })
    const change = await db.recordChange.findFirstOrThrow({
      where: { ...target, recordId: id, attributeSlug: 'name', actorType: 'human' },
    })
    expect(change).toMatchObject({
      actorId: 'uoa_member', onBehalfOf: 'uoa_member', reason: 'Submitted through website_chat chat_works "nessie.works chat"',
    })
    const audits = await db.auditLog.findMany({
      where: { ...target, action: { in: ['proposal.approved', 'crm_proposal_decide'] } }, select: { action: true },
    })
    expect(audits.map((row) => row.action).sort()).toEqual(['crm_proposal_decide', 'proposal.approved'])
    await expect(caught(decideProposal(deps, person(target), { id: proposal.id, decision: 'reject' })))
      .resolves.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects an amendment without touching the record, and hides one on a record the reader cannot see', async () => {
    const target = await tenant()
    const id = await amended(target)
    const [proposal] = (await listProposals(deps, person(target), list)).proposals
    await db.record.updateMany({ where: { ...target, id }, data: { visibility: 'private' } })
    const outsider = person(target, 'member', 'uoa_outsider')
    await expect(listProposals(deps, outsider, list)).resolves.toEqual({ proposals: [], next_cursor: null })
    await expect(caught(decideProposal(deps, outsider, { id: proposal?.id ?? '', decision: 'reject' })))
      .resolves.toMatchObject({ code: 'NOT_FOUND' })
    await db.record.updateMany({ where: { ...target, id }, data: { visibility: 'team' } })
    await expect(decideProposal(deps, outsider, { id: proposal?.id ?? '', decision: 'reject' }))
      .resolves.toEqual({ id: proposal?.id, status: 'rejected', record_id: null })
    expect(await personData(target, id)).toMatchObject({ name: { full: 'Ada Lovelace' } })
    await expect(listProposals(deps, outsider, { ...list, status: 'rejected' })).resolves.toMatchObject({
      proposals: [expect.objectContaining({ id: proposal?.id, status: 'rejected' })],
    })
  })

  it('resolves a pending match by pairing it with the person the reader chose', async () => {
    const target = await tenant()
    const a = await submitIntake(deps, subject(target), submission({ email: 'a@example.com', data: { name: { full: 'A' } } }))
    const b = await submitIntake(deps, subject(target), submission({ phone: '+442071838750', data: { name: { full: 'B' } } }))
    await submitIntake(deps, subject(target), submission({
      email: 'a@example.com', phone: '+442071838750', data: { name: { full: 'B Person' }, title: 'Engineer' },
      note: { body: 'Accepted the terms.' },
    }))
    const { proposals } = await listProposals(deps, person(target), { ...list, kind: 'match' })
    expect(proposals).toEqual([expect.objectContaining({
      kind: 'match', record: null, attribute: null,
      candidates: expect.arrayContaining([
        { record: { id: a.record_id, object_type: 'person', display_name: 'A' }, matched_on: ['email'] },
        { record: { id: b.record_id, object_type: 'person', display_name: 'B' }, matched_on: ['phone'] },
      ]),
      submitted: {
        emails: ['a@example.com'], phones: ['+442071838750'],
        name: expect.objectContaining({ full: 'B Person' }), title: 'Engineer',
      },
      activity: { subject: 'Contact form: Spring', occurred_at: '2026-10-19T11:00:00.000Z' },
    })])
    const match = proposals[0]
    if (match === undefined) throw new Error('expected a match')
    // a@example.com is A's: putting it on B too is a unique collision, so nothing is written.
    await expect(caught(decideProposal(deps, person(target), { id: match.id, decision: 'approve', record_id: b.record_id ?? '' })))
      .resolves.toMatchObject({ code: 'DUPLICATE_FOUND' })
    await expect(decideProposal(deps, person(target), { id: match.id, decision: 'approve', record_id: a.record_id ?? '' }))
      .resolves.toEqual({ id: match.id, status: 'approved', record_id: a.record_id })
    expect(await personData(target, a.record_id ?? '')).toMatchObject({
      name: { full: 'A' }, title: 'Engineer', phones: ['+442071838750'], emails: ['a@example.com'],
    })
    const logged = await activitiesAbout(target, a.record_id ?? '')
    expect(logged.map((item) => [item.objectType.slug, item.createdById])).toEqual([
      ['activity', 'subject:nessie'], ['activity', 'uoa_admin'], ['note', 'uoa_admin'],
    ])
    const pending = await db.recordProposal.findMany({ where: { ...target, status: 'pending' } })
    expect(pending.map((row) => [row.kind, row.recordId, row.attributeSlug, row.requesterId]))
      .toEqual([['amendment', a.record_id, 'name', 'subject:nessie']])
  })

  it('resolves a pending match by creating the person', async () => {
    const target = await tenant()
    for (const name of ['One', 'Two']) {
      await createRecord(deps, person(target), {
        objectType: 'person', data: { name: { full: name }, phones: ['+442071838750'] },
      })
    }
    await expect(submitIntake(deps, subject(target), submission({
      email: 'new@example.com', phone: '+442071838750', data: { name: { full: 'Three' } },
    }))).resolves.toEqual({ outcome: 'pending', record_id: null })
    const [match] = (await listProposals(deps, person(target), list)).proposals
    const decided = await decideProposal(deps, person(target), { id: match?.id ?? '', decision: 'approve' })
    expect(decided).toMatchObject({ status: 'approved', record_id: expect.any(String) })
    expect(await personData(target, decided.record_id ?? '')).toMatchObject({
      name: { full: 'Three' }, emails: ['new@example.com'], phones: ['+442071838750'],
      first_source_kind: 'contact_form', first_source_id: 'form_spring',
    })
  })

  it('records the first source on a person a colleague creates with a named source', async () => {
    const target = await tenant()
    const source = { kind: 'import' as const, id: 'import_2026_10', name: 'October contacts.csv' }
    const data = await withFirstSource(deps, person(target), 'person', { name: { full: 'Imported' } }, source)
    const created = await createRecord(deps, person(target), { objectType: 'person', data })
    expect(await personData(target, created.record.id)).toMatchObject({
      first_source_kind: 'import', first_source_id: 'import_2026_10', first_source_name: 'October contacts.csv',
    })
    await expect(caught(withFirstSource(deps, person(target), 'person', { first_source_name: 'Forged' }, source)))
      .resolves.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})
