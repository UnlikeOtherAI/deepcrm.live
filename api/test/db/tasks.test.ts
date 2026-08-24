import { randomUUID } from 'node:crypto'

import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { applyTemplate } from '@deepcrm/schema-engine'
import { afterAll, describe, expect, it } from 'vitest'

import { queryRecords } from '../../src/services/record-query.js'
import {
  createTask, listTasks, updateTask, type CreateTaskInput, type UpdateTaskInput,
} from '../../src/services/tasks.js'
import { linkContext, linkDeps } from './link-fixture.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for task service tests')

const db = createDb(databaseUrl)
const organizationIds: string[] = []
const taskAgentId = 'agent:test:agent_dev'

async function fixture() {
  const seeded = await seedTenant(db)
  organizationIds.push(seeded.organizationId)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  const ctx = linkContext(tenant)
  const actor = {
    type: ctx.actor.type,
    id: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    requestId: ctx.requestId,
  }
  await db.$transaction(async (tx) => {
    await applyTemplate(tx, tenant, actor, 'system')
    await applyTemplate(tx, tenant, actor, 'standard_crm')
  })
  await db.principalLastSeen.create({
    data: { teamId: tenant.teamId, uoaUserId: 'uoa_human', lastSeenAt: ctx.now },
  })
  const types = await db.objectType.findMany({
    where: { ...tenant, slug: { in: ['person', 'company'] } },
    select: { id: true, slug: true },
  })
  const typeIds = new Map(types.map((item) => [item.slug, item.id]))
  const personTypeId = typeIds.get('person')
  const companyTypeId = typeIds.get('company')
  if (personTypeId === undefined || companyTypeId === undefined) {
    throw new Error('Standard CRM schema is missing')
  }
  const visible = await db.record.create({ data: {
    ...tenant, objectTypeId: personTypeId, data: {}, displayName: 'Task Person',
    createdByType: 'system', createdById: 'task-test', visibility: 'team',
  } })
  const hidden = await db.record.create({ data: {
    ...tenant, objectTypeId: companyTypeId, data: {}, displayName: 'Hidden Company',
    createdByType: 'system', createdById: 'task-test', createdOnBehalfOf: 'another-user',
    visibility: 'private',
  } })
  return { tenant, ctx, visible, hidden }
}

function taskInput(
  title: string, about: string, dueAt: string, idempotencyKey?: string,
): CreateTaskInput {
  return {
    title,
    body: `${title} details`,
    dueAt,
    assignee: { type: 'agent', id: taskAgentId },
    about: [about, about],
    idempotencyKey,
  }
}

function tenantCounts(tenant: { organizationId: string; teamId: string }) {
  return Promise.all([
    db.record.count({ where: tenant }),
    db.recordLink.count({ where: tenant }),
    db.recordChange.count({ where: tenant }),
    db.idempotencyReplay.count({ where: tenant }),
    db.auditLog.count({ where: tenant }),
  ])
}

afterAll(async () => {
  for (const organizationId of organizationIds) {
    await db.auditLog.deleteMany({ where: { organizationId } })
    await dropTenant(db, organizationId)
  }
  await db.$disconnect()
})

describe('task service', () => {
  it('creates, filters, paginates, updates and replays under task tool identities', async () => {
    const target = await fixture()
    const deps = linkDeps(db)
    const createKey = `task-create-${randomUUID()}`
    const primaryInput = taskInput(
      'Primary task', target.visible.id, '2026-08-24T16:00:00.000Z', createKey,
    )
    const primary = await createTask(deps, target.ctx, primaryInput)
    const createReplay = await createTask(deps, target.ctx, primaryInput)
    expect(createReplay.record.id).toBe(primary.record.id)
    await expect(createTask(deps, target.ctx, {
      ...primaryInput, title: 'Mismatched replay',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
    expect(primary.record.data).toMatchObject({
      title: 'Primary task', status: 'open', priority: 'normal',
      assignee: { type: 'agent', id: taskAgentId },
    })
    expect(await db.recordLink.count({
      where: {
        ...target.tenant, fromRecordId: primary.record.id, activeUntil: null,
        relationType: { slug: 'task_about' },
      },
    })).toBe(1)

    const second = await createTask(deps, target.ctx, taskInput(
      'Second agent task', target.visible.id, '2026-08-24T18:00:00.000Z',
    ))
    const fourth = await createTask(deps, target.ctx, taskInput(
      'Fourth agent task', target.visible.id, '2026-08-24T20:00:00.000Z',
    ))
    const human = await createTask(deps, target.ctx, {
      title: 'Human task', dueAt: '2026-08-24T16:00:00.000Z',
      assignee: { type: 'human', id: 'uoa_human' }, about: [target.visible.id],
    })

    const agentPage = await listTasks(deps, target.ctx, {
      assignee: { type: 'agent', id: taskAgentId }, limit: 1,
    })
    expect(agentPage.records).toHaveLength(1)
    expect(agentPage.next_cursor).not.toBeNull()
    if (agentPage.next_cursor === null) throw new Error('Expected a task cursor')
    const nextAgentPage = await listTasks(deps, target.ctx, {
      assignee: { type: 'agent', id: taskAgentId }, limit: 1, cursor: agentPage.next_cursor,
    })
    expect(nextAgentPage.records).toHaveLength(1)
    await expect(listTasks(deps, target.ctx, {
      assignee: { type: 'agent', id: taskAgentId }, limit: 2, cursor: agentPage.next_cursor,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { detail: 'cursor_mismatch' } })
    await expect(queryRecords(deps, target.ctx, {
      objectType: 'task', limit: 1, cursor: agentPage.next_cursor,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { detail: 'cursor_mismatch' } })

    const dueBefore = await listTasks(deps, target.ctx, {
      dueBefore: '2026-08-24T16:00:00.000Z',
    })
    expect(new Set(dueBefore.records.map((record) => record.id)))
      .toEqual(new Set([primary.record.id, human.record.id]))
    const dueAfter = await listTasks(deps, target.ctx, {
      dueAfter: '2026-08-24T18:00:00.000Z',
    })
    expect(new Set(dueAfter.records.map((record) => record.id)))
      .toEqual(new Set([second.record.id, fourth.record.id]))
    const about = await listTasks(deps, target.ctx, { about: target.visible.id })
    expect(about.records).toHaveLength(4)

    const updateKey = `task-update-${randomUUID()}`
    const updateInput: UpdateTaskInput = {
      id: primary.record.id,
      status: 'done',
      assignee: null,
      dueAt: null,
      body: null,
      expectedVersion: primary.record.version,
      idempotencyKey: updateKey,
    }
    const updated = await updateTask(deps, target.ctx, updateInput)
    const updateReplay = await updateTask(deps, target.ctx, updateInput)
    expect(updateReplay.record.id).toBe(updated.record.id)
    expect(updated.record.data).toMatchObject({ status: 'done', priority: 'normal' })
    expect(updated.record.data).not.toHaveProperty('assignee')
    expect(updated.record.data).not.toHaveProperty('due_at')
    expect(updated.record.data).not.toHaveProperty('body')
    await expect(updateTask(deps, target.ctx, {
      ...updateInput, title: 'Mismatched update replay',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
    await expect(updateTask(deps, target.ctx, {
      id: primary.record.id, title: 'Stale update', expectedVersion: primary.record.version,
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    const done = await listTasks(deps, target.ctx, { status: 'done' })
    expect(done.records.map((record) => record.id)).toEqual([primary.record.id])

    const replays = await db.idempotencyReplay.findMany({
      where: target.tenant, select: { tool: true, key: true }, orderBy: { tool: 'asc' },
    })
    expect(replays).toEqual([
      { tool: 'crm_task_create', key: createKey },
      { tool: 'crm_task_update', key: updateKey },
    ])
    const audits = await db.auditLog.findMany({
      where: target.tenant, select: { action: true },
    })
    expect(audits.filter((entry) => entry.action === 'crm_task_create')).toHaveLength(4)
    expect(audits.filter((entry) => entry.action === 'crm_task_update')).toHaveLength(1)
  })

  it('rejects hidden about records and non-task updates without partial writes', async () => {
    const target = await fixture()
    const deps = linkDeps(db)
    const before = await tenantCounts(target.tenant)
    await expect(createTask(deps, target.ctx, {
      title: 'Hidden target', about: [target.hidden.id],
      idempotencyKey: `hidden-task-${randomUUID()}`,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await tenantCounts(target.tenant)).toEqual(before)
    await expect(listTasks(deps, target.ctx, {
      about: target.hidden.id,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await tenantCounts(target.tenant)).toEqual(before)
    await expect(updateTask(deps, target.ctx, {
      id: target.visible.id, status: 'done',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await tenantCounts(target.tenant)).toEqual(before)
  })
})
