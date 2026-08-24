import { PrincipalSchema, type Principal } from '@deepcrm/schemas'
import { appKeys, verifyAppKey, type AppRegistry } from './app-key.js'
import { readInboundHeaders } from './headers.js'
import { verifyNessieContext } from './nessie-context.js'
import { devPrincipal } from './principal.js'
import {
  flattenActChain,
  resolveRole,
  verifyUoaDelegation,
  type UoaDelegationOptions,
} from './uoa-delegation.js'

export type AuthenticationFailure =
  | 'missing_bearer'
  | 'invalid_app_key'
  | 'missing_delegation'
  | 'missing_context'
  | 'ambiguous_context'
  | 'invalid_delegation'
  | 'invalid_context'
  | 'caller_mismatch'
  | 'subject_mismatch'
  | 'unsupported'

export type AuthenticationResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: AuthenticationFailure }

export type AuthenticateOptions = {
  requireAuth: boolean
  directClients?: boolean
  requestId: string
  apps: AppRegistry
  uoa: UoaDelegationOptions
  contextAudience: string
}

function failure(reason: AuthenticationFailure): AuthenticationResult {
  return { ok: false, reason }
}

export async function authenticate(
  rawHeaders: Record<string, unknown>,
  options: AuthenticateOptions,
): Promise<AuthenticationResult> {
  if (!options.requireAuth) return { ok: true, principal: devPrincipal(options.requestId) }

  const headers = readInboundHeaders(rawHeaders)
  if (headers.bearer === undefined) return failure('missing_bearer')

  const appName = verifyAppKey(appKeys(options.apps), headers.bearer)
  if (appName === null) return failure(options.directClients === true ? 'unsupported' : 'invalid_app_key')
  const app = options.apps.get(appName)
  if (app === undefined) return failure('invalid_app_key')
  if (headers.delegation === undefined) return failure('missing_delegation')
  if (headers.appContext !== undefined && headers.nessieContext !== undefined) return failure('ambiguous_context')

  const contextToken = headers.appContext ?? (appName === 'nessie' ? headers.nessieContext : undefined)
  if (contextToken === undefined) return failure('missing_context')

  let delegation
  try {
    delegation = await verifyUoaDelegation(headers.delegation, options.uoa)
  } catch {
    return failure('invalid_delegation')
  }

  if (
    delegation.source_domain !== app.sourceDomain
    || delegation.product !== app.product
  ) {
    return failure('caller_mismatch')
  }

  let context
  try {
    context = await verifyNessieContext(contextToken, {
      jwks: app.contextJwks,
      jwksUrl: app.contextJwksUrl,
      audience: options.contextAudience,
      issuer: app.contextIssuer,
      now: options.uoa.now,
    })
  } catch {
    return failure('invalid_context')
  }

  if (context.sub !== delegation.sub) return failure('subject_mismatch')

  try {
    return {
      ok: true,
      principal: PrincipalSchema.parse({
        app: appName,
        uoaUserId: delegation.sub,
        uoaOrgId: delegation.org.org_id,
        uoaTeamId: delegation.active.teamId,
        role: resolveRole(delegation.org, delegation.active),
        sourceDomain: delegation.source_domain,
        product: delegation.product,
        actChain: flattenActChain(delegation.act),
        agentId: context.agentId,
        provenance: context.provenance,
      }),
    }
  } catch {
    return failure('invalid_delegation')
  }
}
