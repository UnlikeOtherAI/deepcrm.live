import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  ErrorCode,
  parseSecretBox,
  ServiceError,
  type ActorContext,
} from '@deepcrm/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  inputRequired,
  readMrtr,
  verifyRequestState,
  type MrtrInput,
} from '../../src/mcp/tools/input-required.js'
import { configureToolRuntime, defineTool } from '../../src/mcp/tools/register.js'
import { ok, taskCreated, toolError, type ToolLogEntry } from '../../src/mcp/tools/result.js'

const keyring = Buffer.from(JSON.stringify({
  active: 'mrtr',
  keys: { mrtr: Buffer.alloc(32, 19).toString('base64') },
}), 'utf8').toString('base64')
const secretBox = parseSecretBox(keyring)
const now = new Date('2026-08-24T12:00:00.000Z')
const nowSeconds = Math.floor(now.getTime() / 1_000)
const argumentsHash = 'a'.repeat(64)
const ctx: ActorContext = {
  tenant: { organizationId: 'org_test', teamId: 'team_test' },
  app: 'nessie',
  actChain: [],
  actor: { type: 'agent', id: 'agent_test' },
  onBehalfOf: { uoaUserId: 'user_test', role: 'admin' },
  provenance: { runId: 'run_test', toolCallId: 'call_test', requestId: 'request_test' },
  requestId: 'request_test',
  now,
}
const requestPayload = {
  app: 'nessie',
  uoaUserId: 'user_test',
  tool: 'crm_test',
  argumentsHash,
  impact: 'Archives 12 values',
  exp: nowSeconds + 300,
}
const elicitation = {
  confirm: {
    method: 'elicitation/create' as const,
    params: {
      mode: 'form' as const,
      message: 'Proceed?',
      requestedSchema: {
        type: 'object',
        properties: { confirmed: { type: 'boolean' } },
        required: ['confirmed'],
      },
    },
  },
}

const clients: Client[] = []
const servers: McpServer[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('tool results', () => {
  it('returns a standard unsolicited task plus CallToolResult compatibility fields', () => {
    const result = taskCreated({
      taskId: '0f811893-d652-4775-8428-6f266c9ceefa',
      status: 'working',
      ttl: 604_800_000,
      createdAt: '2026-08-24T12:00:00.000Z',
      lastUpdatedAt: '2026-08-24T12:00:00.000Z',
      pollInterval: 1_000,
    })
    expect(CreateTaskResultSchema.parse(result).task.taskId).toBe(result.task.taskId)
    expect(CallToolResultSchema.parse(result).structuredContent).toEqual({ task: result.task })
    expect(result).not.toHaveProperty('resultType')
  })

  it('returns structured success content', () => {
    expect(ok({ record_id: 'record_test' }, '{"record_id":"record_test"}')).toEqual({
      content: [{ type: 'text', text: '{"record_id":"record_test"}' }],
      structuredContent: { record_id: 'record_test' },
    })
  })

  it('maps service errors and keeps authoritative fields above details', () => {
    const logs: ToolLogEntry[] = []
    const result = toolError(new ServiceError(ErrorCode.VERSION_CONFLICT, 'Record changed', {
      current: 7,
      code: ErrorCode.NOT_FOUND,
      message: 'overridden',
      next: 'fatal',
    }), {
      tool: 'crm_record_update', requestId: 'request_test', durationMs: 12, log: (entry) => logs.push(entry),
    })
    expect(result.structuredContent).toEqual({
      current: 7,
      code: ErrorCode.VERSION_CONFLICT,
      message: 'Record changed',
      next: 'fetch_and_retry',
    })
    expect(logs).toEqual([{
      level: 'info', tool: 'crm_record_update', requestId: 'request_test', durationMs: 12,
      code: ErrorCode.VERSION_CONFLICT,
    }])
  })

  it('hides unexpected error messages from both results and metadata-only logs', () => {
    const logs: ToolLogEntry[] = []
    const result = toolError(new Error('database password hunter2'), {
      tool: 'crm_schema_get', requestId: 'request_internal', durationMs: 4, log: (entry) => logs.push(entry),
    })
    expect(result.structuredContent).toEqual({
      correlation_id: 'request_internal',
      code: ErrorCode.INTERNAL,
      message: 'An internal error occurred',
      next: 'fatal',
    })
    expect(JSON.stringify({ result, logs })).not.toContain('hunter2')
    expect(logs[0]).toEqual({
      level: 'error', tool: 'crm_schema_get', requestId: 'request_internal', durationMs: 4,
      code: ErrorCode.INTERNAL,
    })
  })
})


describe('MRTR request state', () => {
  it('seals and verifies the normative input_required result', () => {
    const result = inputRequired(elicitation, requestPayload, secretBox)
    expect(result).toMatchObject({
      content: [], resultType: 'input_required', inputRequests: elicitation,
    })
    expect(result.requestState).not.toContain(requestPayload.impact)
    expect(verifyRequestState(result.requestState, ctx, 'crm_test', argumentsHash, secretBox))
      .toEqual(requestPayload)
  })

  it('rejects tampering, expiry, excessive TTL and every principal/tool/argument mismatch', () => {
    const valid = inputRequired(elicitation, requestPayload, secretBox).requestState
    const tampered = `${valid.slice(0, -1)}${valid.endsWith('a') ? 'b' : 'a'}`
    const cases: Array<() => unknown> = [
      () => verifyRequestState(tampered, ctx, 'crm_test', argumentsHash, secretBox),
      () => verifyRequestState(inputRequired(elicitation, { ...requestPayload, exp: nowSeconds }, secretBox)
        .requestState, ctx, 'crm_test', argumentsHash, secretBox),
      () => verifyRequestState(inputRequired(elicitation, {
        ...requestPayload, exp: nowSeconds + (24 * 60 * 60) + 1,
      }, secretBox).requestState, ctx, 'crm_test', argumentsHash, secretBox),
      () => verifyRequestState(valid, { ...ctx, app: 'direct' }, 'crm_test', argumentsHash, secretBox),
      () => verifyRequestState(valid, {
        ...ctx, onBehalfOf: { ...ctx.onBehalfOf, uoaUserId: 'other_user' },
      }, 'crm_test', argumentsHash, secretBox),
      () => verifyRequestState(valid, ctx, 'crm_other', argumentsHash, secretBox),
      () => verifyRequestState(valid, ctx, 'crm_test', 'b'.repeat(64), secretBox),
    ]
    for (const reject of cases) {
      expect(reject).toThrowError(expect.objectContaining({
        code: ErrorCode.VALIDATION_FAILED,
        details: { detail: 'request_state_invalid' },
      }))
    }
  })

  it('unwraps paired responses/state and refuses incomplete retries', () => {
    expect(readMrtr({
      arguments: { id: 'record_test' },
      inputResponses: { confirm: { action: 'accept', content: { confirmed: true } } },
      requestState: 'state',
    })).toEqual({
      arguments: { id: 'record_test' },
      inputResponses: { confirm: { action: 'accept', content: { confirmed: true } } },
      requestState: 'state',
    })
    expect(() => readMrtr({ arguments: {}, requestState: 'state' })).toThrow(ServiceError)
  })
})

describe('defineTool', () => {
  it('rejects undiscoverable tool registrations at the length boundary', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    servers.push(server)
    configureToolRuntime(server, {
      requestId: 'request_runtime', clock: () => 10, log: () => undefined,
    })
    const definition = {
      name: 'crm_registration_test',
      input: { value: z.string().describe('test value') },
      handler: () => ok({}, '{}'),
    }
    expect(() => defineTool(server, {
      ...definition,
      description: 'x'.repeat(300),
    })).not.toThrow()
    expect(() => defineTool(server, {
      ...definition,
      name: 'crm_registration_too_long',
      description: 'x'.repeat(301),
    })).toThrow("Tool 'crm_registration_too_long' description exceeds 300 characters")
  })

  it('rejects every top-level input field without a nonempty description', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    servers.push(server)
    configureToolRuntime(server, {
      requestId: 'request_runtime', clock: () => 10, log: () => undefined,
    })
    expect(() => defineTool(server, {
      name: 'crm_registration_missing_descriptions',
      description: 'Registration test.',
      input: {
        missing: z.string(),
        blank: z.string().describe('   '),
        described: z.string().describe('test value'),
      },
      handler: () => ok({}, '{}'),
    })).toThrow(
      "Tool 'crm_registration_missing_descriptions' input fields lack descriptions: missing, blank",
    )
  })

  it('validates and dispatches ordinary and params-level MRTR calls with request context', async () => {
    const logs: ToolLogEntry[] = []
    const seenMrtr: MrtrInput[] = []
    const seenRequestIds: Array<string | number> = []
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    servers.push(server)
    configureToolRuntime(server, {
      requestId: 'request_runtime', clock: () => 10, log: (entry) => logs.push(entry),
    })
    defineTool(server, {
      name: 'crm_test',
      description: 'Test the T21 dispatcher.',
      input: { value: z.string().describe('test value') },
      handler: (args, mrtr, extra) => {
        seenMrtr.push(mrtr)
        seenRequestIds.push(extra.requestId)
        return ok({ value: args.value }, JSON.stringify({ value: args.value }))
      },
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    clients.push(client)
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const ordinary = await client.callTool({ name: 'crm_test', arguments: { value: 'ordinary' } })
    expect(ordinary.structuredContent).toEqual({ value: 'ordinary' })

    const mrtrRequest = {
      method: 'tools/call' as const,
      params: {
        name: 'crm_test',
        arguments: { value: 'retry' },
        inputResponses: { confirm: { action: 'accept', content: { confirmed: true } } },
        requestState: 'opaque-state',
      },
    }
    const retry = await client.request(mrtrRequest, CallToolResultSchema)
    expect(retry.structuredContent).toEqual({ value: 'retry' })
    expect(seenMrtr).toEqual([
      { inputResponses: undefined, requestState: undefined },
      {
        inputResponses: { confirm: { action: 'accept', content: { confirmed: true } } },
        requestState: 'opaque-state',
      },
    ])
    expect(seenRequestIds).toHaveLength(2)

    const invalid = await client.callTool({ name: 'crm_test', arguments: { value: 7 } })
    expect(invalid).toMatchObject({
      isError: true,
      structuredContent: { code: ErrorCode.VALIDATION_FAILED, next: 'fix_input' },
    })
    expect(logs.map((entry) => entry.tool)).toEqual(['crm_test', 'crm_test', 'crm_test'])
  })
})
