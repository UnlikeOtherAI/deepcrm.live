import { createDb } from '@deepcrm/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP schema tests')

const db = createDb(databaseUrl)
const ArchiveInputRequired = z.object({
  resultType: z.literal('input_required'),
  inputRequests: z.object({
    confirm: z.object({
      method: z.literal('elicitation/create'),
      params: z.object({
        requestedSchema: z.object({
          required: z.array(z.string()),
        }).passthrough(),
      }).passthrough(),
    }),
  }),
  requestState: z.string().min(1),
}).passthrough()
const ApprovalInputRequired = z.object({
  resultType: z.literal('input_required'),
  inputRequests: z.object({
    approval: z.object({
      method: z.literal('elicitation/create'),
    }).passthrough(),
  }).passthrough(),
  requestState: z.string().min(1),
}).passthrough()
const ToolResult = z.object({
  content: z.array(z.unknown()),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
}).passthrough()

let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>

beforeAll(async () => {
  const started = await startTestServer()
  client = started.client
  closeServer = started.close
  const team = await db.team.findUniqueOrThrow({
    where: { externalTeamId: 'team_dev' }, select: { id: true, organizationId: true },
  })
  await db.policyRule.deleteMany({
    where: {
      organizationId: team.organizationId,
      teamId: team.id,
      createdById: 'schema-approval-test',
    },
  })
  const schemaActions: ReadonlyArray<'view' | 'define'> = ['view', 'define']
  for (const action of schemaActions) {
    await db.policyRule.create({
      data: {
        organizationId: team.organizationId,
        teamId: team.id,
        scope: 'team',
        scopeId: team.id,
        resourceType: 'schema',
        action,
        effect: 'allow',
        priority: 100,
        requiresApproval: false,
        createdById: 'schema-test',
        bindings: {
          create: [
            { actorType: 'role', actorId: 'owner' },
            { actorType: 'agent', actorId: 'agent:dev:agent_dev' },
          ],
        },
      },
    })
  }
})

afterAll(async () => {
  await closeServer()
  await db.$disconnect()
})

function structured(result: unknown): Record<string, unknown> {
  const value = ToolResult.parse(result).structuredContent
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected object structured content')
  }
  return z.record(z.unknown()).parse(value)
}

async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args })
}

function textContent(contents: Array<{ uri: string; text: string } | { uri: string; blob: string }>): string {
  const first = contents[0]
  if (first === undefined || !('text' in first)) throw new Error('Expected a text resource')
  return first.text
}

async function devTeam() {
  return db.team.findUniqueOrThrow({
    where: { externalTeamId: 'team_dev' }, select: { id: true, organizationId: true },
  })
}

describe('schema MCP tools and resources', () => {
  it('lists schema tool input descriptions', async () => {
    const tools = await client.listTools()
    const schemaTools = tools.tools.filter((tool) => tool.name.startsWith('crm_'))
    expect(schemaTools).toHaveLength(50)
    for (const tool of schemaTools) {
      const parsed = z.object({ properties: z.record(z.object({ description: z.string().min(1) })) })
        .parse(tool.inputSchema)
      if (tool.name !== 'crm_webhook_list') {
        expect(Object.keys(parsed.properties)).not.toHaveLength(0)
      }
    }
  })

  it('applies standard_crm and exposes its schema', async () => {
    const appliedResult = await call('crm_template_apply', { template: 'standard_crm' })
    const applied = structured(appliedResult)
    expect(applied).toMatchObject({
      added: {
        object_types: expect.any(Number), attributes: expect.any(Number),
        relation_types: expect.any(Number), matching_rules: expect.any(Number),
      },
    })
    const text = z.object({ type: z.literal('text'), text: z.string() })
      .parse(ToolResult.parse(appliedResult).content[0])
    expect(JSON.parse(text.text)).toEqual(applied)

    const schema = structured(await call('crm_schema_get', {}))
    const snapshot = z.object({ schema_version: z.number().int(), object_types: z.array(z.object({ slug: z.string() })) })
      .parse(schema)
    expect(snapshot.object_types.map((objectType) => objectType.slug)).toEqual(expect.arrayContaining([
      'person', 'company', 'deal',
    ]))

    const unknown = structured(await call('crm_template_apply', { template: 'not_a_template' }))
    expect(unknown).toMatchObject({ code: 'UNKNOWN_TEMPLATE', available: ['system', 'standard_crm'] })
  })

  it('defines a custom object with a record_reference attribute', async () => {
    const team = await devTeam()
    await db.objectType.deleteMany({
      where: { organizationId: team.organizationId, teamId: team.id, slug: 'subscription' },
    })
    const result = structured(await call('crm_object_type_define', {
      slug: 'subscription',
      singular_name: 'Subscription',
      plural_name: 'Subscriptions',
      description: 'A customer subscription.',
      primary_attribute: 'name',
      attributes: [
        {
          slug: 'name', name: 'Name', description: 'Subscription name.', type: 'text',
          config: { maxLength: 200 }, is_required: true,
        },
        {
          slug: 'company', name: 'Company', description: 'Company that owns the subscription.',
          type: 'record_reference', config: { objectTypes: ['company'] },
        },
      ],
    }))
    const detail = z.object({
      slug: z.literal('subscription'), primary_attribute: z.literal('name'),
      attributes: z.array(z.object({ slug: z.string(), type: z.string() })),
    }).parse(result)
    expect(detail.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'company', type: 'record_reference' }),
    ]))
  })

  it('archives an attribute only after a valid MRTR retry and re-challenges tampering', async () => {
    const team = await devTeam()
    const person = await db.objectType.findFirstOrThrow({
      where: { organizationId: team.organizationId, teamId: team.id, slug: 'person' }, select: { id: true },
    })
    await db.record.deleteMany({
      where: {
        organizationId: team.organizationId,
        teamId: team.id,
        objectTypeId: person.id,
        createdById: 'schema-test',
      },
    })
    await db.attribute.deleteMany({
      where: { organizationId: team.organizationId, teamId: team.id, objectTypeId: person.id, slug: 'fax' },
    })
    await call('crm_attribute_define', {
      object_type: 'person', slug: 'fax', name: 'Fax', description: 'A fax number.', type: 'text',
      config: { maxLength: 64 },
    })
    await db.record.create({
      data: {
        organizationId: team.organizationId,
        teamId: team.id,
        objectTypeId: person.id,
        data: { fax: '020 7946 0000' },
        displayName: 'Fax fixture',
        createdByType: 'system',
        createdById: 'schema-test',
      },
    })

    const args = { object_type: 'person', attribute: 'fax', reason: 'Fax is retired.' }
    const initial = ArchiveInputRequired.parse(await call('crm_attribute_archive', args))
    expect(initial.inputRequests.confirm.params.requestedSchema.required).toEqual(['confirmed'])

    const tampered = `${initial.requestState}.corrupt`
    const retryRequest = {
      method: 'tools/call' as const,
      params: {
        name: 'crm_attribute_archive', arguments: args,
        inputResponses: { confirm: { action: 'accept' as const, content: { confirmed: true } } },
        requestState: tampered,
      },
    }
    const rechallenged = ArchiveInputRequired.parse(await client.request(retryRequest, ToolResult))
    expect(rechallenged.requestState).not.toBe(tampered)

    const confirmed = structured(await client.request({
      ...retryRequest,
      params: { ...retryRequest.params, requestState: rechallenged.requestState },
    }, ToolResult))
    expect(confirmed).toEqual({ archived: true, records_with_values: 1 })
    await expect(db.auditLog.findFirstOrThrow({
      where: {
        organizationId: team.organizationId,
        teamId: team.id,
        action: 'archive',
        resourceType: 'attribute',
      },
      orderBy: { createdAt: 'desc' },
    })).resolves.toMatchObject({ reason: 'Fax is retired.' })
  })

  it('returns an approval challenge for schema define rules that require approval', async () => {
    const team = await devTeam()
    await db.policyRule.deleteMany({
      where: {
        organizationId: team.organizationId,
        teamId: team.id,
        createdById: 'schema-approval-test',
      },
    })
    const actions: ReadonlyArray<'view' | 'define'> = ['view', 'define']
    const ruleIds: string[] = []
    try {
      for (const action of actions) {
        const rule = await db.policyRule.create({
          data: {
            organizationId: team.organizationId,
            teamId: team.id,
            scope: 'team',
            scopeId: team.id,
            resourceType: 'schema',
            action,
            effect: 'allow',
            priority: 200,
            requiresApproval: true,
            createdById: 'schema-approval-test',
            bindings: {
              create: [
                { actorType: 'role', actorId: 'owner' },
                { actorType: 'agent', actorId: 'agent:dev:agent_dev' },
              ],
            },
          },
          select: { id: true },
        })
        ruleIds.push(rule.id)
      }
      const before = await db.objectType.count({
        where: { organizationId: team.organizationId, teamId: team.id },
      })
      const auditsBefore = await db.auditLog.count({
        where: { organizationId: team.organizationId, teamId: team.id },
      })
      expect(structured(await call('crm_schema_get', {}))).toMatchObject({ code: 'APPROVAL_REQUIRED' })
      const challenge = ApprovalInputRequired.parse(await call('crm_object_type_define', {
        slug: 'approval_probe',
        singular_name: 'Approval probe',
        plural_name: 'Approval probes',
        description: 'Must not be created before approval.',
      }))
      expect(challenge.inputRequests.approval.method).toBe('elicitation/create')
      await expect(db.objectType.count({
        where: { organizationId: team.organizationId, teamId: team.id },
      })).resolves.toBe(before)
      await expect(db.auditLog.count({
        where: { organizationId: team.organizationId, teamId: team.id },
      })).resolves.toBe(auditsBefore + 1)
      await expect(db.auditLog.findFirstOrThrow({
        where: { organizationId: team.organizationId, teamId: team.id },
        orderBy: { createdAt: 'desc' },
      })).resolves.toMatchObject({ action: 'approval.requested', resourceType: 'approval' })
    } finally {
      await db.policyRule.deleteMany({
        where: {
          organizationId: team.organizationId,
          teamId: team.id,
          id: { in: ruleIds },
        },
      })
    }
  })

  it('reads schema resources and advertises the schema URI template', async () => {
    const schemaResource = await client.readResource({ uri: 'crm://schema' })
    const schemaText = textContent(schemaResource.contents)
    expect(z.object({ schema_version: z.number().int() }).parse(JSON.parse(schemaText))).toBeDefined()

    const templatesResource = await client.readResource({ uri: 'crm://templates' })
    const templatesText = textContent(templatesResource.contents)
    expect(z.object({ templates: z.array(z.object({ slug: z.string() })) }).parse(JSON.parse(templatesText)))
      .toMatchObject({ templates: expect.arrayContaining([{ slug: 'standard_crm' }]) })

    const templates = await client.listResourceTemplates()
    expect(templates.resourceTemplates.map((template) => template.uriTemplate))
      .toContain('crm://schema/{object_type}')
  })
})
