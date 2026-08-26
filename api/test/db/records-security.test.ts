import {
  createDb, dropTenant, seedTenant, writeAudit, type PolicyAction, type PolicyResourceType,
} from '@deepcrm/db'
import { FakeEmbedder, type LinkWriter } from '@deepcrm/schema-engine'
import { parseSecretBox, ServiceError, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import {
  assertRecord,
  createRecord,
  deleteRecord,
  restoreRecord,
  updateRecord,
} from '../../src/services/records.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for record security tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')
const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSJ9fQ=='
type Tenant = { organizationId: string; teamId: string }

const noLinks: LinkWriter = {
  apply: async () => ({ changes: [], touchedRecordIds: [] }),
  delete: async () => ({ changes: [], touchedRecordIds: [] }),
  restore: async () => ({ changes: [], touchedRecordIds: [] }),
}
const deps: AppDeps = {
  db, clock: () => now, ids: () => crypto.randomUUID(), version: '0.0.0', maxBulkRows: 10_000, maxExportRows: 100_000,
  embedder: new FakeEmbedder('api-test'),
  orgAllowlist: null, linkWriter: noLinks,
  historyCursor: createHistoryCursorCodec(parseSecretBox(keyring)),
  queryCursor: createQueryCursorCodec(parseSecretBox(keyring)),
  secretBox: parseSecretBox(keyring), writeAudit,
}

function context(tenant: Tenant, userId = 'uoa_records_user'): ActorContext {
  return {
    tenant,
    app: 'test',
    actChain: [],
    actor: { type: 'human', id: userId },
    onBehalfOf: { uoaUserId: userId, role: 'member' },
    provenance: { runId: 'run_security', toolCallId: 'call_security', requestId: crypto.randomUUID() },
    requestId: crypto.randomUUID(),
    now,
  }
}

function agentContext(tenantValue: Tenant, agentId: string): ActorContext {
  return {
    ...context(tenantValue, 'uoa_agent_operator'),
    actor: { type: 'agent', id: agentId },
  }
}

async function tenant(): Promise<Tenant> {
  const created = await seedTenant(db)
  organizations.push(created.organizationId)
  await db.$transaction(async (tx) => {
    const person = await tx.objectType.create({
      data: {
        organizationId: created.organizationId, teamId: created.teamId,
        slug: 'person', singularName: 'Person', pluralName: 'People', description: 'A person',
        kind: 'custom', createdByType: 'system', createdById: 'records_security_fixture',
      },
    })
    const name = await tx.attribute.create({
      data: {
        organizationId: created.organizationId, teamId: created.teamId, objectTypeId: person.id,
        slug: 'name', name: 'Name', description: 'Display name', type: 'text',
        config: { maxLength: 120 }, isRequired: true, isSystem: true, position: 0,
      },
    })
    await tx.attribute.create({
      data: {
        organizationId: created.organizationId, teamId: created.teamId, objectTypeId: person.id,
        slug: 'email', name: 'Email', description: 'Unique email', type: 'email', config: {},
        isUnique: true, isIndexed: true, position: 1,
      },
    })
    await tx.attribute.create({
      data: {
        organizationId: created.organizationId, teamId: created.teamId, objectTypeId: person.id,
        slug: 'secret', name: 'Secret', description: 'Sensitive value', type: 'text',
        config: { maxLength: 120 }, sensitivity: 'confidential', position: 2,
      },
    })
    await tx.attribute.create({
      data: {
        organizationId: created.organizationId, teamId: created.teamId, objectTypeId: person.id,
        slug: 'tags', name: 'Tags', description: 'Ordered tags', type: 'text',
        config: { maxLength: 120 }, isMulti: true, position: 3,
      },
    })
    await tx.objectType.update({ where: { id: person.id }, data: { primaryAttributeId: name.id } })
    await tx.team.update({ where: { id: created.teamId }, data: { schemaVersion: 1 } })
  })
  return created
}

async function addRule(
  target: Tenant,
  resourceType: PolicyResourceType,
  action: PolicyAction,
  effect: 'allow' | 'deny',
  requiresApproval = false,
  sensitivity?: 'confidential' | 'restricted',
): Promise<void> {
  await db.policyRule.create({
    data: {
      organizationId: target.organizationId, teamId: target.teamId,
      scope: 'team', scopeId: target.teamId, resourceType, action, effect,
      requiresApproval,
      ...(sensitivity === undefined ? {} : { conditions: { sensitivity } }),
      createdById: 'records_security_fixture',
      bindings: { create: [{ actorType: 'role', actorId: 'member' }] },
    },
  })
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

afterAll(async () => {
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('record service security boundaries', () => {
  it('enforces write guard origin, visibility, immutability, and stable multi order', async () => {
    const target = await tenant()
    const ctx = context(target)
    await db.team.update({
      where: { id: target.teamId },
      data: { rejectedOrigins: ['blocked'], requireOrigin: true, teamVisibilityOnlyApps: ['test'] },
    })

    await expect(createRecord(deps, ctx, {
      objectType: 'person', data: { name: 'No Origin' },
    })).rejects.toMatchObject({ code: 'ORIGIN_REJECTED', details: { origin: null } })
    await expect(createRecord(deps, ctx, {
      objectType: 'person', data: { name: 'Blocked' }, origin: 'blocked',
    })).rejects.toMatchObject({ code: 'ORIGIN_REJECTED', details: { origin: 'blocked' } })
    await expect(createRecord(deps, ctx, {
      objectType: 'person', data: { name: 'Users' }, origin: 'manual', visibleTo: [ctx.onBehalfOf.uoaUserId],
    })).rejects.toMatchObject({ code: 'VISIBILITY_REJECTED' })

    const created = await createRecord(deps, ctx, {
      objectType: 'person',
      data: { name: 'Ordered', tags: ['second', 'first', 'second'] },
      origin: 'manual',
    })
    await expect(updateRecord(deps, ctx, {
      recordId: created.record.id, data: { name: 'Other Origin' }, origin: 'other',
    })).rejects.toMatchObject({ code: 'ORIGIN_REJECTED', details: { origin: 'other' } })

    const stored = await db.record.findUniqueOrThrow({ where: { id: created.record.id } })
    expect(stored.data).toMatchObject({ tags: ['second', 'first'] })
    expect(await db.record.count({
      where: { organizationId: target.organizationId, teamId: target.teamId },
    })).toBe(1)
  })

  it('returns NOT_FOUND before policy for an invisible record and honors a users grant', async () => {
    const target = await tenant()
    const owner = context(target, 'uoa_private_owner')
    const caller = context(target, 'uoa_granted_caller')
    const created = await createRecord(deps, owner, {
      objectType: 'person', data: { name: 'Private', email: 'private@example.com' },
    })
    await db.record.update({ where: { id: created.record.id }, data: { visibility: 'private' } })
    const auditsBefore = await db.auditLog.count({ where: { organizationId: target.organizationId } })

    await expect(updateRecord(deps, caller, {
      recordId: created.record.id, data: { name: 'Hidden' },
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(assertRecord(deps, caller, {
      objectType: 'person', matchAttribute: 'email',
      data: { name: 'Hidden', email: 'private@example.com' },
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(deleteRecord(deps, caller, {
      recordId: created.record.id, expectedVersion: 1,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await db.auditLog.count({ where: { organizationId: target.organizationId } })).toBe(auditsBefore)

    await db.record.update({ where: { id: created.record.id }, data: { visibility: 'users' } })
    await db.recordVisibilityGrant.create({
      data: { recordId: created.record.id, uoaUserId: caller.onBehalfOf.uoaUserId },
    })
    await expect(updateRecord(deps, caller, {
      recordId: created.record.id, data: { name: 'Visible' },
    })).resolves.toMatchObject({ changed: true, record: { display_name: 'visible' } })
  })

  it('requires policy instead of actor_reference data to grant record edit', async () => {
    const target = await tenant()
    const owner = context(target, 'uoa_role_owner')
    const agent = agentContext(target, 'collab')
    const person = await db.objectType.findFirstOrThrow({
      where: { organizationId: target.organizationId, teamId: target.teamId, slug: 'person' },
      select: { id: true },
    })
    await db.attribute.create({
      data: {
        organizationId: target.organizationId, teamId: target.teamId, objectTypeId: person.id,
        slug: 'collaborator', name: 'Collaborator', description: 'Agent collaborator',
        type: 'actor_reference', config: { allow: ['agent'], role: 'collaborator' }, position: 4,
      },
    })
    await db.team.update({ where: { id: target.teamId }, data: { schemaVersion: { increment: 1 } } })
    const created = await createRecord(deps, owner, {
      objectType: 'person',
      data: { name: 'Delegated', collaborator: { type: 'agent', id: `agent:test:${agent.actor.id}` } },
    })

    await expect(updateRecord(deps, agent, {
      recordId: created.record.id,
      data: { name: 'Agent Edited' },
    })).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    await db.policyRule.create({
      data: {
        organizationId: target.organizationId,
        teamId: target.teamId,
        scope: 'team',
        scopeId: target.teamId,
        resourceType: 'record',
        action: 'edit',
        effect: 'allow',
        priority: 100,
        createdById: 'records_security_fixture',
        bindings: { create: [
          { actorType: 'role', actorId: 'member' },
          { actorType: 'agent', actorId: `agent:test:${agent.actor.id}` },
        ] },
      },
    })
    await expect(updateRecord(deps, agent, {
      recordId: created.record.id,
      data: { name: 'Agent Edited' },
    })).resolves.toMatchObject({ changed: true, record: { display_name: 'agent edited' } })
  })

  it('redacts an invisible duplicate id but preserves a visible duplicate id', async () => {
    const target = await tenant()
    const caller = context(target, 'uoa_duplicate_caller')
    const hiddenOwner = context(target, 'uoa_duplicate_owner')
    const hidden = await createRecord(deps, hiddenOwner, {
      objectType: 'person', data: { name: 'Hidden', email: 'hidden@example.com' },
    })
    await db.record.update({ where: { id: hidden.record.id }, data: { visibility: 'private' } })

    const hiddenError = await caught(createRecord(deps, caller, {
      objectType: 'person', data: { name: 'Collision', email: 'hidden@example.com' },
    }))
    expect(hiddenError.code).toBe('DUPLICATE_FOUND')
    expect(hiddenError.details).not.toHaveProperty('record_id')
    expect(hiddenError.details).not.toHaveProperty('record_ids')
    expect(hiddenError.details).not.toHaveProperty('candidates')

    const visible = await createRecord(deps, caller, {
      objectType: 'person', data: { name: 'Visible', email: 'visible@example.com' },
    })
    const visibleError = await caught(createRecord(deps, caller, {
      objectType: 'person', data: { name: 'Collision', email: 'visible@example.com' },
    }))
    expect(visibleError).toMatchObject({
      code: 'DUPLICATE_FOUND', details: { record_id: visible.record.id },
    })
  })

  it('composes confidential attribute denial and approval into one denied audit', async () => {
    const denied = await tenant()
    await addRule(denied, 'attribute', 'edit', 'deny', false, 'confidential')
    const deniedError = await caught(createRecord(deps, context(denied), {
      objectType: 'person', data: { name: 'Denied', secret: 'classified' },
    }))
    expect(deniedError).toMatchObject({
      code: 'POLICY_DENIED', details: { resource: 'attribute', action: 'edit' },
    })
    expect(await db.record.count({
      where: { organizationId: denied.organizationId, teamId: denied.teamId },
    })).toBe(0)
    expect(await db.auditLog.count({ where: { organizationId: denied.organizationId } })).toBe(1)

    const approval = await tenant()
    await addRule(approval, 'attribute', 'edit', 'deny', true, 'confidential')
    const approvalError = await caught(createRecord(deps, context(approval), {
      objectType: 'person', data: { name: 'Approval', secret: 'classified' },
    }))
    expect(approvalError).toMatchObject({
      code: 'APPROVAL_REQUIRED', details: { resource: 'attribute', action: 'edit' },
    })
    expect(await db.auditLog.count({ where: { organizationId: approval.organizationId } })).toBe(1)
  })

  it('authorizes assert as exactly edit for a match and create for a miss', async () => {
    const target = await tenant()
    const ctx = context(target)
    const existing = await createRecord(deps, ctx, {
      objectType: 'person', data: { name: 'Existing', email: 'existing@example.com' },
    })
    await addRule(target, 'record', 'create', 'deny')

    await expect(assertRecord(deps, ctx, {
      objectType: 'person', matchAttribute: 'email',
      data: { name: 'Edited', email: 'existing@example.com' },
    })).resolves.toMatchObject({ created: false, record: { id: existing.record.id } })
    const tenantWhere = { organizationId: target.organizationId, teamId: target.teamId }
    const rowsBeforeMiss = await Promise.all([
      db.record.count({ where: tenantWhere }),
      db.recordChange.count({ where: tenantWhere }),
      db.queueJob.count({ where: tenantWhere }),
    ])
    const auditsBeforeMiss = await db.auditLog.count({ where: { organizationId: target.organizationId } })
    await expect(assertRecord(deps, ctx, {
      objectType: 'person', matchAttribute: 'email',
      data: { name: 'Missing', email: 'missing@example.com' },
    })).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    expect(await Promise.all([
      db.record.count({ where: tenantWhere }),
      db.recordChange.count({ where: tenantWhere }),
      db.queueJob.count({ where: tenantWhere }),
    ])).toEqual(rowsBeforeMiss)
    expect(await db.auditLog.count({ where: { organizationId: target.organizationId } }))
      .toBe(auditsBeforeMiss + 1)

    const createAllowed = await tenant()
    await addRule(createAllowed, 'record', 'edit', 'deny')
    await expect(assertRecord(deps, context(createAllowed), {
      objectType: 'person', matchAttribute: 'email',
      data: { name: 'Created', email: 'created@example.com' },
    })).resolves.toMatchObject({ created: true })
  })

  it('stores replay and enqueues before the terminal audit database operation', async () => {
    const target = await tenant()
    const trace: string[] = []
    const auditActions: string[] = []
    const tracedDb = db.$extends({
      name: 'record-audit-terminal-trace',
      query: {
        async $allOperations({ model, operation, args, query }) {
          const result = await query(args)
          trace.push(`${model ?? 'client'}.${operation}`)
          return result
        },
      },
    })
    const tracedDeps: AppDeps = {
      ...deps,
      db: tracedDb,
      writeAudit: async (tx, entry) => {
        auditActions.push(entry.action)
        return writeAudit(tx, entry)
      },
    }

    await createRecord(tracedDeps, context(target), {
      objectType: 'person', data: { name: 'Ordered' }, idempotencyKey: 'ordered-create',
    })

    const replayAt = trace.lastIndexOf('IdempotencyReplay.updateMany')
    const enqueueAt = Math.max(trace.lastIndexOf('QueueJob.create'), trace.lastIndexOf('QueueJob.createMany'))
    const auditAt = trace.lastIndexOf('AuditLog.create')
    expect(replayAt).toBeGreaterThan(-1)
    expect(enqueueAt).toBeGreaterThan(-1)
    expect(auditAt).toBeGreaterThan(replayAt)
    expect(auditAt).toBeGreaterThan(enqueueAt)
    expect(auditAt).toBe(trace.length - 1)
    expect(auditActions).toEqual(['crm_record_create'])
  })

  it('runs all five wrappers with terminal audits and complete row results', async () => {
    const target = await tenant()
    const ctx = context(target)
    await addRule(target, 'record', 'delete', 'allow')
    await addRule(target, 'record', 'restore', 'allow')
    const created = await createRecord(deps, ctx, {
      objectType: 'person', data: { name: 'One', email: 'five@example.com' },
      idempotencyKey: 'five-create', reason: 'create reason',
    })
    const updated = await updateRecord(deps, ctx, {
      recordId: created.record.id, data: { name: 'Two' }, expectedVersion: 1,
      idempotencyKey: 'five-update', reason: 'update reason',
    })
    const asserted = await assertRecord(deps, ctx, {
      objectType: 'person', matchAttribute: 'email',
      data: { name: 'Three', email: 'five@example.com' }, expectedVersion: 2,
      idempotencyKey: 'five-assert', reason: 'assert reason',
    })
    const deleted = await deleteRecord(deps, ctx, {
      recordId: created.record.id, expectedVersion: 3,
      idempotencyKey: 'five-delete', reason: 'delete reason',
    })
    const restored = await restoreRecord(deps, ctx, {
      recordId: created.record.id, expectedVersion: 4,
      idempotencyKey: 'five-restore', reason: 'restore reason',
    })

    expect([created, updated, asserted, deleted, restored].map((result) => result.record.version))
      .toEqual([1, 2, 3, 4, 5])
    expect(deleted.changed).toBe(true)
    expect(restored.changed).toBe(true)
    const where = { organizationId: target.organizationId, teamId: target.teamId }
    const [changes, jobs, replays, audits] = await Promise.all([
      db.recordChange.findMany({ where, orderBy: { seq: 'asc' } }),
      db.queueJob.findMany({ where }),
      db.idempotencyReplay.findMany({ where }),
      db.auditLog.findMany({ where: { organizationId: target.organizationId }, orderBy: { createdAt: 'asc' } }),
    ])
    expect(changes).toHaveLength(7)
    expect(changes.map((change) => change.reason)).toEqual([
      'create reason', 'create reason', 'create reason', 'update reason',
      'assert reason', 'delete reason', 'restore reason',
    ])
    expect(jobs).toHaveLength(10)
    expect(replays).toHaveLength(5)
    expect(replays.every((replay) => replay.result !== null)).toBe(true)
    expect(audits.map((audit) => audit.action).sort()).toEqual([
      'crm_record_assert', 'crm_record_create', 'crm_record_delete',
      'crm_record_restore', 'crm_record_update',
    ])
  })
})
