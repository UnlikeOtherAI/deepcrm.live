import type { FastifyInstance } from 'fastify'
import type { Env } from '../env.js'

export function registerOAuthMetadataRoute(app: FastifyInstance, env: Env): void {
  // UOA_BASE_URL is DeepCRM's required/defaulted issuer setting, so unlike an
  // optional UOA_ISSUER model there is no development "issuer unset" state.
  app.get('/.well-known/oauth-protected-resource', async () => ({
    resource: env.DEEPCRM_API_PUBLIC_URL,
    authorization_servers: [env.UOA_BASE_URL],
    bearer_methods_supported: ['header'],
  }))
}
