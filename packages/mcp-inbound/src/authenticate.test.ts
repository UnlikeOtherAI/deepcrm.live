import { createHash } from 'node:crypto'
import type { Principal } from '@deepcrm/schemas'
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
import { parseAppKeys, parseAppRegistry, verifyAppKey, type AppRegistry } from './app-key.js'
import { authenticate, type AuthenticateOptions, type AuthenticationResult } from './authenticate.js'
import { readInboundHeaders } from './headers.js'
import { SeenSet } from './seen-set.js'
import { resolveRole } from './uoa-delegation.js'

const NOW = new Date('2026-08-24T12:00:00.000Z')
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000)
const UOA_ISSUER = 'https://authentication.example'
const API_AUDIENCE = 'https://api.deepcrm.live'
const CONTEXT_ISSUER = 'https://api.nessie.works'
const APP_KEY = 'dck_test_secret'
const APP_HASH = createHash('sha256').update(APP_KEY).digest('hex')

let uoaPrivateKey: KeyLike
let contextPrivateKey: KeyLike
let uoaJwks: JWTVerifyGetKey
let contextJwks: JWTVerifyGetKey
let apps: AppRegistry

beforeAll(async () => {
  const uoaKeys = await generateKeyPair('RS256')
  const contextKeys = await generateKeyPair('RS256')
  uoaPrivateKey = uoaKeys.privateKey
  contextPrivateKey = contextKeys.privateKey
  const uoaPublicJwk = await exportJWK(uoaKeys.publicKey)
  const contextPublicJwk = await exportJWK(contextKeys.publicKey)
  uoaJwks = createLocalJWKSet({ keys: [{ ...uoaPublicJwk, alg: 'RS256', kid: 'uoa-key' }] })
  contextJwks = createLocalJWKSet({ keys: [{ ...contextPublicJwk, alg: 'RS256', kid: 'context-key' }] })

  const registry = parseAppRegistry(JSON.stringify({
    nessie: {
      keyHashes: [APP_HASH],
      contextJwksUrl: 'https://api.nessie.works/.well-known/jwks.json',
      contextIssuer: CONTEXT_ISSUER,
      sourceDomain: 'api.nessie.works',
      product: 'nessie',
    },
  }))
  const nessie = registry.get('nessie')
  if (nessie === undefined) throw new Error('Test app registration is missing')
  registry.set('nessie', { ...nessie, contextJwks })
  apps = registry
})

type TokenOverrides = {
  audience?: string
  issuer?: string
  sub?: string
  iat?: number
  exp?: number
  claims?: JWTPayload
}

async function signDelegation(overrides: TokenOverrides = {}): Promise<string> {
  const payload: JWTPayload = {
    org: {
      org_id: 'org_uoa',
      org_role: 'member',
      team_roles: { team_uoa: 'admin' },
      teams: ['team_uoa'],
    },
    active: { orgId: 'org_uoa', teamId: 'team_uoa' },
    source_domain: 'api.nessie.works',
    azp: 'api.nessie.works',
    product: 'nessie',
    scope: 'openid ai.invoke',
    ...overrides.claims,
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'uoa-key' })
    .setIssuer(overrides.issuer ?? UOA_ISSUER)
    .setAudience(overrides.audience ?? API_AUDIENCE)
    .setSubject(overrides.sub ?? 'usr_uoa')
    .setJti('delegation-jti')
    .setIssuedAt(overrides.iat ?? NOW_SECONDS)
    .setExpirationTime(overrides.exp ?? NOW_SECONDS + 300)
    .sign(uoaPrivateKey)
}

async function signContext(overrides: TokenOverrides = {}): Promise<string> {
  return new SignJWT({
    agentId: 'agent_nessie',
    runId: 'run_1',
    toolCallId: 'tool_call_1',
    requestId: 'request_1',
    delegation_jti: 'delegation-jti',
    tool: 'crm_record_create',
    args_sha256: 'a'.repeat(64),
    ...overrides.claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'context-key' })
    .setIssuer(overrides.issuer ?? CONTEXT_ISSUER)
    .setAudience(overrides.audience ?? API_AUDIENCE)
    .setSubject(overrides.sub ?? 'usr_uoa')
    .setIssuedAt(overrides.iat ?? NOW_SECONDS)
    .setExpirationTime(overrides.exp ?? NOW_SECONDS + 300)
    .sign(contextPrivateKey)
}

function authOptions(overrides: Partial<AuthenticateOptions> = {}): AuthenticateOptions {
  return {
    requireAuth: true,
    requestId: 'http_request_1',
    apps,
    uoa: {
      jwks: uoaJwks,
      issuer: UOA_ISSUER,
      audience: API_AUDIENCE,
      now: NOW,
    },
    contextAudience: API_AUDIENCE,
    ...overrides,
  }
}

async function callAuth(
  delegation: string,
  context: string,
  headers: Record<string, unknown> = {},
): Promise<AuthenticationResult> {
  return authenticate({
    authorization: `Bearer ${APP_KEY}`,
    'x-uoa-delegation': delegation,
    'x-nessie-context': context,
    ...headers,
  }, authOptions())
}

function authenticated(result: AuthenticationResult): Principal {
  if (!result.ok) throw new Error(`Expected authentication success, received ${result.reason}`)
  return result.principal
}

describe('authenticate', () => {
  it('resolves the workspace role and carries a nested actor chain through', async () => {
    const delegation = await signDelegation({ claims: {
      act: {
        sub: 'api.deepsignal.live',
        product: 'deepsignal',
        act: { sub: 'api.origin.example', product: 'origin' },
      },
    } })
    const principal = authenticated(await callAuth(delegation, await signContext()))

    expect(principal).toEqual({
      app: 'nessie',
      uoaUserId: 'usr_uoa',
      uoaOrgId: 'org_uoa',
      uoaTeamId: 'team_uoa',
      role: 'admin',
      sourceDomain: 'api.nessie.works',
      product: 'nessie',
      actChain: [
        { sub: 'api.deepsignal.live', product: 'deepsignal' },
        { sub: 'api.origin.example', product: 'origin' },
      ],
      agentId: 'agent_nessie',
      tokenVersion: null,
      provenance: { runId: 'run_1', toolCallId: 'tool_call_1', requestId: 'request_1' },
    })
  })

  it('rejects context proof binding mismatches', async () => {
    const options = authOptions({
      expectedTool: { tool: 'crm_record_create', argsSha256: 'a'.repeat(64) },
    })
    const valid = await authenticate({
      authorization: `Bearer ${APP_KEY}`,
      'x-uoa-delegation': await signDelegation(),
      'x-nessie-context': await signContext(),
    }, options)
    expect(valid.ok).toBe(true)

    const wrongJti = await authenticate({
      authorization: `Bearer ${APP_KEY}`,
      'x-uoa-delegation': await signDelegation(),
      'x-nessie-context': await signContext({ claims: { delegation_jti: 'other-jti' } }),
    }, options)
    const wrongTool = await authenticate({
      authorization: `Bearer ${APP_KEY}`,
      'x-uoa-delegation': await signDelegation(),
      'x-nessie-context': await signContext({ claims: { tool: 'crm_record_delete' } }),
    }, options)
    const wrongHash = await authenticate({
      authorization: `Bearer ${APP_KEY}`,
      'x-uoa-delegation': await signDelegation(),
      'x-nessie-context': await signContext({ claims: { args_sha256: 'b'.repeat(64) } }),
    }, options)
    expect(wrongJti).toEqual({ ok: false, reason: 'invalid_context' })
    expect(wrongTool).toEqual({ ok: false, reason: 'invalid_context' })
    expect(wrongHash).toEqual({ ok: false, reason: 'invalid_context' })
  })

  it('rejects expired delegation and context tokens', async () => {
    const expiredDelegation = await signDelegation({ iat: NOW_SECONDS - 301, exp: NOW_SECONDS - 1 })
    const expiredContext = await signContext({ iat: NOW_SECONDS - 331, exp: NOW_SECONDS - 31 })

    await expect(callAuth(expiredDelegation, await signContext())).resolves.toEqual({
      ok: false,
      reason: 'invalid_delegation',
    })
    await expect(callAuth(await signDelegation(), expiredContext)).resolves.toEqual({
      ok: false,
      reason: 'invalid_context',
    })
  })

  it('rejects overlong proof lifetimes and a delegation without ai.invoke', async () => {
    const overlongDelegation = await signDelegation({ exp: NOW_SECONDS + 301 })
    const overlongContext = await signContext({ exp: NOW_SECONDS + 301 })
    const missingScope = await signDelegation({ claims: { scope: 'openid profile' } })

    await expect(callAuth(overlongDelegation, await signContext())).resolves.toEqual({
      ok: false,
      reason: 'invalid_delegation',
    })
    await expect(callAuth(await signDelegation(), overlongContext)).resolves.toEqual({
      ok: false,
      reason: 'invalid_context',
    })
    await expect(callAuth(missingScope, await signContext())).resolves.toEqual({
      ok: false,
      reason: 'invalid_delegation',
    })
  })

  it('rejects a wrong audience on either proof', async () => {
    const wrongDelegation = await signDelegation({ audience: 'https://wrong.example' })
    const wrongContext = await signContext({ audience: 'https://wrong.example' })

    await expect(callAuth(wrongDelegation, await signContext())).resolves.toEqual({
      ok: false,
      reason: 'invalid_delegation',
    })
    await expect(callAuth(await signDelegation(), wrongContext)).resolves.toEqual({
      ok: false,
      reason: 'invalid_context',
    })
  })

  it('rejects overlong proofs and a delegation without ai.invoke', async () => {
    const overlongDelegation = await signDelegation({ exp: NOW_SECONDS + 301 })
    const overlongContext = await signContext({ exp: NOW_SECONDS + 301 })
    const wrongScope = await signDelegation({ claims: { scope: 'openid profile' } })

    await expect(callAuth(overlongDelegation, await signContext())).resolves.toEqual({
      ok: false,
      reason: 'invalid_delegation',
    })
    await expect(callAuth(await signDelegation(), overlongContext)).resolves.toEqual({
      ok: false,
      reason: 'invalid_context',
    })
    await expect(callAuth(wrongScope, await signContext())).resolves.toEqual({
      ok: false,
      reason: 'invalid_delegation',
    })
  })

  it('rejects an identity-only delegation with no active workspace', async () => {
    const token = await signDelegation({ claims: { active: undefined } })
    await expect(callAuth(token, await signContext())).resolves.toEqual({
      ok: false,
      reason: 'invalid_delegation',
    })
  })

  it('rejects a delegation whose active organisation differs from its org claim', async () => {
    const token = await signDelegation({ claims: { active: { orgId: 'org_other', teamId: 'team_uoa' } } })
    await expect(callAuth(token, await signContext())).resolves.toEqual({
      ok: false,
      reason: 'invalid_delegation',
    })
  })

  it('rejects a product or source-domain mismatch with the app key registration', async () => {
    const wrongProduct = await signDelegation({ claims: { product: 'deepsignal' } })
    const wrongDomain = await signDelegation({
      claims: { source_domain: 'api.other.example', azp: 'api.other.example' },
    })
    await expect(callAuth(wrongProduct, await signContext())).resolves.toEqual({
      ok: false,
      reason: 'caller_mismatch',
    })
    await expect(callAuth(wrongDomain, await signContext())).resolves.toEqual({
      ok: false,
      reason: 'caller_mismatch',
    })
  })

  it('requires azp but does not invent a separate registry binding for it', async () => {
    const delegation = await signDelegation({ claims: { azp: 'uoa-client-identifier' } })
    expect(authenticated(await callAuth(delegation, await signContext())).app).toBe('nessie')
    const missingAzp = await signDelegation({ claims: { azp: undefined } })
    await expect(callAuth(missingAzp, await signContext())).resolves.toEqual({
      ok: false,
      reason: 'invalid_delegation',
    })
  })

  it('resolves an unknown team and org role to null', async () => {
    const delegation = await signDelegation({ claims: {
      org: { org_id: 'org_uoa', org_role: 'manager', team_roles: { team_uoa: 'editor' } },
    } })
    expect(authenticated(await callAuth(delegation, await signContext())).role).toBeNull()
  })

  it('rejects a context for a different UOA subject', async () => {
    const result = await callAuth(await signDelegation(), await signContext({ sub: 'usr_other' }))
    expect(result).toEqual({ ok: false, reason: 'subject_mismatch' })
  })

  it('authenticates direct clients when enabled', async () => {
    const noBearer = await authenticate({}, authOptions({ directClients: true }))
    const token = await signDelegation({ claims: {
      product: 'direct',
      source_domain: 'direct',
      tv: 7,
    } })
    const direct = await authenticate(
      { authorization: `Bearer ${token}` },
      authOptions({ directClients: true }),
    )
    expect(noBearer).toEqual({ ok: false, reason: 'missing_bearer' })
    expect(authenticated(direct)).toEqual(expect.objectContaining({
      app: 'direct',
      agentId: null,
      product: 'direct',
      tokenVersion: 7,
      provenance: null,
    }))
  })

  it('returns the development principal without reading supplied proofs', async () => {
    const result = await authenticate(
      { authorization: 'garbage' },
      authOptions({ requireAuth: false, requestId: 'dev_request' }),
    )
    const principal = authenticated(result)
    expect(principal.app).toBe('dev')
    expect(principal.provenance?.requestId).toBe('dev_request')
  })
})

describe('inbound auth primitives', () => {
  it('reads headers case-insensitively and extracts only a valid bearer', () => {
    expect(readInboundHeaders({
      AUTHORIZATION: `bearer ${APP_KEY}`,
      'X-UOA-DELEGATION': 'delegation',
      'x-App-Context': 'context',
    })).toEqual({
      bearer: APP_KEY,
      delegation: 'delegation',
      appContext: 'context',
      nessieContext: undefined,
    })
    expect(readInboundHeaders({ authorization: 'Basic key' }).bearer).toBeUndefined()
  })

  it('parses app registrations and verifies hashed keys', () => {
    const env = JSON.stringify({
      nessie: {
        keyHashes: [APP_HASH.toUpperCase()],
        contextJwksUrl: 'https://api.nessie.works/jwks.json',
        contextIssuer: CONTEXT_ISSUER,
        sourceDomain: 'api.nessie.works',
        product: 'nessie',
      },
    })
    const keys = parseAppKeys(env)
    expect(verifyAppKey(keys, APP_KEY)).toBe('nessie')
    expect(verifyAppKey(keys, 'wrong')).toBeNull()
  })

  it('resolves owner structurally and never floors unknown roles to member', () => {
    const active = { orgId: 'org_uoa', teamId: 'team_uoa' }
    expect(resolveRole({ org_id: 'org_uoa', org_role: 'owner', team_roles: {} }, active)).toBe('owner')
    expect(resolveRole({ org_id: 'org_uoa', org_role: 'admin', team_roles: {} }, active)).toBe('admin')
    expect(resolveRole({ org_id: 'org_uoa', org_role: 'custom', team_roles: {} }, active)).toBeNull()
  })

  it('bounds destructive request ids to one use for 300 seconds', () => {
    const seen = new SeenSet()
    expect(seen.consume('request_1', NOW)).toBe(true)
    expect(seen.consume('request_1', new Date(NOW.getTime() + 299_999))).toBe(false)
    expect(seen.consume('request_1', new Date(NOW.getTime() + 300_000))).toBe(true)
  })
})
