import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { applyTemplate, createProjectionLinkWriter, FakeEmbedder } from '@deepcrm/schema-engine'
import { parseSecretBox, ServiceError, type ActorContext, type CrmConsentSetInput } from '@deepcrm/schemas'
import { afterAll, describe, expect, it, vi } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { addSuppression } from '../../src/services/compliance.js'
import { getConsent, setConsent } from '../../src/services/consent.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { seedDefaultPolicies } from '../../src/services/policy.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import { testFileAccess } from '../file-access-fixture.js'

// Postgres-backed writes on a shared, loaded host take seconds each.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for consent tests')

const db = createDb(databaseUrl)
const organizations = new Set<string>()
const now = new Date('2026-10-16T12:00:00.000Z')
const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSJ9fQ=='
type Tenant = { organizationId: string; teamId: string }

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

function base(tenant: Tenant) {
  return { tenant, app: 'nessie', actChain: [], requestId: crypto.randomUUID(), now }
}

function person(tenant: Tenant): ActorContext {
  return {
    ...base(tenant), actor: { type: 'human', id: 'uoa_member' },
    onBehalfOf: { uoaUserId: 'uoa_member', role: 'member' }, provenance: null,
  }
}

function agent(tenant: Tenant): ActorContext {
  return {
    ...base(tenant), actor: { type: 'agent', id: 'agent_newsletter' },
    onBehalfOf: { uoaUserId: 'uoa_member', role: 'member' },
    provenance: { runId: 'run_1', toolCallId: 'call_1', requestId: crypto.randomUUID() },
  }
}

function subject(tenant: Tenant): ActorContext {
  return { ...base(tenant), actor: { type: 'system', id: 'subject:nessie' }, onBehalfOf: null, provenance: null }
}

async function tenant(options: { consentAttributes: boolean } = { consentAttributes: true }): Promise<Tenant> {
  const created = await seedTenant(db)
  organizations.add(created.organizationId)
  const target = { organizationId: created.organizationId, teamId: created.teamId }
  const actor = { type: 'system' as const, id: 'consent-test', onBehalfOf: null, requestId: 'consent-test' }
  await db.$transaction(async (tx) => {
    await seedDefaultPolicies(tx, target)
    await applyTemplate(tx, target, actor, 'standard_crm')
  })
  if (!options.consentAttributes) {
    // A tenant provisioned before the consent attributes existed.
    await db.attribute.deleteMany({
      where: { ...target, slug: { in: ['marketing_consent', 'marketing_consent_at', 'marketing_consent_source'] } },
    })
    await db.team.updateMany({ where: { id: target.teamId }, data: { schemaVersion: { increment: 1 } } })
  }
  return target
}

async function caught(operation: Promise<unknown>): Promise<ServiceError> {
  try {
    await operation
  } catch (error) {
    if (error instanceof ServiceError) return error
    throw error
  }
  throw new Error('Expected the consent operation to fail')
}

function set(input: Partial<CrmConsentSetInput> & Pick<CrmConsentSetInput, 'state' | 'source'>): CrmConsentSetInput {
  return { email: 'ada@example.com', ...input }
}

async function optOuts(target: Tenant): Promise<Array<{ channel: string; reason: string; subReason: string | null }>> {
  return db.suppressionEntry.findMany({
    where: { ...target, kind: 'email' }, select: { channel: true, reason: true, subReason: true },
    orderBy: { channel: 'asc' },
  })
}

const create = { data: { name: { full: 'Ada Lovelace' } } }

afterAll(async () => {
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('marketing consent service', () => {
  it('creates the person only when asked, then matches the normalised email', async () => {
    const target = await tenant()
    const ctx = subject(target)
    await expect(setConsent(deps, ctx, set({ state: 'not_confirmed', source: 'signup_form' }))).resolves.toEqual({
      record_id: null, created: false, state: 'not_confirmed', previous_state: null,
      at: now.toISOString(), suppressed: false,
    })
    expect(await db.record.count({ where: target })).toBe(0)

    const created = await setConsent(deps, ctx, set({
      email: 'Ada <ADA@Example.COM>', state: 'not_confirmed', source: 'signup_form',
      at: '2026-10-16T10:00:00Z', create,
    }))
    expect(created).toMatchObject({ created: true, state: 'not_confirmed', previous_state: null })
    const record = await db.record.findFirstOrThrow({ where: { ...target, id: created.record_id ?? '' } })
    expect(record.data).toMatchObject({
      name: { full: 'Ada Lovelace' }, emails: ['ada@example.com'], marketing_consent: 'not_confirmed',
      marketing_consent_at: '2026-10-16T10:00:00.000Z', marketing_consent_source: 'signup_form',
    })
    expect(record.createdByType).toBe('system')
    expect(record.createdById).toBe('subject:nessie')

    const confirmed = await setConsent(deps, ctx, set({
      state: 'confirmed', source: 'signup_form', at: '2026-10-16T10:05:00Z', create,
    }))
    expect(confirmed).toEqual({
      record_id: created.record_id, created: false, state: 'confirmed', previous_state: 'not_confirmed',
      at: '2026-10-16T10:05:00.000Z', suppressed: false,
    })
    await expect(getConsent(deps, person(target), { email: 'ada@example.com' })).resolves.toEqual({
      record_id: created.record_id, state: 'confirmed', at: '2026-10-16T10:05:00.000Z',
      source: 'signup_form', suppressed: false,
    })
    const audits = await db.auditLog.findMany({ where: { ...target, action: 'crm_consent_set' } })
    expect(audits).toHaveLength(2)
    expect(audits.every((row) => row.actorId === 'subject:nessie' && row.onBehalfOf === null)).toBe(true)
  })

  it('suppresses on declined and lifts only its own opt-out on confirmed', async () => {
    const target = await tenant()
    const ctx = subject(target)
    await setConsent(deps, ctx, set({ state: 'confirmed', source: 'signup_form', at: '2026-10-16T09:00:00Z', create }))
    await addSuppression(deps, person(target), {
      kind: 'email', value: 'ada@example.com', channel: 'all', reason: 'objection', sub_reason: 'complaint',
    })
    const declined = await setConsent(deps, ctx, set({
      state: 'declined', source: 'unsubscribe', at: '2026-10-16T09:10:00Z',
    }))
    expect(declined).toMatchObject({ state: 'declined', previous_state: 'confirmed', suppressed: true })
    expect(await optOuts(target)).toEqual([
      { channel: 'all', reason: 'objection', subReason: 'complaint' },
      { channel: 'email', reason: 'objection', subReason: 'opt_out' },
    ])
    const entry = await db.suppressionEntry.findFirstOrThrow({ where: { ...target, channel: 'email' } })
    expect(entry.sourceRecordId).toBe(declined.record_id)

    await setConsent(deps, ctx, set({ state: 'confirmed', source: 'resubscribe', at: '2026-10-16T09:20:00Z' }))
    expect(await optOuts(target)).toEqual([{ channel: 'all', reason: 'objection', subReason: 'complaint' }])
  })

  it('walks every transition and lets the newer act win', async () => {
    const target = await tenant()
    const ctx = person(target)
    const steps: Array<[CrmConsentSetInput['state'], string]> = [
      ['not_confirmed', '2026-10-16T08:00:00Z'], ['confirmed', '2026-10-16T08:01:00Z'],
      ['declined', '2026-10-16T08:02:00Z'], ['not_confirmed', '2026-10-16T08:03:00Z'],
      ['declined', '2026-10-16T08:04:00Z'], ['confirmed', '2026-10-16T08:05:00Z'],
      ['not_confirmed', '2026-10-16T08:06:00Z'],
    ]
    let previous: string | null = null
    for (const [index, [state, at]] of steps.entries()) {
      const result = await setConsent(deps, ctx, set({
        state, source: 'manual', at, reason: 'Recorded by phone', ...(index === 0 ? { create } : {}),
      }))
      expect(result, `${previous ?? 'none'} → ${state}`).toMatchObject({ state, previous_state: previous })
      expect(result.suppressed).toBe(state === 'declined')
      previous = state
    }
    const stale = await setConsent(deps, ctx, set({ state: 'declined', source: 'unsubscribe', at: '2026-10-16T07:00:00Z' }))
    expect(stale).toMatchObject({ state: 'not_confirmed', previous_state: 'not_confirmed', at: '2026-10-16T08:06:00.000Z' })
    const repeated = await setConsent(deps, ctx, set({
      state: 'not_confirmed', source: 'manual', at: '2026-10-16T08:06:00Z',
    }))
    expect(repeated.previous_state).toBe('not_confirmed')
    expect(await db.auditLog.count({ where: { ...target, action: 'crm_consent_set' } })).toBe(steps.length)
  })

  it('ignores an older act that arrives after a newer one, and an equal one', async () => {
    const target = await tenant()
    const ctx = subject(target)
    await setConsent(deps, ctx, set({ state: 'confirmed', source: 'signup_form', at: '2026-10-16T11:00:00Z', create }))
    const late = await setConsent(deps, ctx, set({ state: 'declined', source: 'unsubscribe', at: '2026-10-16T10:59:59Z' }))
    expect(late).toMatchObject({
      state: 'confirmed', previous_state: 'confirmed', at: '2026-10-16T11:00:00.000Z', suppressed: false,
    })
    const tie = await setConsent(deps, ctx, set({ state: 'declined', source: 'unsubscribe', at: '2026-10-16T11:00:00Z' }))
    expect(tie).toMatchObject({ state: 'confirmed', suppressed: false })
    expect(await optOuts(target)).toEqual([])
    expect(await db.auditLog.count({ where: { ...target, action: 'crm_consent_set' } })).toBe(1)
  })

  it('takes the named object type and an email standing in for the name', async () => {
    const target = await tenant()
    const created = await setConsent(deps, subject(target), set({
      email: 'no-name@example.com', state: 'not_confirmed', source: 'signup_form', object_type: 'person',
      create: { data: { name: { full: 'no-name@example.com' }, emails: ['no-name@example.com'] } },
    }))
    expect(created).toMatchObject({ created: true, state: 'not_confirmed' })
    const record = await db.record.findFirstOrThrow({ where: { ...target, id: created.record_id ?? '' } })
    expect(record.displayName).toBe('no-name@example.com')
    expect(record.data).toMatchObject({ emails: ['no-name@example.com'] })
  })

  it('never lets an unverified signup undo a decline or lift its opt-out', async () => {
    const target = await tenant()
    const ctx = subject(target)
    await setConsent(deps, ctx, set({ state: 'declined', source: 'unsubscribe', at: '2026-10-16T09:00:00Z', create }))
    const signup = await setConsent(deps, ctx, set({
      state: 'not_confirmed', source: 'signup_form', at: '2026-10-16T09:30:00Z',
    }))
    expect(signup).toMatchObject({ state: 'declined', previous_state: 'declined', suppressed: true })
    const confirmed = await setConsent(deps, ctx, set({ state: 'confirmed', source: 'signup_form', at: '2026-10-16T09:31:00Z' }))
    expect(confirmed).toMatchObject({ state: 'confirmed', previous_state: 'declined', suppressed: false })
  })

  it('defines the consent attributes on a tenant that lacks them, once', async () => {
    const target = await tenant({ consentAttributes: false })
    const before = await db.team.findFirstOrThrow({ where: { id: target.teamId } })
    await setConsent(deps, subject(target), set({ state: 'confirmed', source: 'import', create }))
    const attributes = await db.attribute.findMany({
      where: { ...target, slug: { startsWith: 'marketing_consent' } }, select: { slug: true, isSystem: true },
      orderBy: { slug: 'asc' },
    })
    expect(attributes).toEqual([
      { slug: 'marketing_consent', isSystem: true }, { slug: 'marketing_consent_at', isSystem: true },
      { slug: 'marketing_consent_source', isSystem: true },
    ])
    const after = await db.team.findFirstOrThrow({ where: { id: target.teamId } })
    expect(after.schemaVersion).toBe(before.schemaVersion + 1)
    await getConsent(deps, person(target), { email: 'ada@example.com' })
    expect(await db.auditLog.count({ where: { ...target, action: 'schema.consent_attributes.ensure' } })).toBe(1)
  })

  it('lets an agent record only declined and a person confirm only with a reason', async () => {
    const target = await tenant()
    await expect(caught(setConsent(deps, agent(target), set({ state: 'confirmed', source: 'manual', create }))))
      .resolves.toMatchObject({ code: 'POLICY_DENIED' })
    await expect(caught(setConsent(deps, person(target), set({ state: 'confirmed', source: 'manual', create }))))
      .resolves.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(setConsent(deps, agent(target), set({ state: 'declined', source: 'manual', create })))
      .resolves.toMatchObject({ created: true, state: 'declined', suppressed: true })
    expect(await db.auditLog.count({ where: { ...target, action: 'crm_consent_set', outcome: 'denied' } })).toBe(1)
  })

  it('replays an idempotent write and refuses consent fields inside create.data', async () => {
    const target = await tenant()
    const input = set({ state: 'confirmed', source: 'signup_form', create, idempotency_key: 'signup-0001-confirm' })
    const first = await setConsent(deps, subject(target), input)
    await expect(setConsent(deps, subject(target), input)).resolves.toEqual(first)
    await expect(caught(setConsent(deps, subject(target), { ...input, state: 'declined' })))
      .resolves.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
    await expect(caught(setConsent(deps, subject(target), set({
      email: 'grace@example.com', state: 'confirmed', source: 'signup_form',
      create: { data: { name: { full: 'Grace' }, marketing_consent: 'confirmed' } },
    })))).resolves.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('refuses an invalid email and reads an unknown email as no record', async () => {
    const target = await tenant()
    await expect(caught(setConsent(deps, subject(target), set({
      email: 'not an email', state: 'declined', source: 'unsubscribe',
    })))).resolves.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(getConsent(deps, subject(target), { email: 'nobody@example.com' })).resolves.toEqual({
      record_id: null, state: null, at: null, source: null, suppressed: false,
    })
  })
})
