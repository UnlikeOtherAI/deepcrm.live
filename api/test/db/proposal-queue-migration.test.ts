import { createDb, seedTenant, type Db, type TenantRef } from '@deepcrm/db'
import { describe, expect, it } from 'vitest'

import { matchQueue, PENDING_PER_QUEUE, PENDING_PER_TEAM } from '../../src/services/proposal-store.js'
import { migrationTestTimeout, runMigration, deployBefore, withDatabase } from './migration-fixture.js'

// Migration 20261019160000_proposal_queue on proposals written under PR #5's
// caps: every row gets the queue the store computes, one submission and its
// place in submission order, and the windows hold from the migration on.

const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required for the proposal queue migration test')
const MIGRATION = '20261019160000_proposal_queue'
const start = Date.parse('2026-10-19T09:00:00.000Z')

async function person(db: Db, tenant: TenantRef): Promise<{ objectTypeId: string; recordId: string }> {
  const objectType = await db.objectType.create({ data: {
    ...tenant, slug: 'person', singularName: 'Person', pluralName: 'People', description: 'People.',
    kind: 'standard', createdByType: 'system', createdById: 'migration-test',
  } })
  const record = await db.record.create({ data: {
    ...tenant, objectTypeId: objectType.id, displayName: 'Ada', createdByType: 'system', createdById: 'migration-test',
  } })
  return { objectTypeId: objectType.id, recordId: record.id }
}

/** A row as PR #5 wrote it: ApprovalStatus, no queue, count, order or last submission. */
async function legacyProposal(db: Db, tenant: TenantRef, row: {
  kind: 'amendment' | 'match'; status: 'pending' | 'approved'; objectTypeId: string; recordId: string | null
  attributeSlug: string | null; proposed: unknown; hash: string; second: number
}): Promise<void> {
  await db.$executeRaw`
    INSERT INTO record_proposals (id, organization_id, team_id, kind, status, object_type_id, record_id, attribute_slug,
      proposed, proposed_hash, source_kind, source_id, source_name, requester_type, requester_id, request_id, created_at)
    VALUES (gen_random_uuid(), ${tenant.organizationId}::uuid, ${tenant.teamId}::uuid, ${row.kind}::"ProposalKind",
      ${row.status}::"ApprovalStatus", ${row.objectTypeId}::uuid, ${row.recordId}::uuid, ${row.attributeSlug},
      ${JSON.stringify(row.proposed)}::jsonb, ${row.hash}, 'contact_form', 'form', 'Form', 'system'::"ActorType",
      'subject:nessie', ${`legacy-${row.hash}`}, ${new Date(start + row.second * 1_000)})
  `
}

const submission = (email: string | undefined, phone: string) => ({
  ...(email === undefined ? {} : { email }), phone, data: {}, values: {}, note: null,
  activity: { kind: 'message', occurred_at: '2026-10-19T08:00:00.000Z', subject: 'Contact form' },
})

describe('proposal queue migration', () => {
  it('backfills queues, counts and submission order, and applies the windows', async () => {
    await withDatabase(url, async (database) => {
      await deployBefore(database, MIGRATION)
      const db = createDb(database)
      try {
        const seeded = await seedTenant(db)
        const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
        const { objectTypeId, recordId } = await person(db, tenant)
        const amendment = { kind: 'amendment' as const, objectTypeId, recordId }
        for (let index = 0; index < PENDING_PER_QUEUE + 2; index += 1) {
          await legacyProposal(db, tenant, {
            ...amendment, status: 'pending', attributeSlug: 'title', proposed: `Title ${index}`, hash: `title-${index}`,
            second: 10 + index,
          })
        }
        await legacyProposal(db, tenant, {
          ...amendment, status: 'approved', attributeSlug: 'name', proposed: { full: 'Augusta' }, hash: 'name', second: 1,
        })
        const match = { kind: 'match' as const, status: 'pending' as const, objectTypeId, recordId: null, attributeSlug: null }
        await legacyProposal(db, tenant, {
          ...match, proposed: submission('ada@example.com', '+442071838750'), hash: 'match-both', second: 2,
        })
        await legacyProposal(db, tenant, { ...match, proposed: submission(undefined, '+442071838750'), hash: 'match-phone', second: 3 })
        // Another team past the team window, spread over distinct queues.
        const busyTeam = await seedTenant(db)
        const busy = { organizationId: busyTeam.organizationId, teamId: busyTeam.teamId }
        const busyType = await person(db, busy)
        await db.$executeRaw`
          INSERT INTO record_proposals (id, organization_id, team_id, kind, status, object_type_id, proposed, proposed_hash,
            source_kind, source_id, source_name, requester_type, requester_id, request_id, created_at)
          SELECT gen_random_uuid(), ${busy.organizationId}::uuid, ${busy.teamId}::uuid, 'match', 'pending',
            ${busyType.objectTypeId}::uuid, jsonb_build_object('email', 'p' || n || '@example.com', 'phone', '+442071838750'),
            'busy-' || n, 'contact_form', 'form', 'Form', 'system', 'subject:nessie', 'busy-' || n,
            ${new Date(start)}::timestamp + n * interval '1 second'
          FROM generate_series(1, ${PENDING_PER_TEAM + 3}) AS n
        `

        await runMigration(database, MIGRATION)

        const rows = await db.recordProposal.findMany({ where: tenant, orderBy: { submittedSeq: 'asc' } })
        expect(rows.map((row) => row.proposedHash)).toEqual([
          'name', 'match-both', 'match-phone', ...Array.from({ length: PENDING_PER_QUEUE + 2 }, (_, index) => `title-${index}`),
        ])
        for (const row of rows) {
          expect(row.submissions).toBe(1)
          expect(row.lastSubmittedAt).toEqual(row.createdAt)
        }
        const byHash = new Map(rows.map((row) => [row.proposedHash, row]))
        expect(byHash.get('title-0')?.queueKey).toBe(`amendment:${recordId}:title`)
        expect(byHash.get('name')?.queueKey).toBe(`amendment:${recordId}:name`)
        expect(byHash.get('match-both')?.queueKey).toBe(matchQueue('ada@example.com', '+442071838750'))
        expect(byHash.get('match-phone')?.queueKey).toBe(matchQueue(undefined, '+442071838750'))
        expect(rows.map((row) => [row.proposedHash, row.status])).toEqual([
          ['name', 'approved'], ['match-both', 'pending'], ['match-phone', 'pending'],
          ['title-0', 'superseded'], ['title-1', 'superseded'],
          ...Array.from({ length: PENDING_PER_QUEUE }, (_, index) => [`title-${index + 2}`, 'pending']),
        ])
        expect(rows.filter((row) => row.status === 'superseded').every((row) => row.resolvedAt !== null)).toBe(true)

        const busyRows = await db.recordProposal.findMany({ where: busy, orderBy: { submittedSeq: 'asc' }, take: 4 })
        expect(busyRows.map((row) => row.status)).toEqual(['superseded', 'superseded', 'superseded', 'pending'])
        expect(await db.recordProposal.count({ where: { ...busy, status: 'pending' } })).toBe(PENDING_PER_TEAM)

        // New rows continue the submission order after every migrated row.
        const highest = await db.recordProposal.aggregate({ _max: { submittedSeq: true } })
        const created = await db.recordProposal.create({ data: {
          ...tenant, kind: 'amendment', objectTypeId, recordId, attributeSlug: 'title', queueKey: `amendment:${recordId}:title`,
          proposed: 'Later', proposedHash: 'later', lastSubmittedAt: new Date(), sourceKind: 'contact_form', sourceId: 'form',
          sourceName: 'Form', requesterType: 'system', requesterId: 'subject:nessie', requestId: 'later',
        } })
        expect(created.submittedSeq > (highest._max.submittedSeq ?? 0n)).toBe(true)
      } finally {
        await db.$disconnect()
      }
    })
  }, migrationTestTimeout)
})
