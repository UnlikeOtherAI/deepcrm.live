import { eraseRecord, loadSchema } from '@deepcrm/schema-engine'
import type { ProposalStatus } from '@deepcrm/db'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { submitIntake } from '../../src/services/intake.js'
import { decideProposal } from '../../src/services/proposal-decide.js'
import { listProposals } from '../../src/services/proposals.js'
import { PENDING_PER_QUEUE, PENDING_PER_TEAM } from '../../src/services/proposal-store.js'
import { createRecord } from '../../src/services/records.js'
import { intakeFixture } from './intake-fixture.js'

// The bounded proposal queues (schema-engine §4d″): a submission is never
// refused because of other pending proposals; identical ones collapse, and
// past a window the oldest pending proposals are superseded, never dropped.

// Postgres-backed writes on a shared, loaded host take seconds each.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 })

const { db, deps, subject, person, tenant, caught, submission, cleanup, personData } = intakeFixture()

afterAll(cleanup)

type Tenant = Awaited<ReturnType<typeof tenant>>

// PR #5 refused a submission once a record held 25 pending proposals.
const OLD_RECORD_CAP = 25
const flood = { kind: 'contact_form' as const, id: 'form_flood', name: 'Flooded form' }
const chat = { kind: 'website_chat' as const, id: 'chat_works', name: 'nessie.works chat' }

async function ada(target: Tenant): Promise<string> {
  const created = await submitIntake(deps, subject(target), submission({
    email: 'ada@example.com', data: { name: { full: 'Ada Lovelace' }, title: 'Countess' },
  }))
  return created.record_id ?? ''
}

async function proposeTitle(target: Tenant, title: string, source?: typeof flood | typeof chat) {
  return submitIntake(deps, subject(target), submission({
    ...(source === undefined ? {} : { source }), email: 'ada@example.com', data: { title },
  }))
}

async function titles(target: Tenant, id: string, status: ProposalStatus): Promise<unknown[]> {
  const rows = await db.recordProposal.findMany({
    where: { ...target, recordId: id, attributeSlug: 'title', status }, orderBy: { submittedSeq: 'asc' },
  })
  return rows.map((row) => row.proposed)
}

async function titleRow(target: Tenant, title: string) {
  return db.recordProposal.findFirstOrThrow({ where: { ...target, attributeSlug: 'title', proposed: { equals: title } } })
}

/**
 * Settles a proposal as a decision would, while a submission is already
 * waiting on its row: the row is locked first, the submission is started and
 * left blocked on that lock, then the decision commits.
 */
async function decidedWhileSubmitting(id: string, submit: () => Promise<unknown>): Promise<unknown> {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let taken: () => void = () => {}
  const locked = new Promise<void>((resolve) => { taken = resolve })
  const decision = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM record_proposals WHERE id = ${id}::uuid FOR UPDATE`
    taken()
    await gate
    await tx.$executeRaw`
      UPDATE record_proposals SET status = 'approved', resolved_at = CURRENT_TIMESTAMP WHERE id = ${id}::uuid
    `
  }, { timeout: 60_000 })
  await locked
  const submitted = submit()
  for (let attempt = 0; ; attempt += 1) {
    const waiting = await db.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `
    if ((waiting[0]?.count ?? 0) > 0) break
    if (attempt > 400) throw new Error('the submission never waited on the proposal row')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  release()
  await decision
  return submitted
}

describe('proposal queues', () => {
  it('lets the real submission through a burst over the old caps and keeps the newest pending', async () => {
    const target = await tenant()
    const id = await ada(target)
    const burst = OLD_RECORD_CAP + 5
    for (let index = 0; index < burst; index += 1) {
      await expect(proposeTitle(target, `Flood ${index}`, flood)).resolves.toEqual({ outcome: 'paired', record_id: id })
    }
    const newest = (from: number) => Array.from({ length: burst - from }, (_, offset) => `Flood ${from + offset}`)
    expect(await titles(target, id, 'pending')).toEqual(newest(burst - PENDING_PER_QUEUE))
    expect(await db.recordProposal.count({ where: { ...target, status: 'superseded' } }))
      .toBe(burst - PENDING_PER_QUEUE)

    // Ada's own correction is not refused: it is the newest, so it stays pending.
    await expect(submitIntake(deps, subject(target), submission({
      email: 'ada@example.com', data: { name: { full: 'Augusta Ada King' }, title: 'Engineer' },
    }))).resolves.toEqual({ outcome: 'paired', record_id: id })
    expect(await titles(target, id, 'pending')).toEqual([...newest(burst - PENDING_PER_QUEUE + 1), 'Engineer'])
    const { proposals } = await listProposals(deps, person(target), { limit: 50, status: 'pending', record_id: id })
    expect(proposals).toHaveLength(PENDING_PER_QUEUE + 1)
    expect(proposals).toContainEqual(expect.objectContaining({
      attribute: expect.objectContaining({ slug: 'name' }), proposed_value: expect.objectContaining({ full: 'Augusta Ada King' }),
      source: { kind: 'contact_form', id: 'form_spring', name: 'Spring newsletter form' }, submissions: 1,
    }))

    // A person's own decision and edit go through whatever is pending.
    const engineer = proposals.find((proposal) => proposal.proposed_value === 'Engineer')
    if (engineer?.record === null || engineer === undefined) throw new Error('expected the Engineer amendment')
    await expect(decideProposal(deps, person(target, 'member', 'uoa_member'), {
      id: engineer.id, decision: 'approve', expected_version: engineer.record.version,
    })).resolves.toEqual({ id: engineer.id, status: 'approved', record_id: id })
    expect(await personData(target, id)).toMatchObject({ title: 'Engineer' })

    // Nothing disappeared: each superseded proposal is kept with its state, source and time.
    const superseded = await db.recordProposal.findMany({ where: { ...target, status: 'superseded' } })
    expect(superseded).toHaveLength(burst - PENDING_PER_QUEUE + 1)
    expect(superseded.every((row) => row.sourceId === 'form_flood' && row.resolvedAt !== null
      && row.resolverUoaUserId === null)).toBe(true)
    const audits = await db.auditLog.findMany({ where: { ...target, action: 'crm_intake_submit' }, select: { metadata: true } })
    const counted = audits.reduce((sum, row) => {
      const metadata = row.metadata
      const value = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? metadata['superseded'] : 0
      return sum + (typeof value === 'number' ? value : 0)
    }, 0)
    expect(counted).toBe(burst - PENDING_PER_QUEUE + 1)
  })

  it('supersedes the team\'s oldest pending proposal past the team window instead of refusing', async () => {
    const target = await tenant()
    const id = await ada(target)
    const schema = await loadSchema(db, target)
    const objectTypeId = schema.objectTypesBySlug.get('person')?.id ?? ''
    // A burst spread over a thousand queues, one pending match each: PR #5 refused everything past it.
    await db.recordProposal.createMany({
      data: Array.from({ length: PENDING_PER_TEAM }, (_, index) => ({
        ...target, kind: 'match' as const, objectTypeId, queueKey: `match:burst-${index}`,
        proposed: {
          data: {}, values: {}, note: null,
          activity: { kind: 'message', occurred_at: '2026-10-19T11:00:00.000Z', subject: 'Burst' },
        },
        proposedHash: `burst-${index}`, lastSubmittedAt: deps.clock(), sourceKind: flood.kind, sourceId: flood.id,
        sourceName: flood.name, requesterType: 'system' as const, requesterId: 'subject:nessie', requestId: `burst-${index}`,
      })),
    })
    await expect(proposeTitle(target, 'Engineer')).resolves.toEqual({ outcome: 'paired', record_id: id })
    expect(await db.recordProposal.count({ where: { ...target, status: 'pending' } })).toBe(PENDING_PER_TEAM)
    expect(await titles(target, id, 'pending')).toEqual(['Engineer'])
    const oldest = await db.recordProposal.findFirstOrThrow({ where: { ...target, queueKey: 'match:burst-0' } })
    expect(oldest).toMatchObject({ status: 'superseded', resolvedAt: deps.clock() })
    const next = await db.recordProposal.findFirstOrThrow({ where: { ...target, queueKey: 'match:burst-1' } })
    expect(next.status).toBe('pending')
  })

  it('collapses identical submissions into one proposal with a count and the latest source', async () => {
    const target = await tenant()
    const id = await ada(target)
    await proposeTitle(target, 'Engineer')
    await proposeTitle(target, 'Engineer', chat)
    const listed = (await listProposals(deps, person(target), { limit: 50, record_id: id })).proposals
    expect(listed).toEqual([expect.objectContaining({
      status: 'pending', submissions: 2, source: chat, proposed_value: 'Engineer', current_value: 'Countess',
    })])
    const [collapsed] = listed
    expect(Date.parse(collapsed?.last_submitted_at ?? '')).toBeGreaterThan(Date.parse(collapsed?.created_at ?? ''))

    // Pushed out by five newer titles, then submitted again: the same proposal, pending as the newest.
    for (const title of ['A', 'B', 'C', 'D', 'E']) await proposeTitle(target, title)
    expect(await titleRow(target, 'Engineer')).toMatchObject({ status: 'superseded', submissions: 2 })
    await proposeTitle(target, 'Engineer')
    expect(await titleRow(target, 'Engineer')).toMatchObject({
      status: 'pending', submissions: 3, resolvedAt: null, sourceId: 'form_spring',
    })
    expect(await titles(target, id, 'pending')).toEqual(['B', 'C', 'D', 'E', 'Engineer'])
    expect(await db.recordProposal.count({ where: { ...target, recordId: id } })).toBe(6)

    // A match: the same submission through another source, later, is the same proposal; another message is not.
    for (const name of ['One', 'Two']) {
      await createRecord(deps, person(target), { objectType: 'person', data: { name: { full: name }, phones: ['+442071838750'] } })
    }
    const match = (source: typeof chat | undefined, occurredAt: string, body?: string) => submitIntake(deps, subject(target), submission({
      ...(source === undefined ? {} : { source }), phone: '+44 20 7183 8750', data: { name: { full: 'Three' } },
      activity: { kind: 'message', occurred_at: occurredAt, subject: 'Contact form: Spring', ...(body === undefined ? {} : { body }) },
    }))
    await expect(match(undefined, '2026-10-19T10:00:00Z')).resolves.toEqual({ outcome: 'pending', record_id: null })
    await expect(match(chat, '2026-10-19T11:30:00Z')).resolves.toEqual({ outcome: 'pending', record_id: null })
    const matches = await db.recordProposal.findMany({ where: { ...target, kind: 'match' } })
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      submissions: 2, sourceId: chat.id, proposed: expect.objectContaining({
        activity: expect.objectContaining({ occurred_at: '2026-10-19T11:30:00.000Z' }),
      }),
    })
    await match(undefined, '2026-10-19T11:45:00Z', 'Please call me back')
    expect(await db.recordProposal.count({ where: { ...target, kind: 'match', status: 'pending' } })).toBe(2)
  })

  it('never reopens or supersedes a proposal a person decided while a submission was placing', async () => {
    const target = await tenant()
    const id = await ada(target)
    await proposeTitle(target, 'Engineer')
    const engineer = await titleRow(target, 'Engineer')
    // The identical submission found the row open, but the decision landed first: a new proposal, the decided one kept.
    await expect(decidedWhileSubmitting(engineer.id, () => proposeTitle(target, 'Engineer')))
      .resolves.toEqual({ outcome: 'paired', record_id: id })
    const engineers = await db.recordProposal.findMany({
      where: { ...target, attributeSlug: 'title', proposed: { equals: 'Engineer' } }, orderBy: { submittedSeq: 'asc' },
    })
    expect(engineers.map((row) => [row.id === engineer.id, row.status, row.submissions]))
      .toEqual([[true, 'approved', 1], [false, 'pending', 1]])

    // A full window: the oldest was decided while a newer submission pushed it out — it stays decided.
    for (const title of ['A', 'B', 'C', 'D']) await proposeTitle(target, title)
    const oldest = await db.recordProposal.findFirstOrThrow({
      where: { ...target, attributeSlug: 'title', status: 'pending' }, orderBy: { submittedSeq: 'asc' },
    })
    expect(oldest.proposed).toBe('Engineer')
    await decidedWhileSubmitting(oldest.id, () => proposeTitle(target, 'E'))
    expect(await db.recordProposal.findUniqueOrThrow({ where: { id: oldest.id } })).toMatchObject({ status: 'approved' })
    expect(await titles(target, id, 'pending')).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(await db.recordProposal.count({ where: { ...target, status: 'superseded' } })).toBe(0)
  })

  it('lets a person decide a superseded proposal, and erases proposals of every state with their record', async () => {
    const target = await tenant()
    const id = await ada(target)
    for (const title of ['Engineer', 'A', 'B', 'C', 'D', 'E']) await proposeTitle(target, title)
    const superseded = (await listProposals(deps, person(target), { limit: 50, status: 'superseded' })).proposals
    expect(superseded.map((proposal) => [proposal.proposed_value, proposal.status])).toEqual([['Engineer', 'superseded']])
    const [engineer] = superseded
    if (engineer === undefined) throw new Error('expected a superseded proposal')
    await expect(decideProposal(deps, person(target, 'member', 'uoa_member'), { id: engineer.id, decision: 'approve' }))
      .resolves.toEqual({ id: engineer.id, status: 'approved', record_id: id })
    expect(await personData(target, id)).toMatchObject({ title: 'Engineer' })
    await expect(caught(decideProposal(deps, person(target), { id: engineer.id, decision: 'reject' })))
      .resolves.toMatchObject({ code: 'NOT_FOUND' })
    const approved = await db.auditLog.findFirstOrThrow({ where: { ...target, action: 'proposal.approved' } })
    expect(approved.metadata).toMatchObject({ previous_status: 'superseded', submissions: 1 })

    await proposeTitle(target, 'F')
    const a = await titleRow(target, 'A')
    expect(a.status).toBe('superseded')
    await expect(decideProposal(deps, person(target), { id: a.id, decision: 'reject' }))
      .resolves.toEqual({ id: a.id, status: 'rejected', record_id: null })
    expect(await titles(target, id, 'pending')).toEqual(['B', 'C', 'D', 'E', 'F'])

    const schema = await loadSchema(db, target)
    await db.$transaction((tx) => eraseRecord(tx, person(target), schema, { id, reason: 'gdpr_request', suppress: false }))
    expect(await db.recordProposal.count({ where: target })).toBe(0)
  })
})
