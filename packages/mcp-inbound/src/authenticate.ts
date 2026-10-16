import { PrincipalSchema, type Principal } from '@deepcrm/schemas'
import { appKeys, verifyAppKey, type AppRegistration, type AppRegistry } from './app-key.js'
import { readInboundHeaders } from './headers.js'
import { bindsInvocation, verifyNessieContext, type NessieContext } from './nessie-context.js'
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
  | 'subject_not_allowed'
  | 'subject_tool_mismatch'
  | 'unsupported'

export type ExpectedToolInvocation = {
  tool: string
  argsSha256: string
}

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
  /** The `tools/call` this request carries; absent for every other method. */
  expectedTool?: ExpectedToolInvocation
}

function failure(reason: AuthenticationFailure): AuthenticationResult {
  return { ok: false, reason }
}

async function readContext(
  token: string,
  app: AppRegistration,
  options: AuthenticateOptions,
): Promise<NessieContext | null> {
  try {
    return await verifyNessieContext(token, {
      jwks: app.contextJwks,
      jwksUrl: app.contextJwksUrl,
      audience: options.contextAudience,
      issuer: app.contextIssuer,
      now: options.uoa.now,
    })
  } catch {
    return null
  }
}

/**
 * The data subject's own act: an app key, a subject context and no
 * delegation. The registry's `subjectTools` is the whole gate — the context
 * names one tool, which must be allowlisted and, on a `tools/call`, must be
 * exactly the invocation (tool and canonical argument hash).
 */
async function authenticateSubject(
  appName: string,
  app: AppRegistration,
  token: string,
  options: AuthenticateOptions,
): Promise<AuthenticationResult> {
  const context = await readContext(token, app, options)
  if (context === null) return failure('invalid_context')
  if (context.kind !== 'subject') return failure('missing_delegation')
  if (!app.subjectTools.includes(context.tool)) return failure('subject_not_allowed')
  const expected = options.expectedTool
  if (expected !== undefined) {
    if (expected.tool !== context.tool) return failure('subject_tool_mismatch')
    if (expected.argsSha256 !== context.argsSha256) return failure('invalid_context')
  }
  return {
    ok: true,
    principal: PrincipalSchema.parse({
      kind: 'subject',
      app: appName,
      uoaOrgId: context.org,
      uoaTeamId: context.team,
      sourceDomain: app.sourceDomain,
      product: app.product,
      tool: context.tool,
      argsSha256: context.argsSha256,
      requestId: context.requestId,
      replayUntil: context.verifiesUntil,
    }),
  }
}

async function authenticateDirect(
  bearer: string,
  options: AuthenticateOptions,
): Promise<AuthenticationResult> {
  try {
    const delegation = await verifyUoaDelegation(bearer, options.uoa)
    if (delegation.product !== 'direct') return failure('caller_mismatch')
    return {
      ok: true,
      principal: PrincipalSchema.parse({
        kind: 'delegated',
        app: 'direct',
        uoaUserId: delegation.sub,
        uoaOrgId: delegation.org.org_id,
        uoaTeamId: delegation.active.teamId,
        role: resolveRole(delegation.org, delegation.active),
        sourceDomain: delegation.source_domain,
        product: delegation.product,
        actChain: flattenActChain(delegation.act),
        agentId: null,
        tokenVersion: delegation.tv ?? null,
        provenance: null,
      }),
    }
  } catch {
    return failure('invalid_delegation')
  }
}

export async function authenticate(
  rawHeaders: Record<string, unknown>,
  options: AuthenticateOptions,
): Promise<AuthenticationResult> {
  if (!options.requireAuth) return { ok: true, principal: devPrincipal(options.requestId) }

  const headers = readInboundHeaders(rawHeaders)
  if (headers.bearer === undefined) return failure('missing_bearer')

  const appName = verifyAppKey(appKeys(options.apps), headers.bearer)
  if (appName === null) {
    if (options.directClients !== true) return failure('invalid_app_key')
    return authenticateDirect(headers.bearer, options)
  }
  const app = options.apps.get(appName)
  if (app === undefined) return failure('invalid_app_key')
  if (headers.appContext !== undefined && headers.nessieContext !== undefined) return failure('ambiguous_context')
  const contextToken = headers.appContext ?? (appName === 'nessie' ? headers.nessieContext : undefined)

  if (headers.delegation === undefined) {
    if (contextToken === undefined) return failure('missing_delegation')
    return authenticateSubject(appName, app, contextToken, options)
  }
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

  const context = await readContext(contextToken, app, options)
  if (context === null) return failure('invalid_context')
  // A subject attestation acts for nobody; beside a delegation it is never
  // read as either the person or the subject.
  if (context.kind === 'subject') return failure('ambiguous_context')
  const expected = options.expectedTool
  if (expected !== undefined && !bindsInvocation(context.binding, {
    delegationJti: delegation.jti,
    tool: expected.tool,
    argsSha256: expected.argsSha256,
  })) return failure('invalid_context')

  if (context.sub !== delegation.sub) return failure('subject_mismatch')

  try {
    return {
      ok: true,
      principal: PrincipalSchema.parse({
        kind: 'delegated',
        app: appName,
        uoaUserId: delegation.sub,
        uoaOrgId: delegation.org.org_id,
        uoaTeamId: delegation.active.teamId,
        role: resolveRole(delegation.org, delegation.active),
        sourceDomain: delegation.source_domain,
        product: delegation.product,
        actChain: flattenActChain(delegation.act),
        agentId: context.agentId,
        tokenVersion: delegation.tv ?? null,
        provenance: context.provenance,
      }),
    }
  } catch {
    return failure('invalid_delegation')
  }
}
