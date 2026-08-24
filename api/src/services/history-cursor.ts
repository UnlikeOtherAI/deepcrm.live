import { canonicalJson, type TenantRef } from '@deepcrm/db'
import { ErrorCode, IsoDateTime, ServiceError, Uuid, type SecretBox } from '@deepcrm/schemas'

export type HistoryCursorState = {
  occurredAt: string
  seq: string
  id: string
}

export type HistoryCursorBinding = {
  tool: 'crm_record_history'
  tenant: TenantRef
  arguments: {
    id: string
    attributes: readonly string[] | null
    limit: number
  }
}

export type HistoryCursorCodec = {
  seal: (state: HistoryCursorState, binding: HistoryCursorBinding) => string
  open: (cursor: string, binding: HistoryCursorBinding) => HistoryCursorState
}

const purpose = 'deepcrm.record-history-cursor.v1'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function cursorMismatch(): ServiceError {
  return new ServiceError(ErrorCode.VALIDATION_FAILED, 'Record history cursor does not match', {
    detail: 'cursor_mismatch',
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseState(value: unknown): HistoryCursorState {
  if (!isRecord(value)) throw cursorMismatch()
  const keys = Object.keys(value)
  if (
    keys.length !== 3
    || !keys.includes('occurredAt')
    || !keys.includes('seq')
    || !keys.includes('id')
  ) {
    throw cursorMismatch()
  }
  const occurredAt = value['occurredAt']
  const seq = value['seq']
  const id = value['id']
  if (
    typeof occurredAt !== 'string'
    || !IsoDateTime.safeParse(occurredAt).success
    || typeof seq !== 'string'
    || !/^(0|[1-9]\d*)$/.test(seq)
    || typeof id !== 'string'
    || !Uuid.safeParse(id).success
  ) {
    throw cursorMismatch()
  }
  return { occurredAt, seq, id }
}

function additionalData(binding: HistoryCursorBinding): Uint8Array {
  return encoder.encode(canonicalJson({
    format: purpose,
    tool: binding.tool,
    tenant: binding.tenant,
    arguments: binding.arguments,
  }))
}

export function createHistoryCursorCodec(secretBox: SecretBox): HistoryCursorCodec {
  return {
    seal: (state, binding) => (
      secretBox.seal(encoder.encode(canonicalJson(parseState(state))), purpose, additionalData(binding))
    ),
    open: (cursor, binding) => {
      try {
        const plaintext = secretBox.open(cursor, purpose, additionalData(binding))
        const decoded: unknown = JSON.parse(decoder.decode(plaintext))
        return parseState(decoded)
      } catch {
        throw cursorMismatch()
      }
    },
  }
}
