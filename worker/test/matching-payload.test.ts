import { describe, expect, it } from 'vitest'

import {
  activeBootstrapKey,
  ActiveBootstrapPayloadSchema,
  replacementBackfillKey,
  ReplacementBackfillPayloadSchema,
} from '../src/jobs/match-key-backfill.js'
import {
  createMatchingBootstrapContext,
  parseMatchingBootstrapArgs,
  parseMatchingBootstrapEnv,
} from '../src/matching-bootstrap.js'

const ids = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  teamId: '22222222-2222-4222-8222-222222222222',
  objectTypeId: '33333333-3333-4333-8333-333333333333',
  generationId: '44444444-4444-4444-8444-444444444444',
}

const auditMetadata = {
  app: 'deepcrm:mcp',
  actChain: [{ sub: 'usr_1', product: 'mcp' }],
  provenance: { runId: 'run_1', toolCallId: 'call_1', requestId: 'req_1' },
}

describe('matching worker boundaries', () => {
  it('parses the exact replacement payload and rejects extra fields', () => {
    const payload = {
      ...ids,
      actor: { type: 'human', id: 'usr_1' },
      onBehalfOf: { uoaUserId: 'usr_1', role: 'admin' },
      requestId: 'req_1',
      provenance: { runId: 'run_1', toolCallId: 'call_1', requestId: 'req_1' },
      auditMetadata,
      attempt: 0,
    }
    const parsed = ReplacementBackfillPayloadSchema.parse(payload)
    expect(parsed).toEqual(payload)
    expect(replacementBackfillKey(parsed)).toBe([
      'match-key-backfill', ids.teamId, ids.objectTypeId, ids.generationId, '0',
    ].join(':'))
    expect(ReplacementBackfillPayloadSchema.safeParse({ ...payload, rawValue: 'secret' }).success)
      .toBe(false)
  })

  it('never defaults replacement audit identity', () => {
    const base = {
      ...ids,
      actor: { type: 'human', id: 'usr_1' },
      onBehalfOf: { uoaUserId: 'usr_1', role: 'admin' },
      requestId: 'req_1',
      provenance: { runId: 'run_1', toolCallId: 'call_1', requestId: 'req_1' },
      attempt: 0,
    }
    // Missing auditMetadata entirely.
    expect(ReplacementBackfillPayloadSchema.safeParse(base).success).toBe(false)
    // auditMetadata without app.
    expect(ReplacementBackfillPayloadSchema.safeParse({
      ...base,
      auditMetadata: { actChain: auditMetadata.actChain, provenance: auditMetadata.provenance },
    }).success).toBe(false)
    // auditMetadata without actChain.
    expect(ReplacementBackfillPayloadSchema.safeParse({
      ...base,
      auditMetadata: { app: auditMetadata.app, provenance: auditMetadata.provenance },
    }).success).toBe(false)
    // auditMetadata without provenance.
    expect(ReplacementBackfillPayloadSchema.safeParse({
      ...base,
      auditMetadata: { app: auditMetadata.app, actChain: auditMetadata.actChain },
    }).success).toBe(false)
    // Empty app or provenance parts are refused; the worker never invents them.
    expect(ReplacementBackfillPayloadSchema.safeParse({
      ...base,
      auditMetadata: { app: '', actChain: [], provenance: auditMetadata.provenance },
    }).success).toBe(false)
    expect(ReplacementBackfillPayloadSchema.safeParse({
      ...base,
      auditMetadata: {
        app: auditMetadata.app,
        actChain: [],
        provenance: { runId: '', toolCallId: 'call_1', requestId: 'req_1' },
      },
    }).success).toBe(false)
    // Extra auditMetadata keys are refused.
    expect(ReplacementBackfillPayloadSchema.safeParse({
      ...base,
      auditMetadata: { ...auditMetadata, note: 'raw' },
    }).success).toBe(false)
  })

  it('creates and parses the complete trusted bootstrap context', () => {
    const context = createMatchingBootstrapContext({
      tenant: { organizationId: ids.organizationId, teamId: ids.teamId },
      uoaUserId: 'usr_operator',
      runId: 'run_1',
      toolCallId: 'matching-bootstrap',
      requestId: 'req_1',
    })
    const payload = ActiveBootstrapPayloadSchema.parse({
      mode: 'active_bootstrap',
      ...ids,
      context,
      attempt: 0,
    })
    expect(payload.context).toMatchObject({
      app: 'deepcrm:migration',
      actChain: [],
      actor: { type: 'system', id: 'deepcrm:migration:t16' },
      onBehalfOf: { uoaUserId: 'usr_operator', role: null },
    })
    expect(activeBootstrapKey(payload)).toBe([
      'match-key-bootstrap', ids.teamId, ids.objectTypeId, ids.generationId, '0',
    ].join(':'))
  })

  it('fails closed without bootstrap UOA attribution', () => {
    expect(() => parseMatchingBootstrapEnv({ DATABASE_URL: 'postgresql://example' })).toThrow()
    expect(() => parseMatchingBootstrapEnv({
      DATABASE_URL: 'postgresql://example',
      DEEPCRM_BOOTSTRAP_UOA_USER_ID: ' ',
    })).toThrow()
    expect(() => createMatchingBootstrapContext({
      tenant: { organizationId: ids.organizationId, teamId: ids.teamId },
      uoaUserId: ' ',
      runId: 'run_1',
      toolCallId: 'matching-bootstrap',
      requestId: 'req_1',
    })).toThrow('DEEPCRM_BOOTSTRAP_UOA_USER_ID is required')
  })

  it('accepts only the explicit terminal retry switch', () => {
    expect(parseMatchingBootstrapArgs([])).toEqual({ retryBootstrap: false })
    expect(parseMatchingBootstrapArgs(['--retry-terminal'])).toEqual({ retryBootstrap: true })
    expect(() => parseMatchingBootstrapArgs(['--retry'])).toThrow('Usage:')
  })
})
