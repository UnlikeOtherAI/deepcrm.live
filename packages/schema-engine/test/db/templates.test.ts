import { readFileSync } from 'node:fs'

import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { ErrorCode } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import { applyTemplate, listTemplates } from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for template tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const actor = () => ({ type: 'system' as const, id: 'test', onBehalfOf: null, requestId: crypto.randomUUID() })

async function tenant() {
  const value = await seedTenant(db)
  organizations.push(value.organizationId)
  return value
}

afterAll(async () => {
  await Promise.all(organizations.map((id) => dropTenant(db, id)))
  await db.$disconnect()
})

describe('templates', () => {
  it('uses static template imports and reports unknown templates with choices', async () => {
    const source = readFileSync(new URL('../../src/templates/apply.ts', import.meta.url), 'utf8')
    const copied = readFileSync(new URL('../../src/templates/standard_crm.json', import.meta.url), 'utf8')
    const authoritative = readFileSync(
      new URL('../../../../docs/spec/templates/standard_crm.json', import.meta.url),
      'utf8',
    )
    const copiedSales = readFileSync(new URL('../../src/templates/standard_sales.json', import.meta.url), 'utf8')
    const authoritativeSales = readFileSync(
      new URL('../../../../docs/spec/templates/standard_sales.json', import.meta.url),
      'utf8',
    )
    const copiedService = readFileSync(new URL('../../src/templates/standard_service.json', import.meta.url), 'utf8')
    const authoritativeService = readFileSync(
      new URL('../../../../docs/spec/templates/standard_service.json', import.meta.url),
      'utf8',
    )
    const copiedCommerce = readFileSync(new URL('../../src/templates/standard_commerce.json', import.meta.url), 'utf8')
    const authoritativeCommerce = readFileSync(
      new URL('../../../../docs/spec/templates/standard_commerce.json', import.meta.url),
      'utf8',
    )
    expect(source).toContain("import systemJson from './system.json'")
    expect(source).toContain("import standardSalesJson from './standard_sales.json'")
    expect(source).toContain("import standardServiceJson from './standard_service.json'")
    expect(source).toContain("import standardCommerceJson from './standard_commerce.json'")
    expect(source).not.toContain('readFile')
    expect(copied).toBe(authoritative)
    expect(copiedSales).toBe(authoritativeSales)
    expect(copiedService).toBe(authoritativeService)
    expect(copiedCommerce).toBe(authoritativeCommerce)
    expect(listTemplates().map((template) => template.slug))
      .toEqual(['system', 'standard_crm', 'standard_sales', 'standard_service', 'standard_commerce'])
    const value = await tenant()
    await expect(db.$transaction((tx) => applyTemplate(tx, value, actor(), 'missing')))
      .rejects.toMatchObject({ code: ErrorCode.UNKNOWN_TEMPLATE })
  })

  it('applies exact system and standard metadata once with claims, primaries, rules, and final audit', async () => {
    const value = await tenant()
    const system = await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'system'))
    expect(system.added).toEqual({
      objectTypes: 3, attributes: 15, relationTypes: 3, pipelines: 0, matchingRules: 0,
    })
    const standard = await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'standard_crm'))
    expect(standard.added).toEqual({
      objectTypes: 3, attributes: 29, relationTypes: 3, pipelines: 0, matchingRules: 5,
    })
    const [objects, attributes, relations, rules, team, audits] = await Promise.all([
      db.objectType.findMany({ where: { organizationId: value.organizationId, teamId: value.teamId } }),
      db.attribute.findMany({ where: { organizationId: value.organizationId, teamId: value.teamId } }),
      db.relationType.findMany({ where: { organizationId: value.organizationId, teamId: value.teamId } }),
      db.matchingRule.count({ where: { organizationId: value.organizationId, teamId: value.teamId } }),
      db.team.findFirstOrThrow({ where: { id: value.teamId, organizationId: value.organizationId } }),
      db.auditLog.count({ where: { organizationId: value.organizationId, teamId: value.teamId } }),
    ])
    expect(objects.map((object) => object.slug).sort()).toEqual(['activity', 'company', 'deal', 'note', 'person', 'task'])
    expect(objects.filter((object) => object.kind === 'system').map((object) => object.slug).sort())
      .toEqual(['activity', 'note', 'task'])
    const attributeById = new Map(attributes.map((attribute) => [attribute.id, attribute.slug]))
    expect(objects.map((object) => `${object.slug}:${attributeById.get(object.primaryAttributeId ?? '') ?? ''}`).sort())
      .toEqual(['activity:subject', 'company:name', 'deal:name', 'note:title', 'person:name', 'task:title'])
    expect(relations.map((relation) => `${relation.slug}:${relation.projectionAttributeSlug}:${relation.isSystem}`).sort())
      .toEqual([
        'activity_about:null:true', 'deal_contacts:contacts:false', 'deal_for_company:company:false',
        'note_about:null:true', 'person_works_at:company:false', 'task_about:null:true',
      ])
    expect(rules).toBe(5)
    expect(team.schemaVersion).toBe(2)
    expect(audits).toBe(2)
  })

  it('is idempotent and leaves existing partial metadata untouched while adding missing slugs', async () => {
    const value = await tenant()
    await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'system'))
    const before = await db.team.findFirstOrThrow({ where: { id: value.teamId, organizationId: value.organizationId } })
    const second = await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'system'))
    expect(second.added).toEqual({
      objectTypes: 0, attributes: 0, relationTypes: 0, pipelines: 0, matchingRules: 0,
    })
    const after = await db.team.findFirstOrThrow({ where: { id: value.teamId, organizationId: value.organizationId } })
    expect(after.schemaVersion).toBe(before.schemaVersion)
    await db.attribute.deleteMany({ where: { organizationId: value.organizationId, teamId: value.teamId, slug: 'priority' } })
    const partial = await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'system'))
    expect(partial.added).toEqual({ objectTypes: 0, attributes: 1, relationTypes: 0, pipelines: 0, matchingRules: 0 })
  })

  it('adds sales and service templates idempotently without overwriting existing shells', async () => {
    const value = await tenant()
    await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'system'))
    await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'standard_crm'))
    const customLead = await db.objectType.create({ data: {
      organizationId: value.organizationId,
      teamId: value.teamId,
      slug: 'lead',
      singularName: 'Custom lead',
      pluralName: 'Custom leads',
      description: 'Pre-existing custom lead shell.',
      kind: 'custom',
      createdByType: 'system',
      createdById: 'template-test',
    } })
    const sales = await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'standard_sales'))
    expect(sales.added).toEqual({ objectTypes: 0, attributes: 22, relationTypes: 3, pipelines: 1, matchingRules: 0 })
    const repeatedSales = await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'standard_sales'))
    expect(repeatedSales.added).toEqual({
      objectTypes: 0, attributes: 0, relationTypes: 0, pipelines: 0, matchingRules: 0,
    })
    await expect(db.objectType.findUniqueOrThrow({ where: { id: customLead.id } }))
      .resolves.toMatchObject({ singularName: 'Custom lead', kind: 'custom' })
    const service = await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'standard_service'))
    expect(service.added).toEqual({ objectTypes: 1, attributes: 20, relationTypes: 7, pipelines: 1, matchingRules: 1 })
    const pipelines = await db.pipeline.findMany({
      where: { organizationId: value.organizationId, teamId: value.teamId },
      include: { stages: true },
      orderBy: { slug: 'asc' },
    })
    expect(pipelines.map((pipeline) => `${pipeline.slug}:${pipeline.stages.length}:${pipeline.isDefault}`))
      .toEqual(['lead_qualification:5:true', 'ticket_resolution:6:true'])
    const rules = await db.matchingRule.findMany({
      where: { organizationId: value.organizationId, teamId: value.teamId },
      include: { objectType: true },
    })
    expect(rules.map((rule) => `${rule.objectType.slug}:${rule.method}:${rule.attributeSlugs.join('+')}`).sort())
      .toContain('ticket:normalized:external_ref')
    expect(rules.some((rule) => rule.objectType.slug === 'ticket' && rule.method === 'fuzzy')).toBe(false)
  })

  it('adds commerce templates with snapshot relations and rollup derivations', async () => {
    const value = await tenant()
    await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'system'))
    await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'standard_crm'))
    const commerce = await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'standard_commerce'))
    expect(commerce.added).toEqual({ objectTypes: 2, attributes: 31, relationTypes: 2, pipelines: 0, matchingRules: 3 })
    const repeated = await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'standard_commerce'))
    expect(repeated.added).toEqual({
      objectTypes: 0, attributes: 0, relationTypes: 0, pipelines: 0, matchingRules: 0,
    })
    const relations = await db.relationType.findMany({
      where: { organizationId: value.organizationId, teamId: value.teamId, slug: { in: ['line_item_product', 'line_item_deal'] } },
      orderBy: { slug: 'asc' },
    })
    expect(relations.map((relation) => `${relation.slug}:${relation.cardinality}:${relation.onDelete}`).sort())
      .toEqual(['line_item_deal:many_to_one:cascade', 'line_item_product:many_to_one:unlink'])
    const derived = await db.attribute.findMany({
      where: {
        organizationId: value.organizationId,
        teamId: value.teamId,
        slug: { in: ['line_item_count', 'line_item_revenue_total', 'line_item_total'] },
        valueSource: 'rollup',
      },
      include: { objectType: true, derivation: true },
      orderBy: [{ objectType: { slug: 'asc' } }, { slug: 'asc' }],
    })
    const derivedLabels = derived.map((attribute) => {
      if (attribute.objectType === null || attribute.derivation === null) throw new Error('commerce derivation missing')
      return `${attribute.objectType.slug}:${attribute.slug}:${attribute.derivation.valueSource}`
    })
    expect(derivedLabels)
      .toEqual([
        'deal:line_item_count:rollup',
        'deal:line_item_total:rollup',
        'product:line_item_count:rollup',
        'product:line_item_revenue_total:rollup',
      ])
    const rules = await db.matchingRule.findMany({
      where: { organizationId: value.organizationId, teamId: value.teamId },
      include: { objectType: true },
    })
    expect(rules.map((rule) => `${rule.objectType.slug}:${rule.method}:${rule.attributeSlugs.join('+')}`).sort())
      .toEqual(expect.arrayContaining([
        'line_item:normalized:external_ref',
        'product:normalized:external_ref',
        'product:normalized:sku',
      ]))
    expect(rules.some((rule) => ['line_item', 'product'].includes(rule.objectType.slug) && rule.method === 'fuzzy'))
      .toBe(false)
  })

  it('rolls back the batch, version increment, and audit with its caller transaction', async () => {
    const value = await tenant()
    await expect(db.$transaction(async (tx) => {
      await applyTemplate(tx, value, actor(), 'system')
      throw new Error('rollback template test')
    })).rejects.toThrow('rollback template test')
    expect(await db.objectType.count({
      where: { organizationId: value.organizationId, teamId: value.teamId },
    })).toBe(0)
    expect(await db.auditLog.count({
      where: { organizationId: value.organizationId, teamId: value.teamId },
    })).toBe(0)
    const team = await db.team.findFirstOrThrow({
      where: { id: value.teamId, organizationId: value.organizationId },
    })
    expect(team.schemaVersion).toBe(0)
  })
})
