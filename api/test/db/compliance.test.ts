import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { FakeEmbedder, type LinkWriter } from '@deepcrm/schema-engine'
import { parseSecretBox, ServiceError, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import type { ApprovalConsumption } from '../../src/services/approvals.js'
import {
  addSuppression,
  checkSuppression,
  listSuppressions,
  removeSuppression,
} from '../../src/services/compliance.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'

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
  return created
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
      note: 'asked to stop email',
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
})
