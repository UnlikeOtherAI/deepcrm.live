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
    expect(source).toContain("import systemJson from './system.json'")
    expect(source).not.toContain('readFile')
    expect(copied).toBe(authoritative)
    expect(listTemplates().map((template) => template.slug)).toEqual(['system', 'standard_crm'])
    const value = await tenant()
    await expect(db.$transaction((tx) => applyTemplate(tx, value, actor(), 'missing')))
      .rejects.toMatchObject({ code: ErrorCode.UNKNOWN_TEMPLATE })
  })

  it('applies exact system and standard metadata once with claims, primaries, rules, and final audit', async () => {
    const value = await tenant()
    const system = await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'system'))
    expect(system.added).toEqual({ objectTypes: 3, attributes: 15, relationTypes: 3, matchingRules: 0 })
    const standard = await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'standard_crm'))
    expect(standard.added).toEqual({ objectTypes: 3, attributes: 27, relationTypes: 3, matchingRules: 5 })
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
    expect(second.added).toEqual({ objectTypes: 0, attributes: 0, relationTypes: 0, matchingRules: 0 })
    const after = await db.team.findFirstOrThrow({ where: { id: value.teamId, organizationId: value.organizationId } })
    expect(after.schemaVersion).toBe(before.schemaVersion)
    await db.attribute.deleteMany({ where: { organizationId: value.organizationId, teamId: value.teamId, slug: 'priority' } })
    const partial = await db.$transaction((tx) => applyTemplate(tx, value, actor(), 'system'))
    expect(partial.added).toEqual({ objectTypes: 0, attributes: 1, relationTypes: 0, matchingRules: 0 })
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
