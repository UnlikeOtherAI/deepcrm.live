import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import {
  applyTemplate,
  createProjectionLinkWriter,
  FakeEmbedder,
  loadSchema,
} from '@deepcrm/schema-engine'
import { parseSecretBox, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import { searchRecords } from '../../src/services/search.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for search tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')
const secretBox = parseSecretBox(Buffer.from(JSON.stringify({
  active: 'search-v1', keys: { 'search-v1': Buffer.alloc(32, 35).toString('base64') },
}), 'utf8').toString('base64'))
const embedder = new FakeEmbedder('search-test-v1')
const deps: AppDeps = {
  db,
  clock: () => now,
  ids: () => crypto.randomUUID(),
  version: '0.0.0',
  maxBulkRows: 10_000,
  orgAllowlist: null,
  linkWriter: createProjectionLinkWriter(),
  historyCursor: createHistoryCursorCodec(secretBox),
  queryCursor: createQueryCursorCodec(secretBox),
  secretBox,
  embedder,
  writeAudit,
}

type Tenant = { organizationId: string; teamId: string }

function context(tenant: Tenant): ActorContext {
  return {
    tenant,
    app: 'search-test',
    actChain: [],
    actor: { type: 'human', id: 'search_user' },
    onBehalfOf: { uoaUserId: 'search_user', role: 'member' },
    provenance: null,
    requestId: crypto.randomUUID(),
    now,
  }
}

async function tenant(): Promise<Tenant> {
  const seeded = await seedTenant(db)
  organizations.push(seeded.organizationId)
  const value = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  const actor = {
    type: 'system' as const, id: 'search-fixture', onBehalfOf: null, requestId: crypto.randomUUID(),
  }
  await db.$transaction(async (tx) => {
    await applyTemplate(tx, value, actor, 'system')
    await applyTemplate(tx, value, actor, 'standard_crm')
  })
  return value
}

async function company(target: Tenant, name: string, content: string, vector?: readonly number[]) {
  const schema = await loadSchema(db, target)
  const objectType = schema.objectTypesBySlug.get('company')
  if (objectType === undefined) throw new Error('Company object type missing')
  const record = await db.record.create({ data: {
    ...target,
    objectTypeId: objectType.id,
    data: { name, domain: content },
    displayName: name,
    visibility: 'team',
    createdOnBehalfOf: 'search_user',
    createdByType: 'human',
    createdById: 'search_user',
  } })
  await db.recordSearch.create({ data: {
    recordId: record.id,
    ...target,
    objectTypeId: objectType.id,
    content,
    embeddingModel: vector === undefined ? null : embedder.model,
  } })
  if (vector !== undefined) {
    const encoded = `[${vector.join(',')}]`
    await db.$executeRaw`UPDATE record_search SET embedding = ${encoded}::vector
      WHERE record_id = ${record.id}::uuid AND organization_id = ${target.organizationId}::uuid
        AND team_id = ${target.teamId}::uuid`
  }
  return record
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizations } } })
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('search service', () => {
  it('finds a company domain token without crossing the tenant boundary', async () => {
    const first = await tenant()
    const second = await tenant()
    const visible = await company(first, 'Acme', 'Acme acme.example')
    const deleted = await company(first, 'Deleted Acme', 'Acme acme.example')
    const merged = await company(first, 'Merged Acme', 'Acme acme.example')
    await db.record.update({ where: { id: deleted.id }, data: { deletedAt: now } })
    await db.record.update({
      where: { id: merged.id },
      data: { deletedAt: now, mergedIntoId: visible.id },
    })
    await company(second, 'Foreign Acme', 'Acme acme.example')

    const result = await searchRecords(deps, context(first), {
      query: 'acme.example', objectTypes: ['company'], mode: 'keyword', limit: 10,
    })
    expect(result.hits).toEqual([{
      record: { id: visible.id, object_type: 'company', display_name: 'Acme' },
      score: expect.any(Number),
      match: 'keyword',
    }])
  })

  it('hybrid search returns the stable union of keyword and semantic legs', async () => {
    const target = await tenant()
    const query = 'analytical.example'
    const queryVector = (await embedder.embed([query]))[0]
    if (queryVector === undefined) throw new Error('Fake embedding missing')
    const keyword = await company(target, 'Analytical Engines', `Domain ${query}`)
    const semantic = await company(target, 'Semantic Neighbour', 'different lexical content', queryVector)

    const result = await searchRecords(deps, context(target), {
      query, objectTypes: ['company'], mode: 'hybrid', limit: 10,
    })
    expect(new Set(result.hits.map((hit) => hit.record.id))).toEqual(new Set([keyword.id, semantic.id]))
    expect(result.hits.find((hit) => hit.record.id === keyword.id)?.match).toBe('keyword')
    expect(result.hits.find((hit) => hit.record.id === semantic.id)?.match).toBe('semantic')
  })

  it('uses a visible current-model record embedding for by-example search', async () => {
    const target = await tenant()
    const vector = (await embedder.embed(['neighbour-vector']))[0]
    if (vector === undefined) throw new Error('Fake embedding missing')
    const source = await company(target, 'Source', 'source-only-token', vector)
    const neighbour = await company(target, 'Neighbour', 'different-only-token', vector)

    const result = await searchRecords(deps, context(target), {
      similarTo: source.id, objectTypes: ['company'], mode: 'semantic', limit: 10,
    })
    expect(result.hits[0]).toMatchObject({
      record: { id: neighbour.id, object_type: 'company', display_name: 'Neighbour' },
      match: 'semantic',
    })
    expect(result.hits.some((hit) => hit.record.id === source.id)).toBe(false)
  })
})
