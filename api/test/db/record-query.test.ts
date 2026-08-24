import { canonicalJson, createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { applyTemplate, createProjectionLinkWriter, FakeEmbedder } from '@deepcrm/schema-engine'
import { parseSecretBox, ServiceError, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { queryRecords } from '../../src/services/record-query.js'
import {
  createQueryCursorCodec,
  type QueryCursorBinding,
} from '../../src/services/query-cursor.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for query tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')
const localKey = Buffer.alloc(32, 1).toString('base64')

function keyring(active: string, keys: Record<string, string>): string {
  return Buffer.from(JSON.stringify({ active, keys }), 'utf8').toString('base64')
}

const cursor = createQueryCursorCodec(parseSecretBox(keyring('test-v1', { 'test-v1': localKey })))
const deps: AppDeps = {
  db,
  clock: () => now,
  ids: () => crypto.randomUUID(),
  version: '0.0.0',
  maxBulkRows: 10_000, maxExportRows: 100_000,
  orgAllowlist: null,
  linkWriter: createProjectionLinkWriter(),
  historyCursor: createHistoryCursorCodec(
    parseSecretBox(keyring('test-v1', { 'test-v1': localKey })),
  ),
  queryCursor: cursor,
  secretBox: parseSecretBox(keyring('test-v1', { 'test-v1': localKey })),
  embedder: new FakeEmbedder('api-test'),
  writeAudit,
}

type Tenant = { organizationId: string; teamId: string }
type Fixture = Tenant & { personIds: string[]; companyId: string }

function context(tenant: Tenant, userId = 'query_user'): ActorContext {
  return {
    tenant,
    app: 'test',
    actChain: [],
    actor: { type: 'human', id: userId },
    onBehalfOf: { uoaUserId: userId, role: 'member' },
    provenance: { runId: 'query_run', toolCallId: 'query_call', requestId: crypto.randomUUID() },
    requestId: crypto.randomUUID(),
    now,
  }
}

async function fixture(personCount = 3): Promise<Fixture> {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'query_fixture', onBehalfOf: ctx.onBehalfOf.uoaUserId,
    requestId: ctx.requestId,
  }, 'standard_crm'))
  const [personType, companyType, relation] = await Promise.all([
    db.objectType.findFirstOrThrow({ where: { organizationId: tenant.organizationId, teamId: tenant.teamId, slug: 'person' } }),
    db.objectType.findFirstOrThrow({ where: { organizationId: tenant.organizationId, teamId: tenant.teamId, slug: 'company' } }),
    db.relationType.findFirstOrThrow({ where: { organizationId: tenant.organizationId, teamId: tenant.teamId, slug: 'person_works_at' } }),
  ])
  const company = await db.record.create({
    data: {
      organizationId: tenant.organizationId, teamId: tenant.teamId,
      objectTypeId: companyType.id, data: { name: 'Acme' }, displayName: 'Acme',
      visibility: 'team', origin: 'import', createdOnBehalfOf: 'query_user',
      createdByType: 'human', createdById: 'query_user', createdAt: now, updatedAt: now,
    },
  })
  const people = []
  for (let index = 0; index < personCount; index += 1) {
    people.push(await db.record.create({
      data: {
        organizationId: tenant.organizationId, teamId: tenant.teamId,
        objectTypeId: personType.id,
        data: {
          name: { given: `Person${index}`, family: 'Query' },
          title: `Title ${index}`,
          phones: [`+4420712345${String(index).padStart(2, '0')}`],
        },
        displayName: `Person${index} Query`, visibility: 'team', origin: 'manual',
        ownerType: 'human', ownerId: 'query_user', createdOnBehalfOf: 'query_user',
        createdByType: 'human', createdById: 'query_user',
        createdAt: new Date(now.getTime() + index), updatedAt: now,
      },
    }))
  }
  await db.recordLink.create({
    data: {
      organizationId: tenant.organizationId, teamId: tenant.teamId,
      relationTypeId: relation.id, fromRecordId: people[0]!.id, toRecordId: company.id,
      position: null, data: {}, activeFrom: now,
      createdByType: 'system', createdById: 'query_fixture',
    },
  })
  return { ...tenant, personIds: people.map((person) => person.id), companyId: company.id }
}

async function addPhoneDeny(target: Tenant): Promise<void> {
  await db.policyRule.create({
    data: {
      organizationId: target.organizationId, teamId: target.teamId,
      scope: 'team', scopeId: target.teamId, resourceType: 'attribute', action: 'view',
      effect: 'deny', priority: 100, conditions: { sensitivity: 'confidential' },
      createdById: 'query_fixture',
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
  throw new Error('Expected query to fail')
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizations } } })
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('record query service', () => {
  it('pages hydrated records, returns optional total, and applies projection and redaction', async () => {
    const target = await fixture()
    await addPhoneDeny(target)
    await db.record.update({
      where: { id: target.personIds[1] },
      data: { ownerType: 'system', ownerId: 'system' },
    })
    const ctx = context(target)
    const input = {
      objectType: 'person', attributes: ['name', 'company', 'phones'],
      includeTotal: true, limit: 2,
    }
    const first = await queryRecords(deps, ctx, input)
    expect(first.records).toHaveLength(2)
    expect(first.total).toBe(3)
    expect(first.next_cursor).not.toBeNull()
    expect(first.records.every((record) => (
      record.redacted_attributes.includes('phones') && !Object.hasOwn(record.data, 'phones')
    ))).toBe(true)
    const projected = first.records.find((record) => record.id === target.personIds[0])
    if (projected !== undefined) expect(projected.data['company']).toBe(target.companyId)
    expect(first.records[0]).toMatchObject({
      object_type: 'person', visibility: 'team', origin: 'manual',
      owner: { type: 'human', id: 'query_user' },
    })

    if (first.next_cursor === null) throw new Error('Expected a second page')
    const second = await queryRecords(deps, ctx, { ...input, cursor: first.next_cursor })
    expect(second.records).toHaveLength(1)
    const combined = [...first.records, ...second.records]
    expect(new Set(combined.map((record) => record.id)).size).toBe(3)
    expect(combined.find((record) => record.id === target.personIds[0])?.data['company'])
      .toBe(target.companyId)
    expect(combined.find((record) => record.id === target.personIds[1])?.owner).toBeNull()

    const empty = await queryRecords(deps, ctx, {
      objectType: 'person',
      filter: { attribute: 'title', op: 'eq', value: 'does not exist' },
      includeTotal: true,
    })
    expect(empty).toMatchObject({ records: [], next_cursor: null, total: 0 })
  })

  it('binds opaque cursors to every query argument and accepts retained rotation keys', async () => {
    const target = await fixture(2)
    const ctx = context(target)
    const first = await queryRecords(deps, ctx, { objectType: 'person', limit: 1 })
    expect(Object.hasOwn(first, 'total')).toBe(false)
    if (first.next_cursor === null) throw new Error('Expected a cursor')
    const mismatch = await caught(queryRecords(deps, ctx, {
      objectType: 'person', limit: 2, cursor: first.next_cursor,
    }))
    expect(mismatch).toMatchObject({ code: 'VALIDATION_FAILED', details: { detail: 'cursor_mismatch' } })
    const replacement = first.next_cursor.endsWith('A') ? 'B' : 'A'
    const tampered = `${first.next_cursor.slice(0, -1)}${replacement}`
    const tamperedError = await caught(queryRecords(deps, ctx, {
      objectType: 'person', limit: 1, cursor: tampered,
    }))
    expect(tamperedError).toMatchObject({ code: 'VALIDATION_FAILED', details: { detail: 'cursor_mismatch' } })

    const oldKey = Buffer.alloc(32, 2).toString('base64')
    const newKey = Buffer.alloc(32, 3).toString('base64')
    const oldBox = parseSecretBox(keyring('old', { old: oldKey }))
    const oldCodec = createQueryCursorCodec(oldBox)
    const rotated = createQueryCursorCodec(parseSecretBox(keyring('new', { old: oldKey, new: newKey })))
    const binding: QueryCursorBinding = {
      tool: 'crm_records_query', tenant: target,
      arguments: {
        object_type: 'person', filter: null,
        sort: [{ system: 'created_at', direction: 'desc' }],
        attributes: null, include_total: false, limit: 1,
      },
    }
    const state = { values: [{ isNull: false, value: 'value' }], id: target.personIds[0]! }
    const oldEnvelope = oldCodec.seal(state, binding)
    expect(rotated.open(oldEnvelope, binding)).toEqual(state)
    const encoder = new TextEncoder()
    const invalidTuple = oldBox.seal(
      encoder.encode(JSON.stringify({ values: [{ isNull: 'false', value: 'value' }], id: state.id })),
      'deepcrm.query-cursor.v1',
      encoder.encode(canonicalJson({
        format: 'deepcrm.query-cursor.v1',
        tool: binding.tool,
        tenant: binding.tenant,
        arguments: binding.arguments,
      })),
    )
    expect(() => oldCodec.open(invalidTuple, binding)).toThrowError(ServiceError)
    const mismatches: QueryCursorBinding[] = [
      { ...binding, tool: 'crm_records_count' },
      { ...binding, tenant: { ...binding.tenant, teamId: crypto.randomUUID() } },
      { ...binding, arguments: { ...binding.arguments, object_type: 'company' } },
      { ...binding, arguments: { ...binding.arguments, filter: { text: 'changed' } } },
      { ...binding, arguments: { ...binding.arguments, sort: [{ system: 'updated_at', direction: 'desc' }] } },
      { ...binding, arguments: { ...binding.arguments, attributes: ['name'] } },
      { ...binding, arguments: { ...binding.arguments, include_total: true } },
      { ...binding, arguments: { ...binding.arguments, limit: 2 } },
    ]
    for (const changed of mismatches) {
      expect(() => rotated.open(oldEnvelope, changed)).toThrowError(ServiceError)
      try {
        rotated.open(oldEnvelope, changed)
      } catch (error) {
        expect(error).toMatchObject({
          code: 'VALIDATION_FAILED', details: { detail: 'cursor_mismatch' },
        })
      }
    }
    const unknownKey = createQueryCursorCodec(parseSecretBox(keyring('new', { new: newKey })))
    expect(() => unknownKey.open(oldEnvelope, binding)).toThrowError(ServiceError)
    try {
      unknownKey.open(oldEnvelope, binding)
    } catch (error) {
      expect(error).toMatchObject({
        code: 'VALIDATION_FAILED', details: { detail: 'cursor_mismatch' },
      })
    }
  })

  it('loads policy rules once per page regardless of row count', async () => {
    const target = await fixture(12)
    let policyLoads = 0
    let linkLoads = 0
    const tracedDb = db.$extends({
      query: {
        policyRule: { async findMany({ args, query }) {
          policyLoads += 1
          return query(args)
        } },
        recordLink: { async findMany({ args, query }) {
          linkLoads += 1
          return query(args)
        } },
      },
    })
    const tracedDeps: AppDeps = { ...deps, db: tracedDb }
    await queryRecords(tracedDeps, context(target), {
      objectType: 'person', attributes: ['name'], limit: 1,
    })
    expect(policyLoads).toBe(1)
    expect(linkLoads).toBe(1)
    await queryRecords(tracedDeps, context(target), {
      objectType: 'person', attributes: ['company', 'emails', 'name', 'phones', 'title'], limit: 12,
    })
    expect(policyLoads).toBe(2)
    expect(linkLoads).toBe(2)
  })
})
