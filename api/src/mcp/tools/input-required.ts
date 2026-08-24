import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  ErrorCode,
  InputRequests,
  InputResponses,
  ServiceError,
  type ActorContext,
  type RequestStatePayload,
  type SecretBox,
} from '@deepcrm/schemas'
import { z } from 'zod'

const purpose = 'mrtr'
const additionalData = new TextEncoder().encode('deepcrm.request-state.v1')
const maxTtlSeconds = 24 * 60 * 60

const RequestStatePayloadSchema: z.ZodType<RequestStatePayload> = z.object({
  app: z.string().min(1),
  uoaUserId: z.string().min(1),
  tool: z.string().min(1),
  argumentsHash: z.string().regex(/^[a-f0-9]{64}$/),
  impact: z.string().min(1),
  approvalId: z.string().min(1).optional(),
  exp: z.number().int().positive(),
}).strict()

const ToolCallParams = z.object({
  arguments: z.record(z.unknown()).optional(),
  inputResponses: InputResponses.optional(),
  requestState: z.string().min(1).optional(),
}).passthrough()

export type MrtrInput = {
  inputResponses?: z.infer<typeof InputResponses>
  requestState?: string
}

export type UnwrappedToolCall = MrtrInput & {
  arguments: Record<string, unknown>
}

export type InputRequiredResult = CallToolResult & {
  resultType: 'input_required'
  inputRequests: z.infer<typeof InputRequests>
  requestState: string
}

function invalidRequestState(): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Request state is invalid', {
    detail: 'request_state_invalid',
  })
}

function sealRequestState(secretBox: SecretBox, payload: RequestStatePayload): string {
  const parsed = RequestStatePayloadSchema.parse(payload)
  return secretBox.seal(
    new TextEncoder().encode(JSON.stringify(parsed)),
    purpose,
    additionalData,
  )
}

export function inputRequired(
  elicitations: z.input<typeof InputRequests>,
  requestStatePayload: RequestStatePayload,
  secretBox: SecretBox,
): InputRequiredResult {
  const inputRequests = InputRequests.parse(elicitations)
  return {
    content: [],
    resultType: 'input_required',
    inputRequests,
    requestState: sealRequestState(secretBox, requestStatePayload),
  }
}

export function readMrtr(params: unknown): UnwrappedToolCall {
  const parsed = ToolCallParams.safeParse(params)
  if (!parsed.success) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Multi round-trip input is invalid', {
      detail: 'mrtr_invalid',
    })
  }
  const hasResponses = parsed.data.inputResponses !== undefined
  const hasState = parsed.data.requestState !== undefined
  if (hasResponses !== hasState) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Multi round-trip input is incomplete', {
      detail: 'mrtr_incomplete',
    })
  }
  return {
    arguments: parsed.data.arguments ?? {},
    inputResponses: parsed.data.inputResponses,
    requestState: parsed.data.requestState,
  }
}

export function verifyRequestState(
  state: string,
  ctx: ActorContext,
  tool: string,
  argsHash: string,
  secretBox: SecretBox,
): RequestStatePayload {
  let raw: Uint8Array
  try {
    raw = secretBox.open(state, purpose, additionalData)
  } catch {
    invalidRequestState()
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    invalidRequestState()
  }
  const parsed = RequestStatePayloadSchema.safeParse(decoded)
  if (!parsed.success) invalidRequestState()
  const payload = parsed.data
  const now = Math.floor(ctx.now.getTime() / 1_000)
  if (
    payload.exp <= now
    || payload.exp > now + maxTtlSeconds
    || payload.app !== ctx.app
    || payload.uoaUserId !== ctx.onBehalfOf.uoaUserId
    || payload.tool !== tool
    || payload.argumentsHash !== argsHash
  ) {
    invalidRequestState()
  }
  return payload
}

