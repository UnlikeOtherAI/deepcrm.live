import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { applyTemplate, createProjectionLinkWriter, FakeEmbedder } from '@deepcrm/schema-engine'
import {
  CrmIntakeSubmit, parseSecretBox, ServiceError, type ActorContext, type CrmIntakeSubmitInput,
} from '@deepcrm/schemas'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { seedDefaultPolicies } from '../../src/services/policy.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import { testFileAccess } from '../file-access-fixture.js'

/** Shared set-up for the intake and proposal suites: one tenant per test, a subject and a person. */
export function intakeFixture() {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for intake tests')
  const db = createDb(databaseUrl)
  const organizations = new Set<string>()
  const now = new Date('2026-10-19T12:00:00.000Z')
  const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSJ9fQ=='
  const deps: AppDeps = {
    db,
    clock: () => now,
    ids: () => crypto.randomUUID(),
    version: '0.0.0',
    maxBulkRows: 10_000,
    maxExportRows: 100_000,
    embedder: new FakeEmbedder('api-test'),
    orgAllowlist: null,
    linkWriter: createProjectionLinkWriter(),
    historyCursor: createHistoryCursorCodec(parseSecretBox(keyring)),
    queryCursor: createQueryCursorCodec(parseSecretBox(keyring)),
    secretBox: parseSecretBox(keyring),
    fileAccess: testFileAccess,
    writeAudit,
  }
  type Tenant = { organizationId: string; teamId: string }
  const base = (tenant: Tenant) => ({ tenant, app: 'nessie', actChain: [], requestId: crypto.randomUUID(), now })
  const subject = (tenant: Tenant): ActorContext => ({
    ...base(tenant), actor: { type: 'system', id: 'subject:nessie' }, onBehalfOf: null, provenance: null,
  })
  const person = (tenant: Tenant, role: 'member' | 'admin' | 'owner' = 'admin', id = 'uoa_admin'): ActorContext => ({
    ...base(tenant), actor: { type: 'human', id }, onBehalfOf: { uoaUserId: id, role }, provenance: null,
  })
  async function tenant(): Promise<Tenant> {
    const created = await seedTenant(db)
    organizations.add(created.organizationId)
    const target = { organizationId: created.organizationId, teamId: created.teamId }
    const actor = { type: 'system' as const, id: 'intake-test', onBehalfOf: null, requestId: 'intake-test' }
    await db.$transaction(async (tx) => {
      await seedDefaultPolicies(tx, target)
      await applyTemplate(tx, target, actor, 'system')
      await applyTemplate(tx, target, actor, 'standard_crm')
    }, { timeout: 60_000 })
    return target
  }
  async function caught(operation: Promise<unknown>): Promise<ServiceError> {
    try {
      await operation
    } catch (error) {
      if (error instanceof ServiceError) return error
      throw error
    }
    throw new Error('Expected the operation to fail')
  }
  /** A submission as the tool parses it. */
  function submission(input: Record<string, unknown>): CrmIntakeSubmitInput {
    return CrmIntakeSubmit.in.parse({
      source: { kind: 'contact_form', id: 'form_spring', name: 'Spring newsletter form' },
      activity: { kind: 'message', occurred_at: '2026-10-19T11:00:00Z', subject: 'Contact form: Spring' },
      ...input,
    })
  }
  async function cleanup(): Promise<void> {
    for (const organizationId of organizations) await dropTenant(db, organizationId)
    await db.$disconnect()
  }
  async function personData(target: Tenant, id: string): Promise<Record<string, unknown>> {
    const row = await db.record.findFirstOrThrow({ where: { ...target, id }, select: { data: true } })
    const data = row.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('record data is not an object')
    return data
  }
  async function activitiesAbout(target: Tenant, id: string) {
    return db.record.findMany({
      where: { ...target, linksFrom: { some: { toRecordId: id, activeUntil: null } } },
      select: { id: true, data: true, createdById: true, origin: true, objectType: { select: { slug: true } } },
      orderBy: { createdAt: 'asc' },
    })
  }
  return { db, deps, now, subject, person, tenant, caught, submission, cleanup, personData, activitiesAbout }
}
