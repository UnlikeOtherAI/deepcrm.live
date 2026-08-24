import { createHash } from 'node:crypto'

import {
  canonicalJson, createDb, dropTenant, seedTenant, writeAudit, type PolicyAction,
} from '@deepcrm/db'
import type { LinkWriter } from '@deepcrm/schema-engine'
import { ServiceError, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import {
  createRecord,
  updateRecord,
  type CreateRecordServiceInput,
} from '../../src/services/records.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for record service tests')

const db = createDb(databaseUrl)
const organizationIds: string[] = []
const fixedNow = new Date('2026-08-24T12:00:00.000Z')
const deps: AppDeps = {
  db,
  clock: () => fixedNow,
  ids: () => crypto.randomUUID(),
  version: '0.0.0',
  orgAllowlist: null,
  writeAudit,
}
type Tenant = { organizationId: string; teamId: string }

const throwingLinkWriter: LinkWriter = {
  apply: async () => {
    throw new Error('T14 link writer required')
  },
  delete: async () => ({ changes: [], touchedRecordIds: [] }),
  restore: async () => ({ changes: [], touchedRecordIds: [] }),
}

function context(tenant: Tenant): ActorContext {
  return {
    tenant,
    app: 'test',
    actChain: [{ sub: 'upstream_agent', product: 'test' }],
    actor: { type: 'human', id: 'uoa_records_user' },
    onBehalfOf: { uoaUserId: 'uoa_records_user', role: 'member' },
    provenance: { runId: 'run_records', toolCallId: 'call_records', requestId: 'request_records' },
    requestId: crypto.randomUUID(),
    now: fixedNow,
  }
}

async function tenant(): Promise<Tenant> {
  const created = await seedTenant(db)
  organizationIds.push(created.organizationId)
  await db.$transaction(async (tx) => {
    const company = await tx.objectType.create({
      data: {
        organizationId: created.organizationId,
        teamId: created.teamId,
        slug: 'company',
        singularName: 'Company',
        pluralName: 'Companies',
        description: 'A company',
        kind: 'custom',
        createdByType: 'system',
        createdById: 'records_service_fixture',
      },
    })
    const person = await tx.objectType.create({
      data: {
        organizationId: created.organizationId,
        teamId: created.teamId,
        slug: 'person',
        singularName: 'Person',
        pluralName: 'People',
        description: 'A person',
        kind: 'custom',
        createdByType: 'system',
        createdById: 'records_service_fixture',
      },
    })
    const name = await tx.attribute.create({
      data: {
        organizationId: created.organizationId,
        teamId: created.teamId,
        objectTypeId: person.id,
        slug: 'name',
        name: 'Name',
        description: 'Display name',
        type: 'text',
        config: { maxLength: 120 },
        isRequired: true,
        isSystem: true,
        position: 0,
      },
    })
    await tx.attribute.create({
      data: {
        organizationId: created.organizationId,
        teamId: created.teamId,
        objectTypeId: person.id,
        slug: 'email',
        name: 'Email',
        description: 'Unique email',
        type: 'email',
        config: {},
        isUnique: true,
        isIndexed: true,
        position: 1,
      },
    })
    await tx.attribute.create({
      data: {
        organizationId: created.organizationId,
        teamId: created.teamId,
        objectTypeId: person.id,
        slug: 'company',
        name: 'Company',
        description: 'Employer',
        type: 'record_reference',
        config: { objectTypes: ['company'] },
        isIndexed: true,
        position: 2,
      },
    })
    await tx.relationType.create({
      data: {
        organizationId: created.organizationId,
        teamId: created.teamId,
        slug: 'person_company',
        fromObjectTypeId: person.id,
        toObjectTypeId: company.id,
        forwardName: 'Company',
        inverseName: 'People',
        cardinality: 'many_to_one',
        projectionAttributeSlug: 'company',
      },
    })
    await tx.objectType.update({ where: { id: person.id }, data: { primaryAttributeId: name.id } })
    await tx.team.update({ where: { id: created.teamId }, data: { schemaVersion: 1 } })
  })
  return created
}

async function addRule(target: Tenant, action: PolicyAction, effect: 'allow' | 'deny'): Promise<void> {
  await db.policyRule.create({
    data: {
      organizationId: target.organizationId,
      teamId: target.teamId,
      scope: 'team',
      scopeId: target.teamId,
      resourceType: 'record',
      action,
      effect,
      createdById: 'records_service_fixture',
      bindings: { create: [{ actorType: 'role', actorId: 'member' }] },
    },
  })
}

async function state(target: Tenant) {
  const where = { organizationId: target.organizationId, teamId: target.teamId }
  const [records, changes, jobs, replays, audits, uniqueKeys] = await Promise.all([
    db.record.count({ where }),
    db.recordChange.count({ where }),
    db.queueJob.count({ where }),
    db.idempotencyReplay.count({ where }),
    db.auditLog.count({ where }),
    db.recordUniqueKey.count({ where }),
  ])
  return { records, changes, jobs, replays, audits, uniqueKeys }
}

function argsHash(input: CreateRecordServiceInput): string {
  const args = {
    objectType: input.objectType,
    data: input.data,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  }
  return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex')
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let complete: (() => void) | undefined
  const promise = new Promise<void>((resolve) => { complete = resolve })
  return {
    promise,
    resolve: () => {
      if (complete === undefined) throw new Error('Deferred promise is not initialized')
      complete()
    },
  }
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
  for (const organizationId of organizationIds) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('record service policy, transaction, and idempotency seam', () => {
  it('stores and replays a completed result and rejects mismatched arguments', async () => {
    const target = await tenant()
    const ctx = context(target)
    const input = {
      objectType: 'person',
      data: { name: 'Ada', email: 'Ada@Example.COM' },
      idempotencyKey: 'create-ada',
      reason: 'fixture create',
    }
    const created = await createRecord(deps, ctx, input, throwingLinkWriter)
    const replayed = await createRecord(deps, ctx, {
      ...input,
      data: { email: 'Ada@Example.COM', name: 'Ada' },
    }, throwingLinkWriter)

    expect(replayed).toEqual(created)
    expect(created).toMatchObject({ created: true, changed: true, record: { version: 1 } })
    expect(await state(target)).toEqual({
      records: 1, changes: 3, jobs: 1, replays: 1, audits: 1, uniqueKeys: 1,
    })
    await expect(createRecord(deps, ctx, {
      ...input,
      data: { name: 'Grace', email: 'grace@example.com' },
    }, throwingLinkWriter)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
    expect(await state(target)).toEqual({
      records: 1, changes: 3, jobs: 1, replays: 1, audits: 1, uniqueKeys: 1,
    })
  })

  it('reports an existing null replay as in progress', async () => {
    const target = await tenant()
    const ctx = context(target)
    const input = {
      objectType: 'person', data: { name: 'Pending' }, idempotencyKey: 'pending-create',
    }
    await db.idempotencyReplay.create({
      data: {
        organizationId: target.organizationId,
        teamId: target.teamId,
        principalUserId: ctx.onBehalfOf.uoaUserId,
        tool: 'crm_record_create',
        key: input.idempotencyKey,
        argumentsHash: argsHash(input),
      },
    })

    await expect(createRecord(deps, ctx, input, throwingLinkWriter)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
    })
    expect(await state(target)).toEqual({
      records: 0, changes: 0, jobs: 0, replays: 1, audits: 0, uniqueKeys: 0,
    })
  })

  it('returns in progress instead of waiting on a live same-key transaction', async () => {
    const target = await tenant()
    const ctx = context(target)
    const entered = deferred()
    const release = deferred()
    const blockingWriter: LinkWriter = {
      apply: async () => {
        entered.resolve()
        await release.promise
        return { changes: [], touchedRecordIds: [] }
      },
      delete: throwingLinkWriter.delete,
      restore: throwingLinkWriter.restore,
    }
    const input = {
      objectType: 'person',
      data: { name: 'Concurrent', company: crypto.randomUUID() },
      idempotencyKey: 'concurrent-create',
    }
    const first = createRecord(deps, ctx, input, blockingWriter)
    await entered.promise
    try {
      await expect(createRecord(deps, ctx, input, blockingWriter)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_IN_PROGRESS',
      })
    } finally {
      release.resolve()
    }
    await expect(first).resolves.toMatchObject({ created: true, changed: true })
    expect(await state(target)).toEqual({
      records: 1, changes: 2, jobs: 1, replays: 1, audits: 1, uniqueKeys: 0,
    })
  })

  it('writes only a denied audit when policy rejects the operation', async () => {
    const target = await tenant()
    const ctx = context(target)
    await addRule(target, 'create', 'deny')

    await expect(createRecord(deps, ctx, {
      objectType: 'person', data: { name: 'Denied' }, idempotencyKey: 'denied-create',
    }, throwingLinkWriter)).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    expect(await state(target)).toEqual({
      records: 0, changes: 0, jobs: 0, replays: 0, audits: 1, uniqueKeys: 0,
    })
    await expect(db.auditLog.findFirstOrThrow({
      where: { organizationId: target.organizationId, teamId: target.teamId },
    })).resolves.toMatchObject({
      action: 'crm_record_create',
      resourceType: 'record',
      outcome: 'denied',
      actorId: ctx.actor.id,
      onBehalfOf: ctx.onBehalfOf.uoaUserId,
      requestId: ctx.requestId,
    })
  })

  it('rolls back all allowed writes when the required link writer fails', async () => {
    const target = await tenant()
    const ctx = context(target)

    const failure = await caught(createRecord(deps, ctx, {
      objectType: 'person',
      data: { name: 'Rollback', company: crypto.randomUUID() },
      idempotencyKey: 'rollback-create',
    }, throwingLinkWriter))
    expect(failure).toMatchObject({
      code: 'INTERNAL', message: 'Record operation failed',
      details: { correlation_id: expect.any(String) },
    })
    expect(Object.keys(failure.details)).toEqual(['correlation_id'])
    expect(failure.message).not.toContain('T14')
    expect(await state(target)).toEqual({
      records: 0, changes: 0, jobs: 0, replays: 0, audits: 0, uniqueKeys: 0,
    })
  })

  it('persists and replays a deterministic no-op without version, change, job, or audit writes', async () => {
    const target = await tenant()
    const ctx = context(target)
    const created = await createRecord(deps, ctx, {
      objectType: 'person', data: { name: 'Noop' },
    }, throwingLinkWriter)
    const before = await state(target)
    const auditActions: string[] = []
    const noOpDeps: AppDeps = {
      ...deps,
      writeAudit: async (tx, entry) => {
        auditActions.push(entry.action)
        return writeAudit(tx, entry)
      },
    }
    const input = {
      recordId: created.record.id,
      data: { name: 'Noop' },
      expectedVersion: 1,
      idempotencyKey: 'noop-update',
    }
    const first = await updateRecord(noOpDeps, ctx, input, throwingLinkWriter)
    const replay = await updateRecord(noOpDeps, ctx, input, throwingLinkWriter)

    expect(first).toEqual(replay)
    expect(first).toMatchObject({ changed: false, record: { id: created.record.id, version: 1 } })
    expect(auditActions).toEqual([])
    expect(await state(target)).toEqual({ ...before, replays: before.replays + 1 })
    await expect(db.idempotencyReplay.findFirstOrThrow({
      where: { organizationId: target.organizationId, teamId: target.teamId, key: 'noop-update' },
    })).resolves.toMatchObject({ result: first })
  })

  it('rolls back a version conflict without changing the allowed record', async () => {
    const target = await tenant()
    const ctx = context(target)
    const created = await createRecord(deps, ctx, {
      objectType: 'person', data: { name: 'Versioned' },
    }, throwingLinkWriter)
    const before = await state(target)

    await expect(updateRecord(deps, ctx, {
      recordId: created.record.id,
      data: { name: 'Changed' },
      expectedVersion: 99,
      idempotencyKey: 'bad-version',
    }, throwingLinkWriter)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { current: 1 } })
    expect(await state(target)).toEqual(before)
    await expect(db.record.findFirstOrThrow({
      where: { organizationId: target.organizationId, teamId: target.teamId, id: created.record.id },
    })).resolves.toMatchObject({ version: 1, data: { name: 'Versioned' } })
  })
})
