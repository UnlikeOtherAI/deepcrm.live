import { tenantWhere } from '@deepcrm/db'
import {
  buildSearchContent,
  loadSchema,
  type Embedder,
  type SearchContentLink,
} from '@deepcrm/schema-engine'
import { EMBEDDING_DIMENSIONS } from '@deepcrm/schemas'
import { z } from 'zod'

import type { JobHandler, JobHandlerInput } from '../index.js'

export const RECORD_REINDEX_JOB = 'record.reindex'
export const RECORD_REINDEX_NEIGHBOURS_JOB = 'record.reindex_neighbours'

const RecordReindexPayload = z.object({
  organizationId: z.string().uuid(),
  teamId: z.string().uuid(),
  recordId: z.string().uuid(),
}).strict()

const RecordReindexNeighboursPayload = RecordReindexPayload.extend({
  neighbourRecordIds: z.array(z.string().uuid()).max(500),
}).strict()

function recordData(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Stored record data is invalid')
  }
  return { ...value }
}

async function removeSearch(input: JobHandlerInput, tenant: z.infer<typeof RecordReindexPayload>): Promise<void> {
  await input.db.$executeRaw`
    DELETE FROM record_search
    WHERE record_id = ${tenant.recordId}::uuid
      AND organization_id = ${tenant.organizationId}::uuid
      AND team_id = ${tenant.teamId}::uuid
  `
}

function activeRelatedRecord(
  record: {
    organizationId: string; teamId: string; displayName: string
    deletedAt: Date | null; mergedIntoId: string | null; erasedAt: Date | null
  },
  tenant: z.infer<typeof RecordReindexPayload>,
): boolean {
  return record.organizationId === tenant.organizationId && record.teamId === tenant.teamId
    && record.deletedAt === null && record.mergedIntoId === null && record.erasedAt === null
}

async function searchLinks(
  input: JobHandlerInput,
  tenant: z.infer<typeof RecordReindexPayload>,
): Promise<SearchContentLink[]> {
  const links = await input.db.recordLink.findMany({
    where: {
      ...tenantWhere(tenant),
      activeUntil: null,
      OR: [{ fromRecordId: tenant.recordId }, { toRecordId: tenant.recordId }],
    },
    select: {
      relationTypeId: true, fromRecordId: true, toRecordId: true,
      fromRecord: { select: {
        organizationId: true, teamId: true, displayName: true,
        deletedAt: true, mergedIntoId: true, erasedAt: true,
      } },
      toRecord: { select: {
        organizationId: true, teamId: true, displayName: true,
        deletedAt: true, mergedIntoId: true, erasedAt: true,
      } },
    },
    orderBy: [{ relationTypeId: 'asc' }, { position: 'asc' }, { id: 'asc' }],
  })
  return links.flatMap((link) => {
    const forward = link.fromRecordId === tenant.recordId
    const related = forward ? link.toRecord : link.fromRecord
    if (!activeRelatedRecord(related, tenant)) return []
    return [{
      relationTypeId: link.relationTypeId,
      direction: forward ? 'forward' as const : 'inverse' as const,
      relatedDisplayName: related.displayName,
    }]
  })
}

async function storeKeywordContent(
  input: JobHandlerInput,
  payload: z.infer<typeof RecordReindexPayload>,
  objectTypeId: string,
  content: string,
): Promise<void> {
  const count = await input.db.$executeRaw`
    INSERT INTO record_search (
      record_id, organization_id, team_id, object_type_id, content,
      embedding, embedding_model, indexed_at
    ) VALUES (
      ${payload.recordId}::uuid, ${payload.organizationId}::uuid, ${payload.teamId}::uuid,
      ${objectTypeId}::uuid, ${content}, NULL, NULL, ${input.clock()}
    )
    ON CONFLICT (record_id) DO UPDATE SET
      object_type_id = EXCLUDED.object_type_id,
      content = EXCLUDED.content,
      embedding = NULL,
      embedding_model = NULL,
      indexed_at = EXCLUDED.indexed_at
    WHERE record_search.organization_id = EXCLUDED.organization_id
      AND record_search.team_id = EXCLUDED.team_id
  `
  if (count !== 1) throw new Error('Record search tenant conflict')
}

async function storeEmbedding(
  input: JobHandlerInput,
  payload: z.infer<typeof RecordReindexPayload>,
  embedder: Embedder,
  content: string,
  embedding: readonly number[],
): Promise<void> {
  if (embedding.length !== EMBEDDING_DIMENSIONS || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error(`Embedding width must be ${EMBEDDING_DIMENSIONS}`)
  }
  const vector = JSON.stringify(embedding)
  await input.db.$executeRaw`
    UPDATE record_search SET
      embedding = ${vector}::vector,
      embedding_model = ${embedder.model},
      indexed_at = ${input.clock()}
    WHERE record_id = ${payload.recordId}::uuid
      AND organization_id = ${payload.organizationId}::uuid
      AND team_id = ${payload.teamId}::uuid
      AND content = ${content}
  `
}

export function createRecordReindexHandler(embedder: Embedder): JobHandler {
  return async (input) => {
    const payload = RecordReindexPayload.parse(input.job.payload)
    if (payload.organizationId !== input.job.organizationId || payload.teamId !== input.job.teamId) {
      throw new Error('record.reindex tenant payload mismatch')
    }
    const record = await input.db.record.findFirst({
      where: {
        ...tenantWhere(payload), id: payload.recordId,
        deletedAt: null, mergedIntoId: null, erasedAt: null,
      },
      select: { id: true, objectTypeId: true, data: true, displayName: true },
    })
    if (record === null) {
      await removeSearch(input, payload)
      return
    }
    const [schema, links] = await Promise.all([
      loadSchema(input.db, payload),
      searchLinks(input, payload),
    ])
    const content = buildSearchContent(schema, {
      objectTypeId: record.objectTypeId,
      displayName: record.displayName,
      data: recordData(record.data),
    }, links)
    await storeKeywordContent(input, payload, record.objectTypeId, content)
    const embeddings = await embedder.embed([content])
    const embedding = embeddings[0]
    if (embedding === undefined) throw new Error('Embedding response is empty')
    await storeEmbedding(input, payload, embedder, content, embedding)
  }
}

export function createRecordReindexNeighboursHandler(): JobHandler {
  return async (input) => {
    const payload = RecordReindexNeighboursPayload.parse(input.job.payload)
    if (payload.organizationId !== input.job.organizationId || payload.teamId !== input.job.teamId) {
      throw new Error('record.reindex_neighbours tenant payload mismatch')
    }
    for (const recordId of [...new Set(payload.neighbourRecordIds)].sort()) {
      await input.db.queueJob.create({
        data: {
          ...tenantWhere(payload),
          type: RECORD_REINDEX_JOB,
          priority: 100,
          payload: { organizationId: payload.organizationId, teamId: payload.teamId, recordId },
          idempotencyKey: `reindex:${recordId}:neighbour:${input.job.id}`,
        },
      })
    }
  }
}
