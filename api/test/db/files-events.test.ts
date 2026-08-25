import { createDb, dropTenant, seedTenant, writeAudit, type TenantRef } from '@deepcrm/db'
import { applyTemplate, createProjectionLinkWriter, FakeEmbedder, loadSchema } from '@deepcrm/schema-engine'
import { ErrorCode, parseSecretBox, ServiceError, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import {
  defineEventType,
  ingestEvent,
  linkFile,
  listFiles,
  queryEvents,
  registerFile,
} from '../../src/services/files-events.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { seedDefaultPolicies } from '../../src/services/policy.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for file/event tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')
const secretBox = parseSecretBox(Buffer.from(JSON.stringify({
  active: 'files-v1', keys: { 'files-v1': Buffer.alloc(32, 61).toString('base64') },
})).toString('base64'))
const deps: AppDeps = {
  db, clock: () => now, ids: () => crypto.randomUUID(), version: '0.0.0',
  maxBulkRows: 10_000, maxExportRows: 100_000, orgAllowlist: null,
  linkWriter: createProjectionLinkWriter(), historyCursor: createHistoryCursorCodec(secretBox),
  queryCursor: createQueryCursorCodec(secretBox), secretBox, embedder: new FakeEmbedder('api-test'),
  writeAudit,
}

type Fixture = { tenant: TenantRef; ctx: ActorContext; personId: string; privateId: string }

function tenantData(tenant: TenantRef): TenantRef {
  return { organizationId: tenant.organizationId, teamId: tenant.teamId }
}

function context(tenant: TenantRef, user = 'file-user'): ActorContext {
  return {
    tenant, app: 'files-test', actChain: [], actor: { type: 'human', id: user },
    onBehalfOf: { uoaUserId: user, role: 'owner' },
    provenance: { runId: 'files-run', toolCallId: 'files-call', requestId: crypto.randomUUID() },
    requestId: crypto.randomUUID(), now,
  }
}

async function fixture(): Promise<Fixture> {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  await db.$transaction(async (tx) => {
    await seedDefaultPolicies(tx, tenant)
    await applyTemplate(tx, tenant, {
      type: 'system', id: 'files-fixture', onBehalfOf: null, requestId: ctx.requestId,
    }, 'standard_crm')
  })
  const schema = await loadSchema(db, tenant)
  const person = schema.objectTypesBySlug.get('person')
  if (person === undefined) throw new Error('standard template missing person')
  const visible = await db.record.create({ data: {
    ...tenantData(tenant), objectTypeId: person.id,
    data: { name: { given: 'File', family: 'Subject' } },
    displayName: 'File Subject', visibility: 'team', createdOnBehalfOf: 'file-user',
    createdByType: 'human', createdById: 'file-user',
  } })
  const hidden = await db.record.create({ data: {
    ...tenantData(tenant), objectTypeId: person.id,
    data: { name: { given: 'Hidden', family: 'Subject' } },
    displayName: 'Hidden Subject', visibility: 'private', createdOnBehalfOf: 'other-user',
    createdByType: 'human', createdById: 'other-user',
  } })
  return { tenant, ctx, personId: visible.id, privateId: hidden.id }
}

afterAll(async () => {
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('file and behavioural event services', () => {
  it('registers metadata-only files, links visible targets, and omits hidden linked files', async () => {
    const target = await fixture()
    const file = await registerFile(deps, target.ctx, {
      provider: 's3', providerKey: 'tenant/files/contract.pdf', filename: 'contract.pdf',
      mimeType: 'application/pdf', sizeBytes: '42',
      checksumSha256: 'a'.repeat(64), metadata: { bucket_region: 'eu-west-2' },
    })
    expect(file.file).toMatchObject({
      provider: 's3', provider_key: 'tenant/files/contract.pdf',
      filename: 'contract.pdf', mime_type: 'application/pdf', size_bytes: '42',
    })
    await expect(registerFile(deps, target.ctx, {
      provider: 's3', providerKey: 'tenant/files/contract.pdf', filename: 'different.pdf',
      mimeType: 'application/pdf', sizeBytes: '42',
    })).rejects.toMatchObject({ code: ErrorCode.SCHEMA_CONFLICT })
    await expect(registerFile(deps, target.ctx, {
      provider: 's3', providerKey: 'tenant/files/link', filename: 'link.txt',
      mimeType: 'text/plain', sizeBytes: '1', metadata: { signed_url: 'https://example.test/file' },
    })).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED })

    const link = await linkFile(deps, target.ctx, {
      fileId: file.file.id, targetType: 'record', recordId: target.personId,
      purpose: 'contract', metadata: { page_count: 3 },
    })
    expect(link.link).toMatchObject({ file_id: file.file.id, record_id: target.personId, purpose: 'contract' })
    await db.fileLink.create({ data: {
      ...tenantData(target.tenant), fileId: file.file.id, targetType: 'record',
      recordId: target.privateId, purpose: 'private-copy', metadata: {},
      createdByType: 'system', createdById: 'files-fixture',
    } })
    const listed = await listFiles(deps, target.ctx, {})
    expect(listed.files.map((item) => item.link.purpose)).toEqual(['contract'])
    expect(listed.files[0]?.access.expires_at).toBe('2026-08-24T12:05:00.000Z')
  })

  it('defines typed events, keeps external ids idempotent, and queries only visible subjects', async () => {
    const target = await fixture()
    const eventType = await defineEventType(deps, target.ctx, {
      slug: 'product_feature_used', name: 'Product feature used',
      subjectObjectType: 'person',
      propertySchema: {
        type: 'object', additionalProperties: false, required: ['feature'],
        properties: { feature: { type: 'string' }, count: { type: 'integer' } },
      },
    })
    expect(eventType.event_type).toMatchObject({
      slug: 'product_feature_used', subject_object_type: 'person',
    })
    await expect(ingestEvent(deps, target.ctx, {
      eventType: 'product_feature_used', source: 'app', externalId: 'bad-1',
      occurredAt: now.toISOString(), subjectRecordId: target.personId,
      properties: { feature: 12 },
    })).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED })

    const ingested = await ingestEvent(deps, target.ctx, {
      eventType: 'product_feature_used', source: 'app', externalId: 'evt-1',
      occurredAt: now.toISOString(), subjectRecordId: target.personId,
      actor: { type: 'human', id: 'file-user' }, properties: { feature: 'imports', count: 1 },
    })
    expect(ingested.created).toBe(true)
    await expect(ingestEvent(deps, target.ctx, {
      eventType: 'product_feature_used', source: 'app', externalId: 'evt-1',
      occurredAt: now.toISOString(), subjectRecordId: target.personId,
      properties: { feature: 'imports', count: 1 },
    })).resolves.toMatchObject({ created: false, event: { id: ingested.event.id } })
    const correction = await ingestEvent(deps, target.ctx, {
      eventType: 'product_feature_used', source: 'app', externalId: 'evt-1-correction',
      occurredAt: '2026-08-24T12:01:00.000Z', subjectRecordId: target.personId,
      properties: { feature: 'imports', count: 2 }, correctionOfEventId: ingested.event.id,
    })
    expect(correction.event).toMatchObject({ correction_of_event_id: ingested.event.id })

    await db.event.create({ data: {
      ...tenantData(target.tenant), eventTypeId: eventType.event_type.id,
      source: 'app', externalId: 'hidden-evt', occurredAt: now,
      subjectRecordId: target.privateId, properties: { feature: 'hidden' },
      createdByType: 'system', createdById: 'files-fixture',
    } })
    const queried = await queryEvents(deps, target.ctx, { eventType: 'product_feature_used', limit: 10 })
    expect(queried.events.map((event) => event.external_id)).toEqual(['evt-1-correction', 'evt-1'])
    await expect(queryEvents(deps, target.ctx, { subjectRecordId: target.privateId }))
      .rejects.toBeInstanceOf(ServiceError)
  })
})
