import { createDb, dropTenant, seedTenant, writeAudit, type PolicyAction, type PolicyEffect } from '@deepcrm/db'
import { createProjectionLinkWriter, defineObjectType, FakeEmbedder } from '@deepcrm/schema-engine'
import { parseSecretBox, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import {
  archiveSchemaAttribute,
  archiveSchemaObject,
  archiveSchemaRelation,
  defineSchemaAttribute,
  defineSchemaObject,
  defineSchemaRelation,
  getSchema,
  replaceSchemaMatchingRules,
  runSchemaDefine,
  updateSchemaAttribute,
  updateSchemaObject,
  updateSchemaRelation,
} from '../../src/services/schema.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for schema service tests')

const db = createDb(databaseUrl)
const organizationIds: string[] = []
const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSJ9fQ=='
const deps: AppDeps = {
  db,
  clock: () => new Date(),
  ids: () => crypto.randomUUID(),
  version: '0.0.0',
  maxBulkRows: 10_000,
  embedder: new FakeEmbedder('api-test'),
  orgAllowlist: null,
  linkWriter: createProjectionLinkWriter(),
  historyCursor: createHistoryCursorCodec(parseSecretBox(keyring)),
  queryCursor: createQueryCursorCodec(parseSecretBox(keyring)),
  secretBox: parseSecretBox(keyring),
  writeAudit,
}
type Tenant = { organizationId: string; teamId: string }

function context(tenant: Tenant): ActorContext {
  return {
    tenant,
    app: 'test',
    actChain: [],
    actor: { type: 'human', id: 'uoa_schema_user' },
    onBehalfOf: { uoaUserId: 'uoa_schema_user', role: 'member' },
    provenance: null,
    requestId: crypto.randomUUID(),
    now: new Date(),
  }
}

async function tenant(): Promise<Tenant> {
  const created = await seedTenant(db)
  organizationIds.push(created.organizationId)
  return created
}

async function addSchemaRule(
  target: Tenant,
  effect: PolicyEffect,
  requiresApproval = false,
  action: PolicyAction = 'define',
): Promise<void> {
  await db.policyRule.create({
    data: {
      organizationId: target.organizationId,
      teamId: target.teamId,
      scope: 'team',
      scopeId: target.teamId,
      resourceType: 'schema',
      action,
      effect,
      priority: 0,
      requiresApproval,
      createdById: 'test',
      bindings: { create: [{ actorType: 'role', actorId: 'member' }] },
    },
  })
}

async function metadataState(target: Tenant) {
  const where = { organizationId: target.organizationId, teamId: target.teamId }
  const [teamRow, objectTypes, attributes, relationTypes, matchingRules, audits] = await Promise.all([
    db.team.findFirstOrThrow({ where: { id: target.teamId, organizationId: target.organizationId } }),
    db.objectType.count({ where }),
    db.attribute.count({ where }),
    db.relationType.count({ where }),
    db.matchingRule.count({ where }),
    db.auditLog.count({ where }),
  ])
  return {
    schemaVersion: teamRow.schemaVersion,
    objectTypes,
    attributes,
    relationTypes,
    matchingRules,
    audits,
  }
}

async function createFixtureObject(target: Tenant, slug: string) {
  return db.objectType.create({
    data: {
      organizationId: target.organizationId,
      teamId: target.teamId,
      slug,
      singularName: slug,
      pluralName: `${slug}s`,
      description: `${slug} fixture`,
      kind: 'custom',
      createdByType: 'system',
      createdById: 'fixture',
    },
  })
}

afterAll(async () => {
  for (const organizationId of organizationIds) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('schema service transaction and policy seam', () => {
  it('policy-denies every mutation wrapper before metadata, version, or audit changes', async () => {
    const target = await tenant()
    const ctx = context(target)
    const before = await metadataState(target)
    const operations: Array<() => Promise<unknown>> = [
      () => defineSchemaObject(deps, ctx, {
        slug: 'account', singularName: 'Account', pluralName: 'Accounts', description: 'An account',
      }),
      () => defineSchemaAttribute(deps, ctx, {
        objectType: 'account', slug: 'name', name: 'Name', description: 'The name', type: 'text',
        config: { maxLength: 120 }, is_multi: false, is_required: false, is_unique: false,
        is_indexed: false, sensitivity: 'internal',
      }),
      () => defineSchemaRelation(deps, ctx, {
        slug: 'account_contact', fromObjectType: 'account', toObjectType: 'contact',
        forwardName: 'Contacts', inverseName: 'Account', cardinality: 'one_to_many',
      }),
      () => updateSchemaObject(deps, ctx, 'account', { description: 'Updated' }),
      () => archiveSchemaObject(deps, ctx, 'account'),
      () => updateSchemaAttribute(deps, ctx, 'account', 'name', { name: 'Updated name' }),
      () => archiveSchemaAttribute(deps, ctx, 'account', 'name'),
      () => updateSchemaRelation(deps, ctx, 'account_contact', { description: 'Updated' }),
      () => archiveSchemaRelation(deps, ctx, 'account_contact'),
      () => replaceSchemaMatchingRules(deps, ctx, 'account', { rules: [] }),
    ]

    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    }
    expect(await metadataState(target)).toEqual(before)
  })

  it('approval-required denial performs no metadata, version, or audit changes', async () => {
    const target = await tenant()
    const ctx = context(target)
    await addSchemaRule(target, 'deny', true)
    const before = await metadataState(target)

    await expect(defineSchemaObject(deps, ctx, {
      slug: 'account', singularName: 'Account', pluralName: 'Accounts', description: 'An account',
    })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(await metadataState(target)).toEqual(before)
  })

  it('allow rules requiring approval block schema view and define before schema work', async () => {
    const target = await tenant()
    const ctx = context(target)
    await addSchemaRule(target, 'allow', true, 'view')
    await addSchemaRule(target, 'allow', true, 'define')
    const before = await metadataState(target)

    await expect(getSchema(deps, ctx)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    await expect(defineSchemaObject(deps, ctx, {
      slug: 'account', singularName: 'Account', pluralName: 'Accounts', description: 'An account',
    })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(await metadataState(target)).toEqual(before)
  })

  it('commits one atomic mutation with one version and audit', async () => {
    const target = await tenant()
    const ctx = context(target)
    await addSchemaRule(target, 'allow')
    const created = await defineSchemaObject(deps, ctx, {
      slug: 'account', singularName: 'Account', pluralName: 'Accounts', description: 'An account',
    })
    expect(created).toMatchObject({
      organizationId: target.organizationId,
      teamId: target.teamId,
      slug: 'account',
    })

    expect(await metadataState(target)).toEqual({
      schemaVersion: 1,
      objectTypes: 1,
      attributes: 0,
      relationTypes: 0,
      matchingRules: 0,
      audits: 1,
    })
    await expect(db.auditLog.findFirstOrThrow({
      where: { organizationId: target.organizationId, teamId: target.teamId },
    })).resolves.toMatchObject({
      actorType: 'human',
      actorId: 'uoa_schema_user',
      onBehalfOf: 'uoa_schema_user',
      action: 'define',
      resourceType: 'object_type',
      outcome: 'success',
      requestId: ctx.requestId,
    })
  })

  it('rolls back a completed engine mutation when the injected operation then fails', async () => {
    const target = await tenant()
    const ctx = context(target)
    await addSchemaRule(target, 'allow')
    const before = await metadataState(target)

    await expect(runSchemaDefine(deps, ctx, async (tx, auditActor) => {
      await defineObjectType(tx, target, auditActor, {
        slug: 'account', singularName: 'Account', pluralName: 'Accounts', description: 'An account',
      })
      throw new Error('injected schema failure')
    })).rejects.toThrow('injected schema failure')
    expect(await metadataState(target)).toEqual(before)
  })

  it('rolls back partial metadata after a real engine conflict', async () => {
    const target = await tenant()
    const ctx = context(target)
    await addSchemaRule(target, 'allow')
    const source = await createFixtureObject(target, 'source')
    const destination = await createFixtureObject(target, 'destination')
    await db.relationType.create({
      data: {
        organizationId: target.organizationId,
        teamId: target.teamId,
        slug: 'source_reference',
        fromObjectTypeId: destination.id,
        toObjectTypeId: destination.id,
        forwardName: 'Reference',
        inverseName: 'Sources',
        cardinality: 'many_to_one',
      },
    })
    const before = await metadataState(target)

    await expect(defineSchemaAttribute(deps, ctx, {
      objectType: source.slug,
      slug: 'reference',
      name: 'Reference',
      description: 'A conflicting reference',
      type: 'record_reference',
      config: { objectTypes: [destination.slug], relationTypeSlug: 'source_reference' },
      is_multi: false,
      is_required: false,
      is_unique: false,
      is_indexed: true,
      sensitivity: 'internal',
    })).rejects.toMatchObject({ code: 'SCHEMA_CONFLICT' })
    expect(await metadataState(target)).toEqual(before)
    await expect(db.attribute.findFirst({
      where: {
        organizationId: target.organizationId,
        teamId: target.teamId,
        objectTypeId: source.id,
        slug: 'reference',
      },
    })).resolves.toBeNull()
  })

  it('keeps wrapper mutations and loaded schemas isolated by tenant pair', async () => {
    const first = await tenant()
    const second = await tenant()
    const ctx = context(first)
    await addSchemaRule(first, 'allow')
    await createFixtureObject(second, 'second_only')

    await defineSchemaObject(deps, ctx, {
      slug: 'first_only', singularName: 'First', pluralName: 'Firsts', description: 'First tenant only',
    })
    const [firstSchema, secondSchema] = await Promise.all([
      getSchema(deps, ctx),
      getSchema(deps, context(second)),
    ])

    expect(firstSchema.objectTypes.map((objectType) => objectType.slug)).toEqual(['first_only'])
    expect(secondSchema.objectTypes.map((objectType) => objectType.slug)).toEqual(['second_only'])
    expect(firstSchema.objectTypes[0]).toMatchObject({
      organizationId: first.organizationId,
      teamId: first.teamId,
    })
    expect(secondSchema.objectTypes[0]).toMatchObject({
      organizationId: second.organizationId,
      teamId: second.teamId,
    })
  })

  it('allows update and archive wrappers for attributes and relations', async () => {
    const target = await tenant()
    const ctx = context(target)
    await addSchemaRule(target, 'allow')
    const source = await createFixtureObject(target, 'source')
    const destination = await createFixtureObject(target, 'destination')
    const attribute = await db.attribute.create({
      data: {
        organizationId: target.organizationId,
        teamId: target.teamId,
        objectTypeId: source.id,
        slug: 'name',
        name: 'Name',
        description: 'Original name',
        type: 'text',
        config: { maxLength: 120 },
        isMulti: false,
        isRequired: false,
        isUnique: false,
        isIndexed: true,
        isSystem: false,
        sensitivity: 'internal',
        position: 0,
      },
    })
    const relation = await db.relationType.create({
      data: {
        organizationId: target.organizationId,
        teamId: target.teamId,
        slug: 'source_destination',
        fromObjectTypeId: source.id,
        toObjectTypeId: destination.id,
        forwardName: 'Destination',
        inverseName: 'Sources',
        description: 'Original relation',
        cardinality: 'many_to_one',
      },
    })

    await expect(updateSchemaAttribute(deps, ctx, 'source', 'name', {
      name: 'Legal name',
      description: 'Updated name',
    })).resolves.toMatchObject({ id: attribute.id, name: 'Legal name' })
    await expect(updateSchemaRelation(deps, ctx, 'source_destination', {
      forwardName: 'Primary destination',
      description: 'Updated relation',
    })).resolves.toMatchObject({ id: relation.id, forwardName: 'Primary destination' })
    await expect(archiveSchemaAttribute(deps, ctx, 'source', 'name'))
      .resolves.toMatchObject({ id: attribute.id })
    await expect(archiveSchemaRelation(deps, ctx, 'source_destination'))
      .resolves.toMatchObject({ id: relation.id })

    expect(await metadataState(target)).toEqual({
      schemaVersion: 4,
      objectTypes: 2,
      attributes: 1,
      relationTypes: 1,
      matchingRules: 0,
      audits: 4,
    })
    await expect(db.attribute.findUniqueOrThrow({ where: { id: attribute.id } }))
      .resolves.toMatchObject({ name: 'Legal name', archivedAt: expect.any(Date) })
    await expect(db.relationType.findUniqueOrThrow({ where: { id: relation.id } }))
      .resolves.toMatchObject({ forwardName: 'Primary destination', archivedAt: expect.any(Date) })

    await expect(getSchema(deps, ctx, 'source')).resolves.toMatchObject({
      id: source.id,
      slug: 'source',
      attributes: [],
    })
    await expect(getSchema(deps, ctx, 'missing')).rejects.toMatchObject({
      code: 'UNKNOWN_OBJECT_TYPE',
    })
  })
})
