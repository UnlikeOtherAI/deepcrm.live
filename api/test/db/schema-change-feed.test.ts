import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { applyTemplate, defineAttribute } from '@deepcrm/schema-engine'
import { afterAll, describe, expect, it } from 'vitest'

import { changesSince } from '../../src/services/io.js'
import { seedDefaultPolicies } from '../../src/services/policy.js'
import { createRecord } from '../../src/services/records.js'
import { archiveSchemaAttribute, archiveSchemaRelation, defineSchemaAttribute, defineSchemaRelation,
  updateSchemaAttribute, updateSchemaRelation } from '../../src/services/schema.js'
import { linkContext, linkDeps } from './link-fixture.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for schema feed tests')
const db = createDb(databaseUrl)
const deps = linkDeps(db)
const organizations: string[] = []

async function fixture() {
  const seeded = await seedTenant(db)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  organizations.push(tenant.organizationId)
  const ctx = linkContext(tenant)
  const author = { ...ctx.actor, onBehalfOf: ctx.onBehalfOf!.uoaUserId, requestId: ctx.requestId }
  await db.$transaction(async tx => {
    await seedDefaultPolicies(tx, tenant)
    await applyTemplate(tx, tenant, author, 'standard_crm')
  })
  const company = await createRecord(deps, ctx, { objectType: 'company', data: { name: 'Watched company' } })
  const person = await createRecord(deps, ctx, { objectType: 'person', data: { name: { full: 'Watched person' } } })
  return { tenant, ctx, author, company: company.record.id, person: person.record.id }
}
const field = (objectType: string, slug = 'review_detail') => ({ objectType, slug,
  name: 'Private label omitted from events', description: 'Private definition omitted from events',
  type: 'text' as const, config: { maxLength: 80 }, sensitivity: 'restricted' as const })

afterAll(async () => {
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('real schema mutation feed', () => {
  it('publishes add, relabel and archive atomically with compact metadata and original provenance', async () => {
    const target = await fixture()
    let cursor = (await changesSince(deps, target.ctx, {})).next_cursor
    for (const mutate of [
      () => defineSchemaAttribute(deps, target.ctx, field('company')),
      () => updateSchemaAttribute(deps, target.ctx, 'company', 'review_detail', { name: 'Renamed private label' }),
      () => archiveSchemaAttribute(deps, target.ctx, 'company', 'review_detail', 'Retired'),
    ]) {
      await mutate()
      const page = await changesSince(deps, target.ctx, { cursor, recordIds: [target.company] })
      expect(page.changes).toHaveLength(1)
      const team = await db.team.findUniqueOrThrow({ where: { id: target.tenant.teamId } })
      expect(page.changes[0]).toMatchObject({ kind: 'schema', record: null, attribute: 'company',
        new_value: { object_type: 'company', schema_version: team.schemaVersion },
        actor: target.ctx.actor, on_behalf_of: target.ctx.onBehalfOf!.uoaUserId,
        provenance: { run_id: target.ctx.provenance!.runId, tool_call_id: target.ctx.provenance!.toolCallId,
          request_id: target.ctx.requestId } })
      expect(page.changes[0]).not.toHaveProperty('old_value')
      expect(JSON.stringify(page.changes)).not.toContain('private label')
      expect(await changesSince(deps, target.ctx, { cursor, recordIds: [target.person] }))
        .toMatchObject({ changes: [], next_cursor: page.next_cursor })
      expect(page.next_cursor).toBe(team.feedSeq.toString())
      cursor = page.next_cursor
    }
  })

  it('notifies both relation endpoint types and wildcard endpoints, once per mutation group', async () => {
    const target = await fixture()
    const baseline = (await changesSince(deps, target.ctx, {})).next_cursor
    await defineSchemaRelation(deps, target.ctx, { slug: 'review_relationship', fromObjectType: 'person',
      toObjectType: 'company', forwardName: 'knows', inverseName: 'known by', cardinality: 'many_to_many' })
    await updateSchemaRelation(deps, target.ctx, 'review_relationship', { forwardName: 'works with' })
    await archiveSchemaRelation(deps, target.ctx, 'review_relationship', 'Retired')
    const page = await changesSince(deps, target.ctx, { cursor: baseline, recordIds: [target.company, target.person] })
    expect(page.changes).toHaveLength(6)
    const groups = new Map<string | null, string[]>()
    for (const event of page.changes) {
      const objectType = (event.new_value as { object_type: string }).object_type
      groups.set(event.group_id, [...groups.get(event.group_id) ?? [], objectType])
    }
    expect([...groups.values()]).toEqual(Array.from({ length: 3 }, () => ['company', 'person']))
    await defineSchemaRelation(deps, target.ctx, { slug: 'review_wildcard', fromObjectType: 'person',
      toObjectType: null, forwardName: 'relates to', inverseName: 'related from', cardinality: 'many_to_many' })
    expect((await changesSince(deps, target.ctx, { cursor: page.next_cursor, recordIds: [target.company] })).changes)
      .toHaveLength(1)
    const beforeReference = (await changesSince(deps, target.ctx, {})).next_cursor
    await defineSchemaAttribute(deps, target.ctx, { objectType: 'person', slug: 'review_employer',
      name: 'Review employer', description: 'Reference relation watch probe', type: 'record_reference',
      config: { objectTypes: ['company'] } })
    for (const recordId of [target.person, target.company])
      expect((await changesSince(deps, target.ctx, { cursor: beforeReference, recordIds: [recordId] })).changes)
        .toHaveLength(1)
  })

  it('rolls back the schema, version and allocated sequence together; committed writes remain ordered', async () => {
    const target = await fixture()
    const before = await db.team.findUniqueOrThrow({ where: { id: target.tenant.teamId } })
    await expect(db.$transaction(async tx => {
      await defineAttribute(tx, target.tenant, target.author, field('company'))
      throw new Error('rollback schema mutation')
    })).rejects.toThrow('rollback schema mutation')
    expect(await db.team.findUniqueOrThrow({ where: { id: target.tenant.teamId } }))
      .toMatchObject({ schemaVersion: before.schemaVersion, feedSeq: before.feedSeq })
    expect(await db.attribute.count({ where: { ...target.tenant, slug: 'review_detail' } })).toBe(0)
    await Promise.all(['review_one', 'review_two'].map(slug => defineSchemaAttribute(deps, target.ctx, field('company', slug))))
    const events = await db.recordChange.findMany({ where: { ...target.tenant, seq: { gt: before.feedSeq } },
      orderBy: { seq: 'asc' } })
    expect(events.map(event => event.seq)).toEqual([before.feedSeq + 1n, before.feedSeq + 2n])
    expect(events.map(event => event.resultingVersion)).toEqual([before.schemaVersion + 1, before.schemaVersion + 2])
    const after = await db.team.findUniqueOrThrow({ where: { id: target.tenant.teamId } })
    await db.$transaction(tx => applyTemplate(tx, target.tenant, target.author, 'standard_crm'))
    expect(await db.team.findUniqueOrThrow({ where: { id: target.tenant.teamId } }))
      .toMatchObject({ schemaVersion: after.schemaVersion, feedSeq: after.feedSeq })
  })

  it('does not expose schema events through hidden records, other tenants or denied schema view', async () => {
    const target = await fixture()
    const baseline = (await changesSince(deps, target.ctx, {})).next_cursor
    await defineSchemaAttribute(deps, target.ctx, field('company'))
    const other = await fixture()
    expect((await changesSince(deps, other.ctx, { cursor: '0', recordIds: [target.company] })).changes).toEqual([])
    await db.record.update({ where: { id: target.company }, data: { visibility: 'private',
      createdOnBehalfOf: target.ctx.onBehalfOf!.uoaUserId } })
    expect((await changesSince(deps, linkContext(target.tenant, 'another_user'), {
      cursor: baseline, recordIds: [target.company],
    })).changes).toEqual([])
    await db.policyRule.create({ data: { ...target.tenant, scope: 'team', scopeId: target.tenant.teamId,
      resourceType: 'schema', action: 'view', effect: 'deny', priority: 1000, requiresApproval: false,
      createdById: 'schema-feed-test', bindings: { create: [{ actorType: 'role', actorId: 'owner' }] } } })
    expect((await changesSince(deps, target.ctx, { cursor: baseline, recordIds: [target.company] })).changes).toEqual([])
  })
})
