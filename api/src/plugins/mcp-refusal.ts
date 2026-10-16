import type { ServiceError } from '@deepcrm/schemas'
import type { FastifyReply } from 'fastify'
import { logToolEntry } from '../mcp/tools/register.js'
import { toolError } from '../mcp/tools/result.js'

type JsonRpcId = string | number

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestId(body: unknown): JsonRpcId | null {
  if (!isRecord(body)) return null
  const id = body['id']
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

function toolName(body: unknown): string | null {
  if (!isRecord(body) || body['method'] !== 'tools/call') return null
  const params = body['params']
  return isRecord(params) && typeof params['name'] === 'string' ? params['name'] : null
}

/**
 * Answers a request whose tenant could not be resolved — `TENANT_NOT_FOUND`
 * for a subject-attested call to a team with no workspace, `TENANT_REPARENTING`
 * while UOA re-parenting is reconciled, `POLICY_DENIED` for an organisation
 * outside the allowlist — with the same typed refusal a tool returns, so the
 * caller reads a code rather than a transport failure. A `tools/call` gets a
 * tool error result; any other request a JSON-RPC error carrying the code.
 */
export async function answerTenantRefusal(
  reply: FastifyReply,
  body: unknown,
  error: ServiceError,
  httpRequestId: string,
): Promise<void> {
  const id = requestId(body)
  if (id === null) {
    await reply.code(403).send({ error: 'tenant_unavailable', code: error.code })
    return
  }
  const tool = toolName(body)
  if (tool === null) {
    await reply.code(200).send({
      jsonrpc: '2.0',
      id,
      error: { code: -32001, message: `${error.code}: ${error.message}`, data: { code: error.code } },
    })
    return
  }
  const result = toolError(error, { tool, requestId: httpRequestId, durationMs: 0, log: logToolEntry })
  await reply.code(200).send({ jsonrpc: '2.0', id, result: { ...result, resultType: 'complete' } })
}
