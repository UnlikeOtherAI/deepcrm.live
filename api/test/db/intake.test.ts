import { CrmIntakeSubmit } from '@deepcrm/schemas'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { getConsent, setConsent } from '../../src/services/consent.js'
import { submitIntake } from '../../src/services/intake.js'
import { intakeFixture } from './intake-fixture.js'

// Postgres-backed writes on a shared, loaded host take seconds each.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const { db, deps, subject, person, tenant, caught, submission, cleanup, personData, activitiesAbout } = intakeFixture()

afterAll(cleanup)

const ada = { email: 'Ada@Example.com', phone: '+44 20 7183 8750', data: { name: { full: 'Ada Lovelace' } } }

describe('crm_intake_submit', () => {
  it('creates a person from every submitted value, with its first source, activity and note', async () => {
    const target = await tenant()
    const result = await submitIntake(deps, subject(target), submission({
      ...ada, data: { name: { full: 'Ada Lovelace' }, title: 'Countess', source: '' },
      note: { title: 'Terms accepted', body: 'Accepted the terms.' },
    }))
    expect(result).toEqual({ outcome: 'created', record_id: expect.any(String) })
    const id = result.record_id ?? ''
    expect(await personData(target, id)).toMatchObject({
      name: { full: 'Ada Lovelace' }, emails: ['ada@example.com'], phones: ['+442071838750'], title: 'Countess',
      first_source_kind: 'contact_form', first_source_id: 'form_spring', first_source_name: 'Spring newsletter form',
    })
    const row = await db.record.findFirstOrThrow({ where: { ...target, id } })
    expect({ origin: row.origin, by: row.createdById }).toEqual({ origin: 'subject:nessie', by: 'subject:nessie' })
    const logged = await activitiesAbout(target, id)
    expect(logged.map((item) => item.objectType.slug)).toEqual(['activity', 'note'])
    expect(logged[0]?.data).toMatchObject({
      kind: 'message', direction: 'inbound', subject: 'Contact form: Spring',
      source_kind: 'contact_form', source_id: 'form_spring', source_name: 'Spring newsletter form',
    })
    expect(logged.every((item) => item.createdById === 'subject:nessie')).toBe(true)
    const changes = await db.recordChange.findMany({ where: { ...target, recordId: id }, select: { reason: true } })
    expect(new Set(changes.map((change) => change.reason))).toEqual(new Set([
      'Submitted through contact_form form_spring "Spring newsletter form"',
    ]))
    const audit = await db.auditLog.findFirstOrThrow({ where: { ...target, action: 'crm_intake_submit' } })
    expect(audit).toMatchObject({ actorId: 'subject:nessie', onBehalfOf: null, resourceId: id })
    expect(audit.metadata).toMatchObject({
      outcome: 'created', source: { kind: 'contact_form', id: 'form_spring', name: 'Spring newsletter form' },
    })
  })

  it('pairs on a 100% match: fills empty fields, adds a new phone beside, holds a real change', async () => {
    const target = await tenant()
    const first = await submitIntake(deps, subject(target), submission({
      email: 'ada@example.com', phone: '+442071838750', data: { name: { full: 'Ada Lovelace' } },
    }))
    const id = first.record_id ?? ''
    const later = submission({
      source: { kind: 'website_chat', id: 'chat_works', name: 'nessie.works chat' },
      email: 'ADA@example.com', phone: '+16502530000',
      data: { name: { full: 'Augusta Ada King' }, title: 'Countess of Lovelace' },
    })
    await expect(submitIntake(deps, subject(target), later)).resolves.toEqual({ outcome: 'paired', record_id: id })
    expect(await personData(target, id)).toMatchObject({
      name: { full: 'Ada Lovelace' }, title: 'Countess of Lovelace', phones: ['+442071838750', '+16502530000'],
      first_source_kind: 'contact_form', first_source_name: 'Spring newsletter form',
    })
    const pending = await db.recordProposal.findMany({ where: { ...target, status: 'pending' } })
    expect(pending.map((row) => ({ kind: row.kind, slug: row.attributeSlug, record: row.recordId, source: row.sourceId })))
      .toEqual([{ kind: 'amendment', slug: 'name', record: id, source: 'chat_works' }])
    const fill = await db.recordChange.findFirstOrThrow({ where: { ...target, recordId: id, attributeSlug: 'title' } })
    expect(fill).toMatchObject({
      actorType: 'system', actorId: 'subject:nessie', reason: 'Submitted through website_chat chat_works "nessie.works chat"',
    })
    const sources = (await activitiesAbout(target, id)).map((item) => (item.data as { source_id?: string }).source_id)
    expect(sources).toEqual(['form_spring', 'chat_works'])
    // The same submission again changes nothing and proposes nothing new.
    await submitIntake(deps, subject(target), later)
    expect(await db.recordProposal.count({ where: { ...target, status: 'pending' } })).toBe(1)
  })

  it('pairs on a phone alone and treats a formatting difference as no change', async () => {
    const target = await tenant()
    const first = await submitIntake(deps, subject(target), submission({ phone: '+442071838750', data: ada.data }))
    const id = first.record_id ?? ''
    await expect(submitIntake(deps, subject(target), submission({
      phone: '+44 20 7183 8750', data: { name: { full: '  ada   LOVELACE ' }, title: '' },
    }))).resolves.toEqual({ outcome: 'paired', record_id: id })
    expect(await db.recordProposal.count({ where: target })).toBe(0)
    expect(await personData(target, id)).not.toHaveProperty('title')
  })

  it('holds an ambiguous submission as a pending match and pairs nothing', async () => {
    const target = await tenant()
    const a = await submitIntake(deps, subject(target), submission({ email: 'a@example.com', data: { name: { full: 'A' } } }))
    const b = await submitIntake(deps, subject(target), submission({ phone: '+442071838750', data: { name: { full: 'B' } } }))
    const before = await db.record.count({ where: target })
    const pending = await submitIntake(deps, subject(target), submission({
      email: 'a@example.com', phone: '+442071838750', data: { name: { full: 'Who' }, title: 'Engineer' },
      consent: { state: 'declined', source: 'contact_form' },
    }))
    expect(pending).toEqual({ outcome: 'pending', record_id: null })
    expect(await db.record.count({ where: target })).toBe(before)
    const match = await db.recordProposal.findFirstOrThrow({ where: { ...target, kind: 'match' } })
    expect(match.candidates).toEqual([
      { record_id: a.record_id, matched_on: ['email'] }, { record_id: b.record_id, matched_on: ['phone'] },
    ].sort((left, right) => (left.record_id ?? '').localeCompare(right.record_id ?? '')))
    expect(await personData(target, b.record_id ?? '')).not.toHaveProperty('title')
    // The consent act is still the subject's own, on the person who holds the email.
    await expect(getConsent(deps, person(target), { email: 'a@example.com' })).resolves.toMatchObject({
      record_id: a.record_id, state: 'declined', suppressed: true,
    })
  })

  it('writes consent only on a person who held the email before the submission', async () => {
    const target = await tenant()
    const phoneOnly = await submitIntake(deps, subject(target), submission({ phone: '+442071838750', data: ada.data }))
    const id = phoneOnly.record_id ?? ''
    await expect(submitIntake(deps, subject(target), submission({
      email: 'new@example.com', phone: '+442071838750', consent: { state: 'confirmed', source: 'signup_form' },
    }))).resolves.toEqual({ outcome: 'paired', record_id: id })
    const data = await personData(target, id)
    expect(data).toMatchObject({ emails: ['new@example.com'] })
    expect(data['marketing_consent_source']).toBeUndefined()
    // The confirmation link, a later act for the address now on the record, lands.
    await setConsent(deps, subject(target), {
      email: 'new@example.com', state: 'confirmed', source: 'signup_form', at: '2026-10-19T11:30:00Z',
    })
    await expect(getConsent(deps, person(target), { email: 'new@example.com' }))
      .resolves.toMatchObject({ record_id: id, state: 'confirmed' })
  })

  it('creates with consent and replays an idempotent submission', async () => {
    const target = await tenant()
    const input = submission({ ...ada, consent: { state: 'not_confirmed', source: 'signup_form' }, idempotency_key: 'intake-0001' })
    const first = await submitIntake(deps, subject(target), input)
    await expect(submitIntake(deps, subject(target), input)).resolves.toEqual(first)
    await expect(caught(submitIntake(deps, subject(target), { ...input, phone: '+16502530000' })))
      .resolves.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
    expect(await personData(target, first.record_id ?? '')).toMatchObject({
      marketing_consent: 'not_confirmed', marketing_consent_source: 'signup_form',
    })
    expect(await db.auditLog.count({ where: { ...target, action: 'crm_intake_submit' } })).toBe(1)
  })

  it('refuses a person or agent, a missing identifier and fields a form may not set', async () => {
    const target = await tenant()
    await expect(caught(submitIntake(deps, person(target), submission(ada))))
      .resolves.toMatchObject({ code: 'POLICY_DENIED' })
    for (const input of [
      { data: { name: { full: 'Nobody' } } },
      { email: 'x@example.com', data: { emails: ['y@example.com'] } },
      { email: 'x@example.com', data: { first_source_name: 'Forged' } },
      { email: 'x@example.com', data: { company: '00000000-0000-4000-8000-000000000000' } },
      { phone: '+44 20 7183 8750', consent: { state: 'confirmed', source: 'signup_form' } },
      { email: 'not an email' },
    ]) {
      await expect(caught(submitIntake(deps, subject(target), submission(input))), JSON.stringify(input))
        .resolves.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    expect(await db.record.count({ where: target })).toBe(0)
  })

  it('refuses a source name that is empty, too long or holds control characters', () => {
    const base = { activity: { kind: 'message', occurred_at: '2026-10-19T11:00:00Z', subject: 'x' }, email: 'a@b.co' }
    const named = (name: string) => CrmIntakeSubmit.in.safeParse({ ...base, source: { kind: 'contact_form', id: 'f1', name } })
    expect(named('  Spring form  ').success && named('  Spring form  ').data?.source.name).toBe('Spring form')
    expect(named('x'.repeat(120)).success).toBe(true)
    for (const bad of ['', '   ', 'x'.repeat(121), 'Spring\nform', 'Spring\u0007', 'Spring‮form', 'a b']) {
      expect(named(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(CrmIntakeSubmit.in.safeParse({ ...base, source: { kind: 'import', id: 'f1', name: 'List' } }).success).toBe(false)
    expect(CrmIntakeSubmit.in.safeParse({ ...base, source: { kind: 'contact_form', id: 'has space', name: 'n' } }).success)
      .toBe(false)
  })

  it('defines the source attributes on an older tenant, once', async () => {
    const target = await tenant()
    await db.attribute.deleteMany({
      where: { ...target, slug: { in: ['first_source_kind', 'first_source_id', 'first_source_name', 'source_kind', 'source_id', 'source_name'] } },
    })
    await db.team.updateMany({ where: { id: target.teamId }, data: { schemaVersion: { increment: 1 } } })
    await submitIntake(deps, subject(target), submission(ada))
    const defined = await db.attribute.findMany({
      where: { ...target, slug: { contains: 'source_' }, isSystem: true }, select: { slug: true }, orderBy: { slug: 'asc' },
    })
    expect(defined.map((item) => item.slug)).toEqual([
      'first_source_id', 'first_source_kind', 'first_source_name', 'source_id', 'source_kind', 'source_name',
    ])
    await submitIntake(deps, subject(target), submission({ ...ada, email: 'other@example.com', phone: undefined }))
    expect(await db.auditLog.count({ where: { ...target, action: 'schema.source_attributes.ensure' } })).toBe(2)
  })

  it('refuses a same-slug attribute that cannot hold the source, and leaves consent writes alone', async () => {
    const target = await tenant()
    await db.attribute.updateMany({ where: { ...target, slug: 'first_source_name' }, data: { type: 'number', config: {} } })
    await db.team.updateMany({ where: { id: target.teamId }, data: { schemaVersion: { increment: 1 } } })
    await expect(caught(submitIntake(deps, subject(target), submission(ada))))
      .resolves.toMatchObject({ code: 'SCHEMA_CONFLICT', details: { detail: 'first_source_name_type' } })
    await expect(setConsent(deps, subject(target), { email: 'ada@example.com', state: 'declined', source: 'unsubscribe' }))
      .resolves.toMatchObject({ suppressed: true })
    await db.attribute.updateMany({
      where: { ...target, slug: 'first_source_name' }, data: { type: 'text', config: { type: 'text', maxLength: 40 } },
    })
    await db.team.updateMany({ where: { id: target.teamId }, data: { schemaVersion: { increment: 1 } } })
    await expect(caught(submitIntake(deps, subject(target), submission(ada))))
      .resolves.toMatchObject({ code: 'SCHEMA_CONFLICT', details: { detail: 'first_source_name_length' } })
  })
})
