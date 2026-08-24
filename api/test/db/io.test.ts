import {
  createDb,
  dropTenant,
  Prisma,
  seedTenant,
  writeAudit,
  type Prisma as PrismaTypes,
} from '@deepcrm/db'
import { createProjectionLinkWriter, FakeEmbedder } from '@deepcrm/schema-engine'
import { parseSecretBox, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { changesSince } from '../../src/services/io.js'
import { seedDefaultPolicies } from '../../src/services/policy.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for change-feed tests')
const db = createDb(databaseUrl)
const organizationIds: string[] = []
const keyring = Buffer.from(JSON.stringify({
  active: 'feed-v1', keys: { 'feed-v1': Buffer.alloc(32, 41).toString('base64') },
}), 'utf8').toString('base64')
const secretBox = parseSecretBox(keyring)
const deps: AppDeps = {
  db,
  clock: () => new Date('2026-08-24T12:00:00.000Z'),
  ids: () => crypto.randomUUID(),
  version: '0.0.0',
  maxBulkRows: 10_000, maxExportRows: 100_000,
  orgAllowlist: null,
  linkWriter: createProjectionLinkWriter(),
  historyCursor: createHistoryCursorCodec(secretBox),
  queryCursor: createQueryCursorCodec(secretBox),
  secretBox,
  embedder: new FakeEmbedder('api-test'),
  writeAudit,
}

type Tenant = { organizationId: string; teamId: string }
type Fixture = {
  tenant: Tenant
  personTypeId: string
  companyTypeId: string
  personId: string
  companyId: string
  privateId: string
  relationTypeId: string
}

function context(tenant: Tenant, user = 'feed_user'): ActorContext {
  return {
    tenant,
    app: 'feed-test',
    actChain: [],
    actor: { type: 'human', id: user },
    onBehalfOf: { uoaUserId: user, role: 'member' },
    provenance: { runId: 'feed-run', toolCallId: 'feed-call', requestId: crypto.randomUUID() },
    requestId: crypto.randomUUID(),
    now: new Date('2026-08-24T12:00:00.000Z'),
  }
}

async function fixture(): Promise<Fixture> {
  const seeded = await seedTenant(db)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  organizationIds.push(tenant.organizationId)
  await db.$transaction((tx) => seedDefaultPolicies(tx, tenant))
  const personType = await db.objectType.create({ data: {
    ...tenant, slug: 'person', singularName: 'Person', pluralName: 'People',
    description: 'Feed person', kind: 'custom', createdByType: 'system', createdById: 'feed-test',
  } })
  const companyType = await db.objectType.create({ data: {
    ...tenant, slug: 'company', singularName: 'Company', pluralName: 'Companies',
    description: 'Feed company', kind: 'custom', createdByType: 'system', createdById: 'feed-test',
  } })
  await db.attribute.createMany({ data: [
    {
      ...tenant, objectTypeId: personType.id, slug: 'name', name: 'Name', description: 'Name',
      type: 'text', config: { maxLength: 120 }, sensitivity: 'public', position: 0,
    },
    {
      ...tenant, objectTypeId: personType.id, slug: 'secret', name: 'Secret',
      description: 'Restricted value', type: 'text', config: { maxLength: 120 },
      sensitivity: 'restricted', position: 1,
    },
    {
      ...tenant, objectTypeId: companyType.id, slug: 'name', name: 'Name', description: 'Name',
      type: 'text', config: { maxLength: 120 }, sensitivity: 'public', position: 0,
    },
  ] })
  const relation = await db.relationType.create({ data: {
    ...tenant, slug: 'person_works_at', fromObjectTypeId: personType.id,
    toObjectTypeId: companyType.id, forwardName: 'works at', inverseName: 'employs',
    description: 'Employment', cardinality: 'many_to_one', edgeAttributes: [],
  } })
  const records = await Promise.all([
    db.record.create({ data: {
      ...tenant, objectTypeId: personType.id, data: { name: 'Visible Person', secret: 'hidden' },
      displayName: 'Visible Person', visibility: 'team', createdOnBehalfOf: 'feed_user',
      createdByType: 'human', createdById: 'feed_user',
    } }),
    db.record.create({ data: {
      ...tenant, objectTypeId: companyType.id, data: { name: 'Visible Company' },
      displayName: 'Visible Company', visibility: 'team', createdOnBehalfOf: 'feed_user',
      createdByType: 'human', createdById: 'feed_user',
    } }),
    db.record.create({ data: {
      ...tenant, objectTypeId: companyType.id, data: { name: 'Private Company' },
      displayName: 'Private Company', visibility: 'private', createdOnBehalfOf: 'other_user',
      createdByType: 'human', createdById: 'other_user',
    } }),
  ])
  const person = records[0]
  const company = records[1]
  const privateRecord = records[2]
  if (person === undefined || company === undefined || privateRecord === undefined) {
    throw new Error('Feed fixture records are missing')
  }
  return {
    tenant, personTypeId: personType.id, companyTypeId: companyType.id,
    personId: person.id, companyId: company.id, privateId: privateRecord.id,
    relationTypeId: relation.id,
  }
}

function change(
  target: Fixture,
  seq: number,
  input: Partial<PrismaTypes.RecordChangeCreateManyInput> = {},
): PrismaTypes.RecordChangeCreateManyInput {
  return {
    ...target.tenant,
    recordId: target.personId,
    kind: 'set',
    attributeSlug: 'name',
    oldValue: Prisma.JsonNull,
    newValue: `value-${seq}`,
    snapshot: Prisma.JsonNull,
    actorType: 'human',
    actorId: 'feed_user',
    onBehalfOf: 'feed_user',
    runId: 'feed-run',
    toolCallId: 'feed-call',
    requestId: `feed-request-${seq}`,
    reason: null,
    resultingVersion: seq,
    seq: BigInt(seq),
    occurredAt: new Date(1_700_000_000_000 + seq),
    ...input,
  }
}

async function storeChanges(target: Fixture, rows: PrismaTypes.RecordChangeCreateManyInput[]): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.recordChange.createMany({ data: rows })
    await tx.team.update({ where: { id: target.tenant.teamId }, data: { feedSeq: BigInt(rows.length) } })
  })
}

afterAll(async () => {
  for (const organizationId of organizationIds) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('change feed', () => {
  it('starts at the current committed sequence when no cursor is supplied', async () => {
    const target = await fixture()
    await storeChanges(target, [change(target, 1), change(target, 2), change(target, 3)])
    await expect(changesSince(deps, context(target.tenant), {})).resolves.toEqual({
      changes: [], next_cursor: '3', has_more: false,
    })
  })

  it('walks 120 retained changes exactly once, including paired link rows', async () => {
    const target = await fixture()
    const groupId = crypto.randomUUID()
    const linkId = crypto.randomUUID()
    const linkValue = {
      from_record_id: target.personId, to_record_id: target.companyId, data: {}, position: null,
    }
    const rows = Array.from({ length: 118 }, (_, index) => change(target, index + 1))
    rows.push(change(target, 119, {
      recordId: target.personId, kind: 'link', attributeSlug: null,
      relationTypeId: target.relationTypeId, linkId, groupId, newValue: linkValue,
    }))
    rows.push(change(target, 120, {
      recordId: target.companyId, kind: 'link', attributeSlug: null,
      relationTypeId: target.relationTypeId, linkId, groupId, newValue: linkValue,
    }))
    await storeChanges(target, rows)

    const seen = []
    let cursorValue: string | undefined
    let first = true
    for (;;) {
      const page = await changesSince(deps, context(target.tenant), {
        ...(first ? { from: 'beginning' as const } : { cursor: cursorValue }), limit: 17,
      })
      first = false
      seen.push(...page.changes)
      cursorValue = page.next_cursor
      if (!page.has_more) break
    }
    expect(seen).toHaveLength(120)
    expect(new Set(seen.map((item) => item.seq)).size).toBe(120)
    expect(seen.map((item) => item.seq)).toEqual(
      Array.from({ length: 120 }, (_, index) => String(index + 1)),
    )
    const paired = seen.filter((item) => item.group_id === groupId)
    expect(paired).toHaveLength(2)
    expect(paired.map((item) => item.record?.id).sort())
      .toEqual([target.personId, target.companyId].sort())
    expect(paired.every((item) => item.event === 'link.created')).toBe(true)
  })

  it('filters before paging and redacts current sensitivity without leaking hidden link endpoints', async () => {
    const target = await fixture()
    const hiddenLink = {
      from_record_id: target.personId, to_record_id: target.privateId, data: {}, position: null,
    }
    await storeChanges(target, [
      change(target, 1, { newValue: 'public value' }),
      change(target, 2, { attributeSlug: 'secret', newValue: 'restricted value' }),
      change(target, 3, { recordId: target.privateId, newValue: 'private value' }),
      change(target, 4, {
        kind: 'link', attributeSlug: null, relationTypeId: target.relationTypeId,
        linkId: crypto.randomUUID(), groupId: crypto.randomUUID(), newValue: hiddenLink,
      }),
      change(target, 5, {
        kind: 'schema_change', recordId: null, attributeSlug: 'person',
        newValue: { object_type: 'person', schema_version: 2 }, resultingVersion: 2,
      }),
    ])
    const result = await changesSince(deps, context(target.tenant), {
      from: 'beginning', objectTypes: ['person'], limit: 20,
    })
    expect(result.has_more).toBe(false)
    expect(result.changes.map((item) => item.seq)).toEqual(['1', '2', '5'])
    expect(result.changes[0]).toMatchObject({ new_value: 'public value', event: 'record.updated' })
    expect(result.changes[1]).not.toHaveProperty('new_value')
    expect(result.changes[2]).toMatchObject({ event: 'schema.changed', kind: 'schema', record: null })
    await expect(changesSince(deps, context(target.tenant), {
      cursor: '1', from: 'beginning',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})
