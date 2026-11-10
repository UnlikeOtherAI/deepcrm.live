import { createDb, seedTenant, writeAudit } from '@deepcrm/db'
import { applyTemplate, createProjectionLinkWriter, FakeEmbedder } from '@deepcrm/schema-engine'
import { parseSecretBox, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import { createRecord, deleteRecord } from '../../src/services/records.js'
import { testFileAccess } from '../file-access-fixture.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for deleted record tests')
export const db = createDb(databaseUrl)
export const organizations: string[] = []
export const now = new Date('2026-11-10T12:00:00.000Z')
const secretBox = parseSecretBox(Buffer.from(JSON.stringify({
  active: 'deleted-v1', keys: { 'deleted-v1': Buffer.alloc(32, 9).toString('base64') },
})).toString('base64'))
export const deps: AppDeps = {
  db, clock: () => now, ids: () => crypto.randomUUID(), version: 'deleted-reads-test',
  maxBulkRows: 10_000, maxExportRows: 100_000, orgAllowlist: null,
  embedder: new FakeEmbedder('deleted-reads'), linkWriter: createProjectionLinkWriter(),
  historyCursor: createHistoryCursorCodec(secretBox), queryCursor: createQueryCursorCodec(secretBox),
  secretBox, fileAccess: testFileAccess, writeAudit,
}
export type Tenant = { organizationId: string; teamId: string }
export function context(tenant: Tenant, userId = 'recovery_owner'): ActorContext {
  return {
    tenant, app: 'test', actChain: [], actor: { type: 'human', id: userId },
    onBehalfOf: { uoaUserId: userId, role: 'owner' }, provenance: null,
    requestId: crypto.randomUUID(), now,
  }
}
export async function fixture(organizationId?: string) {
  const seeded = organizationId === undefined ? await seedTenant(db) : {
    organizationId,
    teamId: (await db.team.create({ data: {
      organizationId, externalTeamId: `recovery_${crypto.randomUUID()}`, name: 'Recovery test',
    } })).id,
  }
  const tenant: Tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  if (organizationId === undefined) organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  await db.principalLastSeen.create({ data: {
    teamId: tenant.teamId, uoaUserId: ctx.actor.id, lastSeenAt: now,
  } })
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'human', id: ctx.actor.id, onBehalfOf: ctx.actor.id, requestId: ctx.requestId,
  }, 'standard_crm'))
  for (const action of ['view', 'create', 'edit', 'delete', 'restore', 'link'] as const) {
    await db.policyRule.create({ data: {
      ...tenant, scope: 'team', scopeId: tenant.teamId, resourceType: 'record', action,
      effect: 'allow', priority: 100, createdById: 'deleted-reads-fixture',
      bindings: { create: [{ actorType: 'role', actorId: 'owner' }] },
    } })
  }
  return tenant
}
export async function person(
  tenant: Tenant, name: string, options: { deleted?: boolean; private?: boolean; email?: string; visibleTo?: string[] } = {},
) {
  const ctx = context(tenant, options.private === true || options.visibleTo !== undefined ? 'other_owner' : undefined)
  const result = await createRecord(deps, ctx, {
    objectType: 'person', data: {
      name: { full: name }, title: 'Sensitive title',
      ...(options.email === undefined ? {} : { emails: [options.email] }),
    },
    ...(options.private === true ? { visibility: 'private' } : {}),
    ...(options.visibleTo === undefined ? {} : { visibleTo: options.visibleTo }),
  })
  if (options.deleted === true) await deleteRecord(deps, ctx, { recordId: result.record.id })
  return result.record.id
}
export async function viewRule(
  tenant: Tenant, resourceType: 'record' | 'attribute', scopeId: string,
  requiresApproval = false, scope: 'team' | 'record' = 'record',
) {
  await db.policyRule.create({ data: {
    ...tenant, scope, scopeId, resourceType, action: 'view', effect: 'deny',
    priority: 200, requiresApproval, createdById: 'deleted-reads-fixture',
    ...(resourceType === 'attribute' ? { conditions: { sensitivity: 'restricted' } } : {}),
    bindings: { create: [{ actorType: 'role', actorId: 'owner' }] },
  } })
}
/** Seed otherwise unrecoverable lifecycle states without exercising irreversible erase. */
export async function unavailable(tenant: Tenant, survivorId: string) {
  const erasedId = await person(tenant, 'Erased fixture', { deleted: true })
  const mergedId = await person(tenant, 'Merged fixture', { deleted: true })
  await db.record.update({ where: { id: erasedId }, data: { erasedAt: now, data: {} } })
  await db.record.update({ where: { id: mergedId }, data: { mergedIntoId: survivorId } })
  return { erasedId, mergedId }
}
