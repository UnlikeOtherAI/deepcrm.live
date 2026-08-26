import {
  createProjectionLinkWriter,
  FakeEmbedder,
} from '@deepcrm/schema-engine'
import {
  dropTenant,
  seedTenant,
  writeAudit,
  type Db,
  type PolicyEffect,
  type PolicyResourceType,
} from '@deepcrm/db'
import { parseSecretBox, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../../src/deps.js'
import { testFileAccess } from '../file-access-fixture.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'

export type LinkTenant = { organizationId: string; teamId: string }
export type LinkFixture = {
  tenant: LinkTenant
  people: string[]
  companies: string[]
  relations: Record<'manyMany' | 'manyOne' | 'oneMany' | 'oneOne' | 'edgeMany', string>
}

const now = new Date('2026-08-24T12:00:00.000Z')
const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSJ9fQ=='

export function linkDeps(db: Db): AppDeps {
  return {
    db,
    clock: () => now,
    ids: () => crypto.randomUUID(),
    version: '0.0.0',
    maxBulkRows: 10_000, maxExportRows: 100_000,
    orgAllowlist: null,
    linkWriter: createProjectionLinkWriter(),
    historyCursor: createHistoryCursorCodec(parseSecretBox(keyring)),
    queryCursor: createQueryCursorCodec(parseSecretBox(keyring)),
    secretBox: parseSecretBox(keyring),
    embedder: new FakeEmbedder('api-test'),
    fileAccess: testFileAccess,
    writeAudit,
  }
}

export function linkContext(
  tenant: LinkTenant,
  userId = 'uoa_link_user',
): ActorContext {
  return {
    tenant,
    app: 'test',
    actChain: [],
    actor: { type: 'human', id: userId },
    onBehalfOf: { uoaUserId: userId, role: 'owner' },
    provenance: { runId: 'run_links', toolCallId: crypto.randomUUID(), requestId: crypto.randomUUID() },
    requestId: crypto.randomUUID(),
    now,
  }
}

export async function createLinkFixture(db: Db): Promise<LinkFixture> {
  const seeded = await seedTenant(db)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  return db.$transaction(async (tx) => {
    const person = await tx.objectType.create({
      data: {
        ...tenant,
        slug: 'person',
        singularName: 'Person',
        pluralName: 'People',
        description: 'A person',
        kind: 'custom',
        createdByType: 'system',
        createdById: 'link_fixture',
      },
    })
    const company = await tx.objectType.create({
      data: {
        ...tenant,
        slug: 'company',
        singularName: 'Company',
        pluralName: 'Companies',
        description: 'A company',
        kind: 'custom',
        createdByType: 'system',
        createdById: 'link_fixture',
      },
    })
    const relationInput = (
      slug: string,
      cardinality: 'many_to_many' | 'many_to_one' | 'one_to_many' | 'one_to_one',
      edgeAttributes: object[] = [],
    ) => ({
      ...tenant,
      slug,
      fromObjectTypeId: person.id,
      toObjectTypeId: company.id,
      forwardName: 'Company',
      inverseName: 'People',
      cardinality,
      edgeAttributes,
    })
    const [manyMany, manyOne, oneMany, oneOne, edgeMany] = await Promise.all([
      tx.relationType.create({ data: relationInput('many_many', 'many_to_many') }),
      tx.relationType.create({ data: relationInput('many_one', 'many_to_one') }),
      tx.relationType.create({ data: relationInput('one_many', 'one_to_many') }),
      tx.relationType.create({ data: relationInput('one_one', 'one_to_one') }),
      tx.relationType.create({
        data: relationInput('edge_many', 'many_to_many', [{
          slug: 'role',
          name: 'Role',
          description: 'Role on the link',
          type: 'text',
          config: { type: 'text', maxLength: 40 },
          sensitivity: 'confidential',
        }]),
      }),
    ])
    const records = async (objectTypeId: string, prefix: string): Promise<string[]> => {
      const created: string[] = []
      for (let index = 1; index <= 4; index += 1) {
        const record = await tx.record.create({
          data: {
            ...tenant,
            objectTypeId,
            data: {},
            displayName: `${prefix} ${index}`,
            visibility: 'team',
            createdOnBehalfOf: 'uoa_link_user',
            createdByType: 'system',
            createdById: 'link_fixture',
          },
        })
        created.push(record.id)
      }
      return created
    }
    const [people, companies] = await Promise.all([
      records(person.id, 'Person'), records(company.id, 'Company'),
    ])
    await tx.team.update({ where: { id: tenant.teamId }, data: { schemaVersion: 1 } })
    return {
      tenant,
      people,
      companies,
      relations: {
        manyMany: manyMany.id,
        manyOne: manyOne.id,
        oneMany: oneMany.id,
        oneOne: oneOne.id,
        edgeMany: edgeMany.id,
      },
    }
  })
}

export async function addLinkPolicy(
  db: Db,
  tenant: LinkTenant,
  resourceType: PolicyResourceType,
  effect: PolicyEffect,
  userId: string,
  requiresApproval = false,
  sensitivity?: 'confidential' | 'restricted',
): Promise<void> {
  await db.policyRule.create({
    data: {
      ...tenant,
      scope: 'team',
      scopeId: tenant.teamId,
      resourceType,
      action: resourceType === 'attribute' ? 'edit' : 'link',
      effect,
      priority: 100,
      requiresApproval,
      ...(sensitivity === undefined ? {} : { conditions: { sensitivity } }),
      createdById: 'link_fixture',
      bindings: { create: [{ actorType: 'human', actorId: userId }] },
    },
  })
}

export async function dropLinkFixture(db: Db, tenant: LinkTenant): Promise<void> {
  await db.auditLog.deleteMany({
    where: { organizationId: tenant.organizationId, teamId: tenant.teamId },
  })
  await dropTenant(db, tenant.organizationId)
}
