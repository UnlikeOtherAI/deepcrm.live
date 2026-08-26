import Fastify, { type FastifyInstance } from 'fastify'
import type { AppDeps } from './deps.js'
import type { Env } from './env.js'
import { registerMcpHttpPlugin } from './plugins/mcp-http.js'
import { registerHealthRoute } from './routes/health.js'
import { registerOAuthMetadataRoute } from './routes/oauth-metadata.js'
import { registerExportRoute } from './routes/exports.js'
import { registerFileAccessRoute } from './routes/file-access.js'

// Pure builder: no env reads, no side effects. The caller (api/src/index.ts)
// supplies env and deps; tests supply their own (api/test/health.test.ts).
export function buildApp(deps: AppDeps, env: Env): FastifyInstance {
  const app = Fastify({
    // Fastify's trustProxy has no hop-count form (a bare number fails closed,
    // never trusting anything). The only deployment with proxy hops is Caddy
    // on the same host (docs/architecture.md §6), so hops > 0 trusts the
    // loopback peer; 0 disables forwarding trust entirely.
    trustProxy: env.DEEPCRM_TRUSTED_PROXY_HOPS > 0 ? '127.0.0.1' : false,
    bodyLimit: env.DEEPCRM_MAX_BODY_BYTES,
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-uoa-delegation"]',
          'req.headers["x-nessie-context"]',
        ],
        censor: '[redacted]',
      },
    },
  })
  registerHealthRoute(app, deps)
  registerOAuthMetadataRoute(app, env)
  registerExportRoute(app, deps, env)
  registerFileAccessRoute(app, deps)
  registerMcpHttpPlugin(app, deps, env)
  return app
}
