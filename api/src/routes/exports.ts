import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { ExportPayload, ExportResult, Uuid } from '@deepcrm/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { AppDeps } from '../deps.js'
import type { Env } from '../env.js'

const Params = z.object({ jobId: Uuid }).strict()
const Query = z.object({
  sig: z.string().min(1).max(128),
  exp: z.string().regex(/^\d{1,16}$/u),
}).strict()

export function registerExportRoute(app: FastifyInstance, deps: AppDeps, env: Env): void {
  app.get('/exports/:jobId', async (request, reply) => {
    const params = Params.safeParse(request.params)
    const query = Query.safeParse(request.query)
    if (!params.success || !query.success) return reply.status(403).send({ error: 'forbidden' })
    const exp = Number(query.data.exp)
    const nowSeconds = Math.floor(deps.clock().getTime() / 1_000)
    if (!Number.isSafeInteger(exp) || exp <= nowSeconds) {
      return reply.status(403).send({ error: 'forbidden' })
    }
    const message = Buffer.from(`${params.data.jobId}:${exp}`, 'utf8')
    if (!deps.secretBox.verify(query.data.sig, message, 'export')) {
      return reply.status(403).send({ error: 'forbidden' })
    }

    const job = await deps.db.queueJob.findFirst({
      where: { id: params.data.jobId, type: 'records.export', status: 'completed' },
      select: { id: true, payload: true, result: true, exportDownloadedAt: true },
    })
    if (job === null || job.exportDownloadedAt !== null) {
      return reply.status(404).send({ error: 'not_found' })
    }
    const payload = ExportPayload.safeParse(job.payload)
    const result = ExportResult.safeParse(job.result)
    if (!payload.success || !result.success
      || Math.floor(new Date(result.data.expires_at).getTime() / 1_000) !== exp) {
      return reply.status(403).send({ error: 'forbidden' })
    }

    const root = resolve(env.DEEPCRM_EXPORT_DIR)
    const path = resolve(root, `${job.id}.${payload.data.format}`)
    if (!path.startsWith(`${root}${sep}`)) return reply.status(403).send({ error: 'forbidden' })
    let file: Awaited<ReturnType<typeof open>>
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const metadata = await file.stat()
      if (!metadata.isFile()) {
        await file.close()
        return reply.status(404).send({ error: 'not_found' })
      }
    } catch {
      return reply.status(404).send({ error: 'not_found' })
    }

    const consumed = await deps.db.queueJob.updateMany({
      where: {
        id: job.id,
        type: 'records.export',
        status: 'completed',
        exportDownloadedAt: null,
      },
      data: { exportDownloadedAt: deps.clock() },
    })
    if (consumed.count !== 1) {
      await file.close()
      return reply.status(404).send({ error: 'not_found' })
    }
    reply.header('content-type', payload.data.format === 'csv'
      ? 'text/csv; charset=utf-8'
      : 'application/x-ndjson')
    reply.header('content-disposition', `attachment; filename="${job.id}.${payload.data.format}"`)
    return reply.send(file.createReadStream({ autoClose: true }))
  })
}
