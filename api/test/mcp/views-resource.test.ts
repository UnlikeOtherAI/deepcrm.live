import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDb } from '@deepcrm/db'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP views resource tests')

const db = createDb(databaseUrl)
const runKey = randomUUID()
const createdById = `views-resource-${runKey}`
let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>
let organizationId: string
let teamId: string

async function call(name: string, args: Record<string, unknown>): Promise<void> {
  await client.callTool({ name, arguments: args })
}

function textContent(contents: Array<{ uri: string; text: string } | { uri: string; blob: string }>): string {
  const first = contents[0]
  if (first === undefined || !('text' in first)) throw new Error('Expected a text resource')
  return first.text
}

async function resourceError(uri: string): Promise<string> {
  try {
    await client.readResource({ uri })
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error(`Expected ${uri} to be unavailable`)
}

beforeAll(async () => {
  const started = await startTestServer()
  client = started.client
  closeServer = started.close
  await call('crm_template_apply', { template: 'standard_crm' })
  const team = await db.team.findUniqueOrThrow({
    where: { externalTeamId: 'team_dev' }, select: { id: true, organizationId: true },
  })
  organizationId = team.organizationId
  teamId = team.id
  for (const rule of [
    { resourceType: 'schema' as const, action: 'view' as const },
    { resourceType: 'schema' as const, action: 'define' as const },
    { resourceType: 'view' as const, action: 'view' as const },
  ]) {
    await db.policyRule.create({
      data: {
        organizationId, teamId, scope: 'team', scopeId: teamId,
        resourceType: rule.resourceType, action: rule.action, effect: 'allow', priority: 150,
        requiresApproval: false, createdById,
        bindings: { create: [
          { actorType: 'agent', actorId: 'agent:dev:agent_dev' },
          { actorType: 'role', actorId: 'owner' },
        ] },
      },
    })
  }
  await call('crm_template_apply', { template: 'standard_crm' })
})

afterAll(async () => {
  await db.policyRule.deleteMany({ where: { organizationId, teamId, createdById } })
  await closeServer()
  await db.$disconnect()
})

describe('saved view MCP resources', () => {
  it('lists and reads only entitled tenant views through resources and schema', async () => {
    const person = await db.objectType.findFirstOrThrow({
      where: { organizationId, teamId, slug: 'person' }, select: { id: true },
    })
    const company = await db.objectType.findFirstOrThrow({
      where: { organizationId, teamId, slug: 'company' }, select: { id: true },
    })
    const visibleSlug = `visible_${runKey.replaceAll('-', '_')}`
    const hiddenSlug = `hidden_${runKey.replaceAll('-', '_')}`
    const foreignSlug = `foreign_${runKey.replaceAll('-', '_')}`
    const visible = await db.view.create({ data: {
      organizationId, teamId, objectTypeId: person.id, slug: visibleSlug, name: 'Visible people',
      description: 'People visible to the caller.',
      filter: { attribute: 'name', op: 'contains', value: 'Ada' },
      sort: [{ system: 'created_at', direction: 'desc' }], attributes: ['name'],
      createdByType: 'system', createdById,
    } })
    const hidden = await db.view.create({ data: {
      organizationId, teamId, objectTypeId: company.id, slug: hiddenSlug, name: 'Hidden companies',
      filter: { attribute: 'name', op: 'contains', value: 'Secret' },
      sort: [{ system: 'created_at', direction: 'desc' }], attributes: ['name'],
      createdByType: 'system', createdById,
    } })
    const deny = await db.policyRule.create({ data: {
      organizationId, teamId, scope: 'object_type', scopeId: company.id,
      resourceType: 'view', action: 'view', effect: 'deny', priority: 200,
      requiresApproval: false, createdById,
      bindings: { create: [{ actorType: 'agent', actorId: 'agent:dev:agent_dev' }] },
    } })
    const foreignOrganization = await db.organization.create({ data: {
      externalOrgId: `foreign-org-${runKey}`, name: 'Foreign views resource fixture',
    } })
    const foreignTeam = await db.team.create({ data: {
      organizationId: foreignOrganization.id, externalTeamId: `foreign-team-${runKey}`,
      name: 'Foreign views resource fixture',
    } })
    const foreignType = await db.objectType.create({ data: {
      organizationId: foreignOrganization.id, teamId: foreignTeam.id, slug: 'person',
      singularName: 'Person', pluralName: 'People', description: 'Foreign fixture.',
      kind: 'custom', createdByType: 'system', createdById,
    } })
    const foreign = await db.view.create({ data: {
      organizationId: foreignOrganization.id, teamId: foreignTeam.id, objectTypeId: foreignType.id,
      slug: foreignSlug, name: 'Foreign people', filter: {}, sort: [], attributes: [],
      createdByType: 'system', createdById,
    } })
    await db.team.update({ where: { id: teamId }, data: { schemaVersion: { increment: 1 } } })

    try {
      const resources = await client.listResources()
      expect(resources.resources.map((resource) => resource.uri)).toContain('crm://views')
      const templates = await client.listResourceTemplates()
      expect(templates.resourceTemplates.map((template) => template.uriTemplate))
        .toContain('crm://views/{slug}')

      const index = z.object({ views: z.array(z.object({
        slug: z.string(), name: z.string(), object_type: z.string(),
      })) }).parse(JSON.parse(textContent((await client.readResource({ uri: 'crm://views' })).contents)))
      expect(index.views).toContainEqual({
        slug: visibleSlug, name: 'Visible people', object_type: 'person',
      })
      expect(index.views.map((view) => view.slug)).not.toContain(hiddenSlug)
      expect(index.views.map((view) => view.slug)).not.toContain(foreignSlug)

      const detail = z.object({
        id: z.string().uuid(), slug: z.string(), name: z.string(), description: z.string(),
        object_type: z.string(), filter: z.record(z.unknown()), sort: z.array(z.unknown()),
        attributes: z.array(z.string()),
      }).parse(JSON.parse(textContent((await client.readResource({
        uri: `crm://views/${visibleSlug}`,
      })).contents)))
      expect(detail).toMatchObject({
        id: visible.id, slug: visibleSlug, name: 'Visible people', object_type: 'person',
        attributes: ['name'],
      })

      const schema = z.object({ views: z.array(z.object({ slug: z.string() })) })
        .parse(JSON.parse(textContent((await client.readResource({ uri: 'crm://schema' })).contents)))
      expect(schema.views.map((view) => view.slug)).toContain(visibleSlug)
      expect(schema.views.map((view) => view.slug)).not.toContain(hiddenSlug)
      expect(schema.views.map((view) => view.slug)).not.toContain(foreignSlug)

      expect(await resourceError(`crm://views/${hiddenSlug}`))
        .toBe(await resourceError(`crm://views/${foreignSlug}`))
    } finally {
      await db.policyRule.delete({ where: { id: deny.id } })
      await db.view.deleteMany({
        where: { organizationId, teamId, id: { in: [visible.id, hidden.id] } },
      })
      await db.team.update({ where: { id: teamId }, data: { schemaVersion: { increment: 1 } } })
      await db.view.delete({ where: { id: foreign.id } })
      await db.objectType.delete({ where: { id: foreignType.id } })
      await db.team.delete({ where: { id: foreignTeam.id } })
      await db.organization.delete({ where: { id: foreignOrganization.id } })
    }
  })
})
