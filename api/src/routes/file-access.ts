import { tenantWhere } from '@deepcrm/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { AppDeps } from '../deps.js'

const Params = z.object({ fileId: z.string().uuid() }).strict()
const Query = z.object({ token: z.string().min(1).max(2048) }).strict()

export function registerFileAccessRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/files/access/:fileId', async (request, reply) => {
    const params = Params.safeParse(request.params)
    const query = Query.safeParse(request.query)
    if (!params.success || !query.success) return reply.status(403).send({ error: 'forbidden' })
    const grant = deps.fileAccess.open(params.data.fileId, query.data.token, deps.clock())
    if (grant === null) return reply.status(403).send({ error: 'forbidden' })
    const file = await deps.db.fileObject.findFirst({
      where: { ...tenantWhere(grant.tenant), id: grant.fileId },
      select: {
        id: true,
        provider: true,
        providerKey: true,
        filename: true,
        mimeType: true,
        sizeBytes: true,
        checksumSha256: true,
      },
    })
    if (file === null) return reply.status(404).send({ error: 'not_found' })
    reply.header('cache-control', 'no-store')
    return reply.send({
      file_id: file.id,
      provider: file.provider,
      provider_key: file.providerKey,
      filename: file.filename,
      mime_type: file.mimeType,
      size_bytes: file.sizeBytes.toString(),
      checksum_sha256: file.checksumSha256,
      expires_at: grant.expiresAt.toISOString(),
    })
  })
}
