import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps.js'

export function registerHealthRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/health', async (_request, reply) => {
    try {
      await deps.db.$queryRaw`SELECT 1`
      return reply.status(200).send({ ok: true, version: deps.version, db: 'ok' })
    } catch {
      return reply.status(503).send({ ok: true, version: deps.version, db: 'error' })
    }
  })
}
