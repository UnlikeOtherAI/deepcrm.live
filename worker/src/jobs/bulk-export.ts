import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { ExportPayload, ExportResult, type ActorContext, type SecretBox } from '@deepcrm/schemas'

import type { ExportPagePort } from '../export-page-port.js'
import type { JobHandler, JobHandlerInput } from '../index.js'

export const BULK_EXPORT_JOB = 'records.export'
const PAGE_SIZE = 500
const URL_TTL_MS = 60 * 60 * 1_000

export type BulkExportConfig = {
  exportDir: string
  maxExportRows: number
  publicUrl: string
}

function actorContext(input: JobHandlerInput, payload: ReturnType<typeof ExportPayload.parse>): ActorContext {
  return { ...payload.actorContext, now: input.clock() }
}

function assertJobScope(
  input: JobHandlerInput,
  payload: ReturnType<typeof ExportPayload.parse>,
): void {
  if (
    input.job.type !== BULK_EXPORT_JOB
    || input.job.organizationId !== payload.organizationId
    || input.job.teamId !== payload.teamId
    || payload.actorContext.tenant.organizationId !== payload.organizationId
    || payload.actorContext.tenant.teamId !== payload.teamId
  ) {
    throw new Error('Export payload tenant does not match the claimed job')
  }
}

async function stillRunning(input: JobHandlerInput): Promise<boolean> {
  const job = await input.db.queueJob.findFirst({
    where: {
      id: input.job.id,
      organizationId: input.job.organizationId,
      teamId: input.job.teamId,
      type: BULK_EXPORT_JOB,
    },
    select: { status: true },
  })
  return job?.status === 'running'
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\r\n]/u.test(rendered) ? `"${rendered.replaceAll('"', '""')}"` : rendered
}

async function writeChunk(file: Awaited<ReturnType<typeof open>>, chunk: string): Promise<void> {
  const buffer = Buffer.from(chunk, 'utf8')
  let offset = 0
  while (offset < buffer.byteLength) {
    const written = await file.write(buffer, offset, buffer.byteLength - offset)
    offset += written.bytesWritten
  }
}

function exportPaths(directory: string, jobId: string, format: 'csv' | 'jsonl') {
  const root = resolve(directory)
  const finalPath = resolve(root, `${jobId}.${format}`)
  const temporaryPath = resolve(root, `${jobId}.${format}.tmp`)
  if (!finalPath.startsWith(`${root}${sep}`) || !temporaryPath.startsWith(`${root}${sep}`)) {
    throw new Error('Export path is outside the configured directory')
  }
  return { root, finalPath, temporaryPath }
}

function resultUrl(publicUrl: string, jobId: string, exp: number, signature: string): string {
  const url = new URL(`/exports/${jobId}`, publicUrl)
  url.searchParams.set('sig', signature)
  url.searchParams.set('exp', String(exp))
  return url.toString()
}

export function createBulkExportHandler(
  exportPage: ExportPagePort,
  secretBox: SecretBox,
  config: BulkExportConfig,
): JobHandler {
  return async (input) => {
    const payload = ExportPayload.parse(input.job.payload)
    assertJobScope(input, payload)
    const paths = exportPaths(config.exportDir, input.job.id, payload.format)
    await mkdir(paths.root, { recursive: true, mode: 0o700 })
    const file = await open(
      paths.temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    )
    let keepFinal = false
    try {
      if (payload.format === 'csv') {
        await writeChunk(file, `${payload.attributes.map(csvCell).join(',')}\r\n`)
      }
      let cursor: string | undefined
      let rows = 0
      let total: number | undefined
      do {
        if (!await stillRunning(input)) return
        const page = await exportPage(actorContext(input, payload), {
          objectType: payload.objectType,
          ...(payload.filter === undefined ? {} : { filter: payload.filter }),
          sort: payload.sort,
          attributes: payload.attributes,
          ...(cursor === undefined ? {} : { cursor }),
          limit: Math.min(PAGE_SIZE, config.maxExportRows - rows),
          includeTotal: cursor === undefined,
        })
        total ??= page.total
        if ((total ?? rows + page.records.length) > config.maxExportRows) {
          throw new Error(`Export exceeds the ${config.maxExportRows} row limit`)
        }
        for (const record of page.records) {
          const selected = Object.fromEntries(
            payload.attributes.map((attribute) => [attribute, record.data[attribute] ?? null]),
          )
          await writeChunk(file, payload.format === 'csv'
            ? `${payload.attributes.map((attribute) => csvCell(selected[attribute])).join(',')}\r\n`
            : `${JSON.stringify(selected)}\n`)
        }
        rows += page.records.length
        if (!await input.progress({ done: rows, total: total ?? rows })) return
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined && rows < config.maxExportRows)

      await file.sync()
      await file.close()
      await rename(paths.temporaryPath, paths.finalPath)
      const expiresAt = new Date(input.clock().getTime() + URL_TTL_MS)
      const exp = Math.floor(expiresAt.getTime() / 1_000)
      const signature = secretBox.sign(Buffer.from(`${input.job.id}:${exp}`, 'utf8'), 'export')
      const result = ExportResult.parse({
        url: resultUrl(config.publicUrl, input.job.id, exp, signature),
        rows,
        expires_at: expiresAt.toISOString(),
      })
      const completed = await input.db.$transaction((tx) => input.terminalize(tx, result))
      keepFinal = completed
      return completed ? { terminalized: true } : undefined
    } finally {
      await file.close().catch(() => undefined)
      await unlink(paths.temporaryPath).catch(() => undefined)
      if (!keepFinal) await unlink(paths.finalPath).catch(() => undefined)
    }
  }
}
