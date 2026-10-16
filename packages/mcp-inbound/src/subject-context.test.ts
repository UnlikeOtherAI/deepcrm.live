import { createHash } from 'node:crypto'
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  type JWTVerifyGetKey,
  type KeyLike,
} from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseAppRegistry, type AppRegistry } from './app-key.js'
import { authenticate, type AuthenticateOptions } from './authenticate.js'

// The data subject's own act (auth-and-tenancy §1): an app key, an
// `actor: "subject"` context naming the UOA org and team and one tool call,
// and no delegation. The app's `subjectTools` allowlist is the gate.

const NOW = new Date('2026-10-16T12:00:00.000Z')
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000)
const UOA_ISSUER = 'https://authentication.example'
const AUDIENCE = 'https://api.deepcrm.live'
const CONTEXT_ISSUER = 'https://api.nessie.works'
const APP_KEY = 'dck_subject_test_secret'
const OTHER_KEY = 'dck_subject_test_other'
const ARGS_HASH = 'c'.repeat(64)
const CONSENT_SET = { tool: 'crm_consent_set', argsSha256: ARGS_HASH }

let uoaPrivateKey: KeyLike
let contextPrivateKey: KeyLike
let uoaJwks: JWTVerifyGetKey
let apps: AppRegistry

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

beforeAll(async () => {
  const uoaKeys = await generateKeyPair('RS256')
  const contextKeys = await generateKeyPair('RS256')
  uoaPrivateKey = uoaKeys.privateKey
  contextPrivateKey = contextKeys.privateKey
  uoaJwks = createLocalJWKSet({ keys: [{ ...await exportJWK(uoaKeys.publicKey), alg: 'RS256', kid: 'uoa' }] })
  const contextJwks = createLocalJWKSet({
    keys: [{ ...await exportJWK(contextKeys.publicKey), alg: 'RS256', kid: 'context' }],
  })
  const registration = {
    contextJwksUrl: 'https://api.nessie.works/.well-known/jwks.json',
    contextIssuer: CONTEXT_ISSUER,
    sourceDomain: 'api.nessie.works',
    product: 'nessie',
  }
  const registry = parseAppRegistry(JSON.stringify({
    nessie: { ...registration, keyHashes: [sha256(APP_KEY)], subjectTools: ['crm_consent_set', 'crm_consent_get'] },
    other: { ...registration, keyHashes: [sha256(OTHER_KEY)] },
  }))
  for (const [name, app] of registry) registry.set(name, { ...app, contextJwks })
  apps = registry
})

async function signSubjectContext(claims: JWTPayload = {}): Promise<string> {
  return new SignJWT({
    actor: 'subject',
    org: 'org_uoa',
    team: 'team_uoa',
    tool: 'crm_consent_set',
    args_sha256: ARGS_HASH,
    requestId: 'subject_request_1',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'context' })
    .setIssuer(CONTEXT_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(NOW_SECONDS)
    .setExpirationTime(NOW_SECONDS + 300)
    .sign(contextPrivateKey)
}

async function signDelegation(): Promise<string> {
  return new SignJWT({
    org: { org_id: 'org_uoa', org_role: 'member', team_roles: { team_uoa: 'member' } },
    active: { orgId: 'org_uoa', teamId: 'team_uoa' },
    source_domain: 'api.nessie.works',
    azp: 'api.nessie.works',
    product: 'nessie',
    scope: 'openid ai.invoke',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'uoa' })
    .setIssuer(UOA_ISSUER)
    .setAudience(AUDIENCE)
    .setSubject('usr_uoa')
    .setJti('delegation-jti')
    .setIssuedAt(NOW_SECONDS)
    .setExpirationTime(NOW_SECONDS + 300)
    .sign(uoaPrivateKey)
}

function options(overrides: Partial<AuthenticateOptions> = {}): AuthenticateOptions {
  return {
    requireAuth: true,
    requestId: 'http_request_1',
    apps,
    uoa: { jwks: uoaJwks, issuer: UOA_ISSUER, audience: AUDIENCE, now: NOW },
    contextAudience: AUDIENCE,
    expectedTool: CONSENT_SET,
    ...overrides,
  }
}

function call(context: string, extra: Record<string, unknown> = {}) {
  return authenticate({ authorization: `Bearer ${APP_KEY}`, 'x-nessie-context': context, ...extra }, options())
}

describe('subject-attested calls', () => {
  it('authenticates an allowlisted tool call as the subject of that one call', async () => {
    await expect(call(await signSubjectContext())).resolves.toEqual({
      ok: true,
      principal: {
        kind: 'subject',
        app: 'nessie',
        uoaOrgId: 'org_uoa',
        uoaTeamId: 'team_uoa',
        sourceDomain: 'api.nessie.works',
        product: 'nessie',
        tool: 'crm_consent_set',
        argsSha256: ARGS_HASH,
        requestId: 'subject_request_1',
        // exp plus the 30 s clock tolerance: the replay seen-set holds the id that long.
        replayUntil: (NOW_SECONDS + 300 + 30) * 1000,
      },
    })
  })

  it('names the attested tool on a request that calls no tool', async () => {
    const result = await authenticate({
      authorization: `Bearer ${APP_KEY}`,
      'x-nessie-context': await signSubjectContext({ tool: 'crm_consent_get' }),
    }, options({ expectedTool: undefined }))
    expect(result.ok && result.principal.kind === 'subject' ? result.principal.tool : null).toBe('crm_consent_get')
  })

  it('refuses a tool the app registry does not allowlist for subjects', async () => {
    await expect(authenticate({
      authorization: `Bearer ${OTHER_KEY}`, 'x-app-context': await signSubjectContext(),
    }, options())).resolves.toEqual({ ok: false, reason: 'subject_not_allowed' })
    const deleteCall = { tool: 'crm_record_delete', argsSha256: ARGS_HASH }
    await expect(authenticate({
      authorization: `Bearer ${APP_KEY}`,
      'x-nessie-context': await signSubjectContext({ tool: 'crm_record_delete' }),
    }, options({ expectedTool: deleteCall }))).resolves.toEqual({ ok: false, reason: 'subject_not_allowed' })
  })

  it('refuses a context that names another tool or other arguments than the call', async () => {
    await expect(call(await signSubjectContext({ tool: 'crm_consent_get' })))
      .resolves.toEqual({ ok: false, reason: 'subject_tool_mismatch' })
    await expect(call(await signSubjectContext({ args_sha256: 'd'.repeat(64) })))
      .resolves.toEqual({ ok: false, reason: 'invalid_context' })
  })

  it('never reads a subject context beside a delegation', async () => {
    await expect(call(await signSubjectContext(), { 'x-uoa-delegation': await signDelegation() }))
      .resolves.toEqual({ ok: false, reason: 'ambiguous_context' })
  })

  it('requires the UOA org and team and names no person, delegation or agent', async () => {
    for (const claims of [
      { org: undefined }, { team: undefined }, { tool: undefined }, { args_sha256: undefined },
      { sub: 'usr_uoa' }, { delegation_jti: 'delegation-jti' }, { agentId: 'agent_nessie' },
    ]) {
      await expect(call(await signSubjectContext(claims)), JSON.stringify(Object.keys(claims)))
        .resolves.toEqual({ ok: false, reason: 'invalid_context' })
    }
  })

  it('still needs a delegation for an agent or human context', async () => {
    const agent = await signSubjectContext({
      actor: undefined, sub: 'usr_uoa', agentId: 'agent_nessie', runId: 'run_1', toolCallId: 'call_1',
    })
    await expect(call(agent)).resolves.toEqual({ ok: false, reason: 'missing_delegation' })
    await expect(authenticate({ authorization: `Bearer ${APP_KEY}` }, options()))
      .resolves.toEqual({ ok: false, reason: 'missing_delegation' })
  })

  it('defaults the registry allowlist to no subject tools and refuses malformed names', () => {
    const base = {
      keyHashes: [sha256('dck_registry')], contextJwksUrl: 'https://app.example/jwks.json',
      contextIssuer: 'https://app.example', sourceDomain: 'app.example', product: 'app',
    }
    expect(parseAppRegistry(JSON.stringify({ app: base })).get('app')?.subjectTools).toEqual([])
    expect(() => parseAppRegistry(JSON.stringify({ app: { ...base, subjectTools: ['Consent Set'] } }))).toThrow()
  })
})
