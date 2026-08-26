import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { FakeEmbedder, type LinkWriter } from '@deepcrm/schema-engine'
import { parseSecretBox, ServiceError, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { testFileAccess } from '../file-access-fixture.js'
import type { ApprovalConsumption } from '../../src/services/approvals.js'
import {
  addSuppression,
  checkSuppression,
  listSuppressions,
  removeSuppression,
} from '../../src/services/compliance.js'
import { eraseCrmRecord } from '../../src/services/erasure.js'
import { changesSince } from '../../src/services/io.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import { getRecord } from '../../src/services/record-read.js'
import { restoreRecord } from '../../src/services/records.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for compliance tests')

const db = createDb(databaseUrl)
const organizations = new Set<string>()
const now = new Date('2026-08-24T12:00:00.000Z')
const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSJ9fQ=='
type Tenant = { organizationId: string; teamId: string }

const noLinks: LinkWriter = {
  apply: async () => ({ changes: [], touchedRecordIds: [] }),
  delete: async () => ({ changes: [], touchedRecordIds: [] }),
  restore: async () => ({ changes: [], touchedRecordIds: [] }),
}
const deps: AppDeps = {
  db,
  clock: () => now,
  ids: () => crypto.randomUUID(),
  version: '0.0.0',
  maxBulkRows: 10_000,
  maxExportRows: 100_000,
  embedder: new FakeEmbedder('api-test'),
  orgAllowlist: null,
  linkWriter: noLinks,
  historyCursor: createHistoryCursorCodec(parseSecretBox(keyring)),
  queryCursor: createQueryCursorCodec(parseSecretBox(keyring)),
  secretBox: parseSecretBox(keyring),
  fileAccess: testFileAccess,
  writeAudit,
}

function context(tenant: Tenant, role: 'owner' | 'member' = 'member'): ActorContext {
  return {
    tenant,
    app: 'test',
    actChain: [],
    actor: { type: 'human', id: `uoa_${role}` },
    onBehalfOf: { uoaUserId: `uoa_${role}`, role },
    provenance: { runId: 'run_compliance', toolCallId: 'call_compliance', requestId: crypto.randomUUID() },
    requestId: crypto.randomUUID(),
    now,
  }
}

async function tenant(): Promise<Tenant> {
  const created = await seedTenant(db)
  organizations.add(created.organizationId)
  return { organizationId: created.organizationId, teamId: created.teamId }
}

async function caught(operation: Promise<unknown>): Promise<ServiceError> {
  try {
    await operation
  } catch (error) {
    if (error instanceof ServiceError) return error
    throw error
  }
  throw new Error('Expected service operation to fail')
}

const approval: ApprovalConsumption = { args: {}, consume: async () => {} }

afterAll(async () => {
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('suppression compliance service', () => {
  it('normalizes, hashes, checks channels, and lists without raw values', async () => {
    const target = await tenant()
    const ctx = context(target)
    await addSuppression(deps, ctx, {
      kind: 'email',
      value: 'Jane User <USER@Example.COM>',
      channel: 'email',
      reason: 'objection',
      sub_reason: 'opt_out',
    })

    await expect(checkSuppression(deps, ctx, {
      entries: [{ kind: 'email', value: ' user@example.com ', channel: 'email' }],
    })).resolves.toEqual({
      results: [{ kind: 'email', suppressed: true, reason: 'objection', sub_reason: 'opt_out' }],
    })
    await expect(checkSuppression(deps, ctx, {
      entries: [{ kind: 'email', value: 'user@example.com', channel: 'post' }],
    })).resolves.toEqual({ results: [{ kind: 'email', suppressed: false }] })

    await addSuppression(deps, ctx, {
      kind: 'email',
      value: 'user@example.com',
      channel: 'all',
      reason: 'manual',
    })
    await expect(checkSuppression(deps, ctx, {
      entries: [{ kind: 'email', value: 'user@example.com', channel: 'post' }],
    })).resolves.toEqual({
      results: [{ kind: 'email', suppressed: true, reason: 'manual' }],
    })

    const listed = await listSuppressions(deps, ctx, { limit: 10 })
    expect(listed.entries).toHaveLength(2)
    expect(listed.entries.every((entry) => entry.key_hash.length === 64)).toBe(true)
    expect(JSON.stringify(listed)).not.toContain('user@example.com')
    expect(JSON.stringify(listed)).not.toContain('Jane User')
  })

  it('rejects invalid expiry and phone input, handles expiry, and normalizes company numbers', async () => {
    const target = await tenant()
    const ctx = context(target)
    await expect(addSuppression(deps, ctx, {
      kind: 'email',
      value: 'permanent@example.com',
      channel: 'all',
      reason: 'objection',
      expires_at: '2027-01-01T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(addSuppression(deps, ctx, {
      kind: 'phone',
      value: '020 7946 0018',
      channel: 'phone_call',
      reason: 'manual',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

    await addSuppression(deps, ctx, {
      kind: 'email',
      value: 'expired@example.com',
      channel: 'all',
      reason: 'manual',
      expires_at: '2026-01-01T00:00:00.000Z',
    })
    await expect(checkSuppression(deps, ctx, {
      entries: [{ kind: 'email', value: 'expired@example.com', channel: 'email' }],
    })).resolves.toEqual({ results: [{ kind: 'email', suppressed: false }] })

    await addSuppression(deps, ctx, {
      kind: 'company_number',
      value: '01234567',
      channel: 'all',
      reason: 'manual',
    })
    await expect(checkSuppression(deps, ctx, {
      entries: [{ kind: 'company_number', value: '1234567', channel: 'post' }],
    })).resolves.toEqual({
      results: [{ kind: 'company_number', suppressed: true, reason: 'manual' }],
    })
  })

  it('requires owner approval to remove and leaves entries after tenant deletion', async () => {
    const target = await tenant()
    const member = context(target)
    const owner = context(target, 'owner')
    await addSuppression(deps, member, {
      kind: 'email',
      value: 'remove@example.com',
      channel: 'all',
      reason: 'manual',
    })
    await db.policyRule.create({
      data: {
        organizationId: target.organizationId,
        teamId: target.teamId,
        scope: 'team',
        scopeId: target.teamId,
        resourceType: 'suppression',
        action: 'admin',
        effect: 'allow',
        requiresApproval: true,
        createdById: 'compliance-test',
        bindings: { create: [{ actorType: 'role', actorId: 'owner' }] },
      },
    })

    expect((await caught(removeSuppression(deps, member, {
      kind: 'email', value: 'remove@example.com', channel: 'all', reason: 'test',
    }))).code).toBe('POLICY_DENIED')
    expect((await caught(removeSuppression(deps, owner, {
      kind: 'email', value: 'remove@example.com', channel: 'all', reason: 'test',
    }))).code).toBe('APPROVAL_REQUIRED')
    await expect(removeSuppression(deps, owner, {
      kind: 'email', value: 'remove@example.com', channel: 'all', reason: 'test',
    }, approval)).resolves.toEqual({ removed: true })

    await addSuppression(deps, member, {
      kind: 'email',
      value: 'survives@example.com',
      channel: 'all',
      reason: 'objection',
    })
    const beforeDrop = await db.suppressionEntry.count({ where: { organizationId: target.organizationId } })
    await dropTenant(db, target.organizationId)
    organizations.delete(target.organizationId)
    expect(await db.suppressionEntry.count({ where: { organizationId: target.organizationId } })).toBe(beforeDrop)
  })

  it('erases records by suppressing first, scrubbing storage, tombstoning, and emitting a recall event', async () => {
    const target = await tenant()
    const owner = context(target, 'owner')
    await db.policyRule.createMany({
      data: [
        {
          organizationId: target.organizationId,
          teamId: target.teamId,
          scope: 'team',
          scopeId: target.teamId,
          resourceType: 'record',
          action: 'erase',
          effect: 'allow',
          priority: 100,
          requiresApproval: true,
          createdById: 'erasure-test',
        },
        {
          organizationId: target.organizationId,
          teamId: target.teamId,
          scope: 'team',
          scopeId: target.teamId,
          resourceType: 'record',
          action: 'restore',
          effect: 'allow',
          priority: 100,
          requiresApproval: false,
          createdById: 'erasure-test',
        },
      ],
    })
    const rules = await db.policyRule.findMany({
      where: { organizationId: target.organizationId, teamId: target.teamId },
    })
    await db.policyBinding.createMany({
      data: rules.map((rule) => ({
        policyRuleId: rule.id,
        actorType: 'role',
        actorId: 'owner',
      })),
    })
    const objectType = await db.objectType.create({ data: {
      ...target,
      slug: 'erase_person',
      singularName: 'Erase person',
      pluralName: 'Erase people',
      description: 'Erasure test object',
      kind: 'custom',
      createdByType: 'system',
      createdById: 'erasure-test',
    } })
    const email = await db.attribute.create({ data: {
      ...target,
      objectTypeId: objectType.id,
      slug: 'email',
      name: 'Email',
      description: 'Email',
      type: 'email',
      sensitivity: 'public',
      position: 0,
      isUnique: true,
    } })
    await db.attribute.create({ data: {
      ...target,
      objectTypeId: objectType.id,
      slug: 'company_number',
      name: 'Company number',
      description: 'Company number',
      type: 'registry_id',
      sensitivity: 'internal',
      position: 1,
    } })
    const related = await db.record.create({ data: {
      ...target,
      objectTypeId: objectType.id,
      data: { email: 'neighbour@example.com' },
      displayName: 'Neighbour',
      visibility: 'team',
      createdOnBehalfOf: owner.onBehalfOf.uoaUserId,
      createdByType: 'human',
      createdById: owner.actor.id,
    } })
    const record = await db.record.create({ data: {
      ...target,
      objectTypeId: objectType.id,
      data: { email: 'Erase Me <erase@example.com>', company_number: '01234567' },
      displayName: 'Erase Me',
      visibility: 'users',
      createdOnBehalfOf: owner.onBehalfOf.uoaUserId,
      createdByType: 'human',
      createdById: owner.actor.id,
    } })
    const relation = await db.relationType.create({ data: {
      ...target,
      slug: 'erase_relation',
      fromObjectTypeId: objectType.id,
      toObjectTypeId: objectType.id,
      forwardName: 'knows',
      inverseName: 'known by',
      cardinality: 'many_to_many',
      edgeAttributes: [],
      createdAt: now,
    } })
    const list = await db.list.create({ data: {
      ...target,
      slug: 'erase_list',
      name: 'Erase list',
      description: 'Erasure list',
      objectTypeId: objectType.id,
      createdByType: 'human',
      createdById: owner.actor.id,
    } })
    await Promise.all([
      db.recordVisibilityGrant.create({ data: { recordId: record.id, uoaUserId: 'uoa_extra' } }),
      db.recordUniqueKey.create({ data: {
        ...target,
        attributeId: email.id,
        recordId: record.id,
        normalizedHash: 'b'.repeat(64),
        normalizedValue: 'erase@example.com',
      } }),
      db.recordSearch.create({ data: {
        ...target,
        recordId: record.id,
        objectTypeId: objectType.id,
        content: 'Erase Me erase@example.com',
      } }),
      db.recordLink.create({ data: {
        ...target,
        relationTypeId: relation.id,
        fromRecordId: record.id,
        toRecordId: related.id,
        data: { role: 'private edge value' },
        createdByType: 'human',
        createdById: owner.actor.id,
      } }),
      db.listEntry.create({ data: {
        listId: list.id,
        recordId: record.id,
        data: { note: 'private list value' },
      } }),
    ])
    await db.team.update({
      where: { id: target.teamId },
      data: { feedSeq: { increment: 2 } },
    })
    await db.recordChange.createMany({ data: [
      {
        ...target,
        recordId: record.id,
        kind: 'create',
        actorType: owner.actor.type,
        actorId: owner.actor.id,
        onBehalfOf: owner.onBehalfOf.uoaUserId,
        requestId: owner.requestId,
        resultingVersion: 1,
        seq: 1n,
        newValue: { email: 'erase@example.com' },
      },
      {
        ...target,
        recordId: record.id,
        kind: 'set',
        attributeSlug: 'email',
        actorType: owner.actor.type,
        actorId: owner.actor.id,
        onBehalfOf: owner.onBehalfOf.uoaUserId,
        requestId: owner.requestId,
        resultingVersion: 1,
        seq: 2n,
        oldValue: { previous: 'old@example.com' },
        newValue: 'erase@example.com',
      },
    ] })
    const beforeSeqs = await db.recordChange.findMany({
      where: { ...target, recordId: record.id },
      orderBy: { seq: 'asc' },
      select: { seq: true },
    })

    await expect(eraseCrmRecord(deps, owner, {
      id: record.id,
      reason: 'gdpr_request',
      suppress: true,
    }, approval)).resolves.toEqual({
      erased: true,
      suppressed: [{ kind: 'company_number', count: 1 }, { kind: 'email', count: 1 }],
    })

    await expect(getRecord(deps, owner, { id: record.id })).rejects.toMatchObject({ code: 'ERASED' })
    await expect(restoreRecord(deps, owner, {
      recordId: record.id,
      expectedVersion: 2,
      reason: 'test',
    })).rejects.toMatchObject({ code: 'ERASED' })
    await expect(checkSuppression(deps, owner, {
      entries: [
        { kind: 'email', value: 'erase@example.com', channel: 'email' },
        { kind: 'company_number', value: '1234567', channel: 'post' },
      ],
    })).resolves.toEqual({
      results: [
        { kind: 'email', suppressed: true, reason: 'erasure' },
        { kind: 'company_number', suppressed: true, reason: 'erasure' },
      ],
    })
    const erased = await db.record.findUniqueOrThrow({ where: { id: record.id } })
    expect(erased).toMatchObject({
      data: {},
      displayName: '(erased)',
      deletedAt: now,
      erasedAt: now,
      ownerId: null,
      ownerType: null,
      origin: null,
    })
    expect(await db.recordUniqueKey.count({ where: { ...target, recordId: record.id } })).toBe(0)
    expect(await db.recordSearch.findFirst({ where: { ...target, recordId: record.id } })).toBeNull()
    expect(await db.recordVisibilityGrant.count({ where: { recordId: record.id } })).toBe(0)
    const link = await db.recordLink.findFirstOrThrow({ where: { fromRecordId: record.id } })
    expect(link.data).toEqual({})
    expect(link.activeUntil?.toISOString()).toBe(now.toISOString())
    const entry = await db.listEntry.findUniqueOrThrow({
      where: { listId_recordId: { listId: list.id, recordId: record.id } },
    })
    expect(entry.data).toEqual({})
    const scrubbed = await db.recordChange.findMany({
      where: { ...target, recordId: record.id, kind: { in: ['create', 'set'] } },
      orderBy: { seq: 'asc' },
      select: { seq: true, oldValue: true, newValue: true, snapshot: true },
    })
    expect(scrubbed.map((row) => row.seq)).toEqual(beforeSeqs.map((row) => row.seq))
    expect(scrubbed.every((row) => (
      row.oldValue === null && row.newValue === null && row.snapshot === null
    ))).toBe(true)
    await expect(changesSince(deps, owner, { from: 'beginning', kinds: ['erase'], limit: 10 }))
      .resolves.toMatchObject({
        changes: [expect.objectContaining({ event: 'record.erased', kind: 'erase', record: {
          id: record.id,
          object_type: 'erase_person',
          display_name: '(erased)',
        } })],
        has_more: false,
      })
    expect(await db.queueJob.findFirst({
      where: { type: 'record.reindex_neighbours', organizationId: target.organizationId, teamId: target.teamId },
    })).toMatchObject({ status: 'queued' })
    const audit = await db.auditLog.findFirstOrThrow({
      where: { ...target, action: 'crm_record_erase', outcome: 'success', resourceId: record.id },
      orderBy: { createdAt: 'desc' },
    })
    expect(JSON.stringify(audit.metadata)).not.toContain('erase@example.com')
    expect(audit.entryHash).toMatch(/^[a-f0-9]{64}$/u)
  })
})
