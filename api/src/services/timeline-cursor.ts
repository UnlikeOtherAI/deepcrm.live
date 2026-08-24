import { canonicalJson, type TenantRef } from '@deepcrm/db'
import { ErrorCode, IsoDateTime, ServiceError, Uuid, type SecretBox } from '@deepcrm/schemas'

export type TimelineCursorState = {
  occurredAt: string
  kind: 'activity' | 'change' | 'note' | 'task'
  id: string
}

export type TimelineCursorBinding = {
  tool: 'crm_record_timeline'
  tenant: TenantRef
  arguments: {
    id: string
    hops: 0 | 1
    relation_types: readonly string[] | null
    kinds: readonly string[] | null
    since: string | null
    limit: number
  }
}

export type TimelineCursorCodec = {
  seal: (state: TimelineCursorState, binding: TimelineCursorBinding) => string
  open: (cursor: string, binding: TimelineCursorBinding) => TimelineCursorState
}

const purpose = 'deepcrm.record-timeline-cursor.v1'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function cursorMismatch(): ServiceError {
  return new ServiceError(ErrorCode.VALIDATION_FAILED, 'Record timeline cursor does not match', {
    detail: 'cursor_mismatch',
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseState(value: unknown): TimelineCursorState {
  if (!isRecord(value)) throw cursorMismatch()
  const keys = Object.keys(value)
  if (
    keys.length !== 3
    || !keys.includes('occurredAt')
    || !keys.includes('kind')
    || !keys.includes('id')
  ) {
    throw cursorMismatch()
  }
  const occurredAt = value['occurredAt']
  const kind = value['kind']
  const id = value['id']
  if (
    typeof occurredAt !== 'string'
    || !IsoDateTime.safeParse(occurredAt).success
    || (kind !== 'activity' && kind !== 'change' && kind !== 'note' && kind !== 'task')
    || typeof id !== 'string'
    || !Uuid.safeParse(id).success
  ) {
    throw cursorMismatch()
  }
  return { occurredAt, kind, id }
}

function additionalData(binding: TimelineCursorBinding): Uint8Array {
  return encoder.encode(canonicalJson({
    format: purpose,
    tool: binding.tool,
    tenant: binding.tenant,
    arguments: binding.arguments,
  }))
}

export function createTimelineCursorCodec(secretBox: SecretBox): TimelineCursorCodec {
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
