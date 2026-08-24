import { createDb, dropTenant, seedTenant, type TenantRef } from '@deepcrm/db'
import { type ActorContext, type Filter } from '@deepcrm/schemas'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { queryRecords } from '../../src/query/run.js'
import { compileQuery } from '../../src/query/compile.js'
import { loadSchema } from '../../src/schema/load.js'
import { applyTemplate } from '../../src/templates/apply.js'
import type { QueryCursorState } from '../../src/query/types.js'

const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(url)
const organizations: string[] = []

function context(tenant: TenantRef): ActorContext {
  return {
    tenant, app: 'test', actor: { type: 'system', id: 'query-run' },
    onBehalfOf: { uoaUserId: 'query-owner', role: 'owner' }, provenance: null,
    actChain: [], requestId: crypto.randomUUID(), now: new Date('2026-08-24T12:00:00.000Z'),
  }
}
async function fixture() {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'query-run', onBehalfOf: null, requestId: ctx.requestId,
  }, 'standard_crm'))
  const schema = await loadSchema(db, tenant)
  const deal = schema.objectTypesBySlug.get('deal')
  const company = schema.objectTypesBySlug.get('company')
  if (deal === undefined || company === undefined) throw new Error('template objects missing')
  const companyRecord = await db.record.create({ data: {
    organizationId: tenant.organizationId, teamId: tenant.teamId, objectTypeId: company.id,
    data: { name: 'Query Company' }, displayName: 'Query Company', visibility: 'team',
    createdOnBehalfOf: 'query-owner', createdByType: 'system', createdById: 'query-run',
  } })
  const rows = Array.from({ length: 30 }, (_, index) => ({
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    objectTypeId: deal.id,
    data: {
      name: `Deal ${String(index % 5).padStart(2, '0')}`,
      stage: index % 2 === 0 ? 'qualified' : 'proposal',
      amount: { amount: String(10_000 + (index % 3) * 500), currency: 'GBP' },
      ...(index % 4 === 0 ? {} : { close_date: `2026-0${(index % 6) + 1}-01` }),
    },
    displayName: `Deal ${String(index % 5).padStart(2, '0')}`,
    visibility: 'team' as const,
    createdOnBehalfOf: 'query-owner', createdByType: 'system' as const, createdById: 'query-run',
  }))
  await db.record.createMany({ data: rows })
  const first = await db.record.findFirstOrThrow({ where: { organizationId: tenant.organizationId, teamId: tenant.teamId, objectTypeId: deal.id } })
  const relation = schema.relationTypesBySlug.get('deal_for_company')
  if (relation === undefined) throw new Error('projection relation missing')
  await db.recordLink.create({ data: {
    organizationId: tenant.organizationId, teamId: tenant.teamId, relationTypeId: relation.id,
    fromRecordId: first.id, toRecordId: companyRecord.id, data: {}, position: null,
    createdByType: 'system', createdById: 'query-run',
  } })
  return { tenant, ctx, schema, deal, company, companyRecord, first }
}

afterAll(async () => { await Promise.all(organizations.map((id) => dropTenant(db, id))); await db.$disconnect() })

describe('query run', () => {
  it('pages 30 rows without duplicate/skip, computes total before cursor, and projects references', async () => {
    const value = await fixture()
    const input = {
      filter: { and: [
        { attribute: 'stage', op: 'in' as const, value: ['qualified', 'proposal'] },
      ] },
      sort: [
        { attribute: 'stage', direction: 'asc' as const },
        { attribute: 'close_date', direction: 'desc' as const },
        { system: 'display_name' as const, direction: 'asc' as const },
      ],
      limit: 7,
      includeTotal: true,
    }
    const ids = new Set<string>()
    let after: QueryCursorState | undefined
    let total: number | undefined
    let projected = false
    do {
      const page = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, { ...input, after })
      total = page.total
      for (const record of page.records) {
        expect(ids.has(record.id)).toBe(false)
        ids.add(record.id)
        if (record.id === value.first.id) projected = record.data.company === value.companyRecord.id
      }
      after = page.next ?? undefined
    } while (after !== undefined)
    expect(ids).toHaveLength(30)
    expect(total).toBe(30)
    expect(projected).toBe(true)
    const defaultIds = new Set<string>()
    let defaultAfter: QueryCursorState | undefined
    do {
      const page = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
        limit: 7,
        after: defaultAfter,
      })
      for (const record of page.records) defaultIds.add(record.id)
      defaultAfter = page.next ?? undefined
    } while (defaultAfter !== undefined)
    expect(defaultIds).toHaveLength(30)
  }, 15_000)

  it('uses active link EXISTS and cannot cross-read a second tenant', async () => {
    const value = await fixture()
    const linked = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      filter: { linked_to: { relation: 'deal_for_company', record_id: value.companyRecord.id, direction: 'from' } },
    })
    expect(linked.records.map((record) => record.id)).toEqual([value.first.id])
    const other = await fixture()
    await expect(queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      filter: { linked_to: { relation: 'deal_for_company', record_id: other.companyRecord.id, direction: 'from' } },
    })).resolves.toMatchObject({ records: [] })

    const reverse = await queryRecords(db, value.tenant, value.ctx, value.schema, value.company, {
      filter: { linked_to: { relation: 'deal_for_company', record_id: value.first.id, direction: 'to' } },
    })
    expect(reverse.records.map((record) => record.id)).toEqual([value.companyRecord.id])

    const reference = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      filter: { attribute: 'company', op: 'eq', value: value.companyRecord.id },
    })
    expect(reference.records.map((record) => record.id)).toEqual([value.first.id])
    const emptyReferences = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      filter: { attribute: 'company', op: 'is_null' },
    })
    expect(emptyReferences.records).toHaveLength(29)
  })

  it('filters system owner, timestamps, and display names with typed values', async () => {
    const value = await fixture()
    await db.record.update({
      where: { id: value.first.id },
      data: { ownerType: 'human', ownerId: 'query-owner' },
    })
    const owner = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      filter: { system: 'owner', op: 'in', value: [{ type: 'human', id: 'query-owner' }] },
    })
    expect(owner.records.map((record) => record.id)).toEqual([value.first.id])
    const display = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      filter: { system: 'display_name', op: 'starts_with', value: 'Deal 00' },
    })
    expect(display.records).toHaveLength(6)
    const timestamps = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      filter: { system: 'created_at', op: 'gte', value: '2020-01-01T00:00:00.000Z' },
    })
    expect(timestamps.records).toHaveLength(30)
    await expect(queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      filter: { system: 'display_name', op: 'between', value: ['Deal 00', 'Deal 01'] },
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { detail: 'unsupported_operator' } })
  })

  it('rejects ordered currency filters without fixedCurrency', async () => {
    const value = await fixture()
    await expect(queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      filter: { attribute: 'amount', op: 'gte', value: { amount: '10000', currency: 'GBP' } },
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('rejects invalid arity, structural caps, unknown, and archived attributes before SQL', async () => {
    const value = await fixture()
    const invalid = (filter: Filter) => {
      try {
        compileQuery(value.tenant, value.ctx, value.schema, value.deal, { filter })
      } catch (error) {
        expect(error).toMatchObject({ code: 'VALIDATION_FAILED' })
        return
      }
      throw new Error('Expected validation failure')
    }
    invalid({ attribute: 'stage', op: 'in', value: [] })
    invalid({ attribute: 'stage', op: 'is_null', value: 'unexpected' })
    invalid({ attribute: 'unknown', op: 'eq', value: 'x' })
    invalid({ text: 'x'.repeat(16_385) })
    let deep: Filter = { attribute: 'stage', op: 'eq', value: 'qualified' }
    for (let index = 0; index < 8; index += 1) deep = { not: deep }
    invalid(deep)
    const leaves: Filter[] = Array.from({ length: 100 }, () => ({
      attribute: 'stage', op: 'eq', value: 'qualified',
    }))
    invalid({ and: leaves })
    let cursorRejected = false
    try {
      compileQuery(value.tenant, value.ctx, value.schema, value.deal, {
        after: { values: [], id: 'not-a-uuid' },
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED' })
      cursorRejected = true
    }
    expect(cursorRejected).toBe(true)
    const attribute = value.deal.attributes.find((candidate) => candidate.slug === 'stage')
    if (attribute === undefined) throw new Error('stage missing')
    await db.attribute.update({ where: { id: attribute.id }, data: { archivedAt: new Date() } })
    await db.team.update({
      where: { id: value.tenant.teamId },
      data: { schemaVersion: { increment: 1 } },
    })
    const reloaded = await loadSchema(db, value.tenant)
    const deal = reloaded.objectTypesBySlug.get('deal')
    if (deal === undefined) throw new Error('deal missing')
    try {
      compileQuery(value.tenant, value.ctx, reloaded, deal, {
        filter: { attribute: 'stage', op: 'eq', value: 'qualified' },
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED' })
      return
    }
    throw new Error('Expected archived attribute failure')
  })

  it('uses canonical multi actor/reference contains and compiles rich text through TSV', async () => {
    const value = await fixture()
    const position = Math.max(...value.deal.attributes.map((attribute) => attribute.position)) + 1
    await db.attribute.create({
      data: {
        organizationId: value.tenant.organizationId,
        teamId: value.tenant.teamId,
        objectTypeId: value.deal.id,
        slug: 'reviewers',
        name: 'Reviewers',
        description: '',
        type: 'actor_reference',
        config: { allow: ['human', 'agent'] },
        isMulti: true,
        position,
      },
    })
    const personPosition = Math.max(...value.schema.objectTypesBySlug.get('person')!.attributes.map(
      (attribute) => attribute.position,
    )) + 1
    await db.attribute.create({
      data: {
        organizationId: value.tenant.organizationId,
        teamId: value.tenant.teamId,
        objectTypeId: value.schema.objectTypesBySlug.get('person')!.id,
        slug: 'aliases', name: 'Aliases', description: '', type: 'personal_name', config: {},
        isMulti: true, position: personPosition,
      },
    })
    await db.attribute.create({
      data: {
        organizationId: value.tenant.organizationId,
        teamId: value.tenant.teamId,
        objectTypeId: value.deal.id,
        slug: 'memo',
        name: 'Memo',
        description: '',
        type: 'rich_text',
        config: {},
        position: position + 1,
      },
    })
    await db.team.update({ where: { id: value.tenant.teamId }, data: { schemaVersion: { increment: 1 } } })
    const schema = await loadSchema(db, value.tenant)
    const deal = schema.objectTypesBySlug.get('deal')
    const person = schema.objectTypesBySlug.get('person')
    if (deal === undefined || person === undefined) throw new Error('template objects missing')
    const actor = { type: 'human', id: 'uoa-reviewer' }
    const record = await db.record.findUniqueOrThrow({ where: { id: value.first.id } })
    if (typeof record.data !== 'object' || record.data === null || Array.isArray(record.data)) {
      throw new Error('record data must be an object')
    }
    await db.record.update({ where: { id: value.first.id }, data: { data: { ...record.data, reviewers: [actor] } } })
    const personRecord = await db.record.create({ data: {
      organizationId: value.tenant.organizationId,
      teamId: value.tenant.teamId,
      objectTypeId: person.id,
      data: {
        name: { first: 'Reference', last: 'Person', full: 'Reference Person' },
        aliases: [{ full: 'Ada Lovelace' }, { full: 'Augusta Ada' }],
      },
      displayName: 'Reference Person',
      createdByType: 'system',
      createdById: 'query-run',
    } })
    const contacts = schema.relationTypesBySlug.get('deal_contacts')
    if (contacts === undefined) throw new Error('contacts relation missing')
    await db.recordLink.create({ data: {
      organizationId: value.tenant.organizationId,
      teamId: value.tenant.teamId,
      relationTypeId: contacts.id,
      fromRecordId: value.first.id,
      toRecordId: personRecord.id,
      position: 0,
      data: {},
      createdByType: 'system',
      createdById: 'query-run',
    } })
    const actors = await queryRecords(db, value.tenant, value.ctx, schema, deal, {
      filter: { attribute: 'reviewers', op: 'contains', value: actor },
    })
    expect(actors.records.map((item) => item.id)).toEqual([value.first.id])
    const contactsMatch = await queryRecords(db, value.tenant, value.ctx, schema, deal, {
      filter: { attribute: 'contacts', op: 'contains', value: personRecord.id },
    })
    expect(contactsMatch.records.map((item) => item.id)).toEqual([value.first.id])
    const nameContains = await queryRecords(db, value.tenant, value.ctx, schema, person, {
      filter: { attribute: 'name', op: 'contains', value: { first: 'Reference' } },
    })
    expect(nameContains.records.map((item) => item.id)).toEqual([personRecord.id])
    const aliasStarts = await queryRecords(db, value.tenant, value.ctx, schema, person, {
      filter: { attribute: 'aliases', op: 'starts_with', value: { full: 'Aug' } },
    })
    expect(aliasStarts.records.map((item) => item.id)).toEqual([personRecord.id])
    const compiled = compileQuery(value.tenant, value.ctx, schema, deal, {
      filter: { attribute: 'memo', op: 'contains', value: 'decision' },
    })
    expect(compiled.sql.sql).toContain('record_search')
    expect(compiled.sql.sql).toContain('plainto_tsquery')
  })

  it('uses one page query and one batched projection lookup regardless of page size', async () => {
    const value = await fixture()
    const traced = db.$extends({})
    const executeRaw = traced.$queryRaw.bind(traced)
    const raw = vi.spyOn(traced, '$queryRaw').mockImplementation((query, ...values) => (
      Reflect.apply(executeRaw, traced, [query, ...values])
    ))
    const findLinks = traced.recordLink.findMany.bind(traced.recordLink)
    const links = vi.spyOn(traced.recordLink, 'findMany').mockImplementation((args) => findLinks(args))
    try {
      await queryRecords(traced, value.tenant, value.ctx, value.schema, value.deal, { limit: 1 })
      expect(raw).toHaveBeenCalledTimes(1)
      expect(links).toHaveBeenCalledTimes(1)
      raw.mockClear()
      links.mockClear()
      await queryRecords(traced, value.tenant, value.ctx, value.schema, value.deal, {
        limit: 30,
        includeTotal: true,
      })
      expect(raw).toHaveBeenCalledTimes(2)
      expect(links).toHaveBeenCalledTimes(1)
    } finally {
      raw.mockRestore()
      links.mockRestore()
    }
  })

  it('excludes deleted and merged rows from page/count and reads timestamp source nulls', async () => {
    const value = await fixture()
    const rows = await db.record.findMany({
      where: { organizationId: value.tenant.organizationId, teamId: value.tenant.teamId, objectTypeId: value.deal.id },
      take: 3,
      orderBy: { id: 'asc' },
    })
    const deleted = rows[0]
    const merged = rows[1]
    if (deleted === undefined || merged === undefined) throw new Error('fixture rows missing')
    await db.record.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } })
    await db.record.update({ where: { id: merged.id }, data: { mergedIntoId: value.first.id } })
    const live = rows.find((record) => record.id !== deleted.id && record.id !== merged.id)
    if (live === undefined) throw new Error('live row missing')
    await db.record.update({ where: { id: live.id }, data: { lastActivityAt: new Date() } })
    const page = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      includeTotal: true,
      filter: { attribute: 'last_activity_at', op: 'is_null' },
    })
    expect(page.records).toHaveLength(27)
    expect(page.total).toBe(27)
    expect(page.records.some((record) => record.id === deleted.id || record.id === merged.id)).toBe(false)
  })

  it('handles scalar and multi personal-name text matching and rejects display-name ranges', async () => {
    const value = await fixture()
    const person = value.schema.objectTypesBySlug.get('person')
    if (person === undefined) throw new Error('person missing')
    const position = Math.max(...person.attributes.map((attribute) => attribute.position)) + 1
    await db.attribute.create({ data: {
      organizationId: value.tenant.organizationId,
      teamId: value.tenant.teamId,
      objectTypeId: person.id,
      slug: 'aliases',
      name: 'Aliases',
      description: '',
      type: 'personal_name',
      config: {},
      isMulti: true,
      position,
    } })
    await db.team.update({ where: { id: value.tenant.teamId }, data: { schemaVersion: { increment: 1 } } })
    const schema = await loadSchema(db, value.tenant)
    const reloadedPerson = schema.objectTypesBySlug.get('person')
    if (reloadedPerson === undefined) throw new Error('person missing')
    const record = await db.record.create({ data: {
      organizationId: value.tenant.organizationId,
      teamId: value.tenant.teamId,
      objectTypeId: reloadedPerson.id,
      data: {
        name: { first: 'Ada', last: 'Lovelace', full: 'Ada Lovelace' },
        aliases: [{ first: 'Countess', last: 'Ada', full: 'Countess Ada' }],
      },
      displayName: 'Ada Lovelace',
      createdByType: 'system',
      createdById: 'query-run',
    } })
    const scalar = await queryRecords(db, value.tenant, value.ctx, schema, reloadedPerson, {
      filter: { attribute: 'name', op: 'contains', value: { first: 'Ada', last: 'Lovelace' } },
    })
    expect(scalar.records.map((item) => item.id)).toContain(record.id)
    const multi = await queryRecords(db, value.tenant, value.ctx, schema, reloadedPerson, {
      filter: { attribute: 'aliases', op: 'starts_with', value: { first: 'Countess', last: 'Ada' } },
    })
    expect(multi.records.map((item) => item.id)).toEqual([record.id])
    let rejected = false
    try {
      compileQuery(value.tenant, value.ctx, schema, reloadedPerson, {
        filter: { system: 'display_name', op: 'gt', value: 'A' },
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED' })
      rejected = true
    }
    expect(rejected).toBe(true)
  })
})
