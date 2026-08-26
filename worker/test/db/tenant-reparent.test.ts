import { createDb, dropTenant, Prisma, seedTenant, writeAudit } from '@deepcrm/db'
import { complete, enqueue, progress } from '@deepcrm/queue'
import { afterAll, describe, expect, it } from 'vitest'

import type { JobHandlerInput } from '../../src/index.js'
import { tenantReparentHandler, TENANT_REPARENT_JOB } from '../../src/jobs/tenant-reparent.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for tenant reparent tests')

const db = createDb(databaseUrl)
const organizationIds: string[] = []

type Phase8Fixture = Readonly<{
  objectTypeId: string
  attributeGroupId: string
  pipelineId: string
  pipelineStageId: string
  derivedAttributeId: string
  derivationDependencyId: string
  recordId: string
  stageHistoryId: string
  fileId: string
  fileLinkId: string
  eventTypeId: string
  eventId: string
  migrationReportId: string
}>

async function input(payload: Prisma.InputJsonObject): Promise<JobHandlerInput> {
  const workerId = crypto.randomUUID()
  const jobId = await enqueue(db, {
    organizationId: String(payload['sourceOrganizationId']),
    teamId: String(payload['teamId']),
    type: TENANT_REPARENT_JOB,
    payload,
  })
  await db.queueJob.update({
    where: { id: jobId.id },
    data: { status: 'running', lockedBy: workerId, lockedAt: new Date(), attempts: 1 },
  })
  const job = await db.queueJob.findUniqueOrThrow({ where: { id: jobId.id } })
  return {
    db,
    job,
    workerId,
    clock: () => new Date('2026-08-24T12:00:00.000Z'),
    writeAudit,
    progress: (value) => progress(db, job.id, workerId, value),
    terminalize: (tx, result) => complete(tx, job.id, workerId, result),
  }
}

async function createPhase8Rows(
  organizationId: string,
  teamId: string,
): Promise<Phase8Fixture> {
  const objectType = await db.objectType.create({
    data: {
      organizationId,
      teamId,
      slug: 'case',
      singularName: 'Case',
      pluralName: 'Cases',
      description: 'Case',
      kind: 'custom',
      createdByType: 'system',
      createdById: 'tenant-reparent-test',
    },
  })
  const attributeGroup = await db.attributeGroup.create({
    data: {
      organizationId,
      teamId,
      objectTypeId: objectType.id,
      slug: 'details',
      name: 'Details',
      createdByType: 'system',
      createdById: 'tenant-reparent-test',
    },
  })
  const sourceAttribute = await db.attribute.create({
    data: {
      organizationId,
      teamId,
      objectTypeId: objectType.id,
      groupId: attributeGroup.id,
      slug: 'name',
      name: 'Name',
      description: 'Name',
      type: 'text',
      config: { type: 'text', maxLength: 100 },
    },
  })
  const derivedAttribute = await db.attribute.create({
    data: {
      organizationId,
      teamId,
      objectTypeId: objectType.id,
      slug: 'derived_score',
      name: 'Derived score',
      description: 'Derived score',
      type: 'number',
      valueSource: 'score',
      config: { type: 'number', min: 0 },
    },
  })
  await db.attributeDerivation.create({
    data: {
      organizationId,
      teamId,
      attributeId: derivedAttribute.id,
      valueSource: 'score',
      config: { source: 'test' },
    },
  })
  const derivationDependency = await db.attributeDerivationDependency.create({
    data: {
      organizationId,
      teamId,
      attributeId: derivedAttribute.id,
      sourceAttributeId: sourceAttribute.id,
      sourceKind: 'attribute',
      sourcePath: ['name'],
    },
  })
  const pipeline = await db.pipeline.create({
    data: {
      organizationId,
      teamId,
      objectTypeId: objectType.id,
      slug: 'cases',
      name: 'Cases',
      isDefault: true,
      createdByType: 'system',
      createdById: 'tenant-reparent-test',
    },
  })
  const pipelineStage = await db.pipelineStage.create({
    data: {
      organizationId,
      teamId,
      pipelineId: pipeline.id,
      slug: 'open',
      name: 'Open',
      position: 0,
      category: 'open',
    },
  })
  const record = await db.record.create({
    data: {
      organizationId,
      teamId,
      objectTypeId: objectType.id,
      data: { name: 'Case A' },
      displayName: 'Case A',
      visibility: 'team',
      createdByType: 'system',
      createdById: 'tenant-reparent-test',
    },
  })
  const stageHistory = await db.recordStageHistory.create({
    data: {
      organizationId,
      teamId,
      recordId: record.id,
      pipelineId: pipeline.id,
      stageId: pipelineStage.id,
      startedAt: new Date('2026-08-24T12:00:00.000Z'),
      actorType: 'system',
      actorId: 'tenant-reparent-test',
      requestId: crypto.randomUUID(),
    },
  })
  const file = await db.fileObject.create({
    data: {
      organizationId,
      teamId,
      provider: 's3',
      providerKey: `case/${crypto.randomUUID()}`,
      filename: 'case.txt',
      mimeType: 'text/plain',
      sizeBytes: 12n,
      createdByType: 'system',
      createdById: 'tenant-reparent-test',
    },
  })
  const eventType = await db.eventType.create({
    data: {
      organizationId,
      teamId,
      slug: 'case_opened',
      name: 'Case opened',
      subjectObjectTypeId: objectType.id,
      createdByType: 'system',
      createdById: 'tenant-reparent-test',
    },
  })
  const event = await db.event.create({
    data: {
      organizationId,
      teamId,
      eventTypeId: eventType.id,
      source: 'test',
      externalId: crypto.randomUUID(),
      occurredAt: new Date('2026-08-24T12:00:00.000Z'),
      subjectRecordId: record.id,
      createdByType: 'system',
      createdById: 'tenant-reparent-test',
    },
  })
  const fileLink = await db.fileLink.create({
    data: {
      organizationId,
      teamId,
      fileId: file.id,
      targetType: 'event',
      eventId: event.id,
      purpose: 'evidence',
      createdByType: 'system',
      createdById: 'tenant-reparent-test',
    },
  })
  const migrationReport = await db.migrationReport.create({
    data: {
      organizationId,
      teamId,
      migrationName: 'tenant-reparent-test',
      code: 'sample',
      resourceType: 'team',
      resourceId: teamId,
    },
  })
  return {
    objectTypeId: objectType.id,
    attributeGroupId: attributeGroup.id,
    pipelineId: pipeline.id,
    pipelineStageId: pipelineStage.id,
    derivedAttributeId: derivedAttribute.id,
    derivationDependencyId: derivationDependency.id,
    recordId: record.id,
    stageHistoryId: stageHistory.id,
    fileId: file.id,
    fileLinkId: fileLink.id,
    eventTypeId: eventType.id,
    eventId: event.id,
    migrationReportId: migrationReport.id,
  }
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizationIds } } })
  await db.queueJob.deleteMany({ where: { organizationId: { in: organizationIds } } })
  for (const organizationId of [...organizationIds].reverse()) {
    await dropTenant(db, organizationId).catch(() => undefined)
  }
  await db.$disconnect()
})

describe('tenant reparent worker', () => {
  it('rewrites tenant-scoped rows, flips the team last, and audits completion', async () => {
    const source = await seedTenant(db)
    organizationIds.push(source.organizationId)
    const target = await db.organization.create({
      data: { externalOrgId: `org_target_${crypto.randomUUID()}`, name: 'Target org' },
    })
    organizationIds.push(target.id)
    const seeded = await createPhase8Rows(source.organizationId, source.teamId)
    await expect(db.event.update({
      where: { id: seeded.eventId },
      data: { source: 'changed-before-reparent' },
    })).rejects.toThrow('events are immutable')
    await tenantReparentHandler(await input({
      teamId: source.teamId,
      sourceOrganizationId: source.organizationId,
      targetOrganizationId: target.id,
      externalOrgId: target.externalOrgId,
      externalTeamId: source.externalTeamId,
      requestId: 'tenant_reparent_request',
      uoaUserId: 'usr_reparent',
    }))

    await expect(db.team.findUniqueOrThrow({ where: { id: source.teamId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.objectType.findUniqueOrThrow({ where: { id: seeded.objectTypeId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.attributeGroup.findUniqueOrThrow({ where: { id: seeded.attributeGroupId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.pipeline.findUniqueOrThrow({ where: { id: seeded.pipelineId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.pipelineStage.findUniqueOrThrow({ where: { id: seeded.pipelineStageId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.attributeDerivation.findUniqueOrThrow({ where: { attributeId: seeded.derivedAttributeId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.attributeDerivationDependency.findUniqueOrThrow({ where: { id: seeded.derivationDependencyId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.record.findUniqueOrThrow({ where: { id: seeded.recordId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.recordStageHistory.findUniqueOrThrow({ where: { id: seeded.stageHistoryId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.fileObject.findUniqueOrThrow({ where: { id: seeded.fileId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.fileLink.findUniqueOrThrow({ where: { id: seeded.fileLinkId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.eventType.findUniqueOrThrow({ where: { id: seeded.eventTypeId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.event.findUniqueOrThrow({ where: { id: seeded.eventId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.migrationReport.findUniqueOrThrow({ where: { id: seeded.migrationReportId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.event.update({
      where: { id: seeded.eventId },
      data: { source: 'changed-after-reparent' },
    })).rejects.toThrow('events are immutable')
    await expect(db.record.count({
      where: { organizationId: source.organizationId, teamId: source.teamId },
    })).resolves.toBe(0)
    await expect(db.recordStageHistory.count({
      where: { organizationId: source.organizationId, teamId: source.teamId },
    })).resolves.toBe(0)
    await expect(db.fileObject.count({
      where: { organizationId: source.organizationId, teamId: source.teamId },
    })).resolves.toBe(0)
    await expect(db.event.count({
      where: { organizationId: source.organizationId, teamId: source.teamId },
    })).resolves.toBe(0)
    await expect(db.auditLog.findFirstOrThrow({
      where: { organizationId: target.id, teamId: source.teamId, action: 'tenant.reparent.completed' },
    })).resolves.toMatchObject({
      actorType: 'system',
      actorId: 'tenant.reparent',
      onBehalfOf: 'usr_reparent',
    })
  })
})
