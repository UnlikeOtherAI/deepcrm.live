import { canonicalJson, type TenantRef } from '@deepcrm/db'
import type { QueryCursorState } from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError, Uuid, type SecretBox } from '@deepcrm/schemas'

export type QueryCursorBinding = {
  tool: string
  tenant: TenantRef
  arguments: Record<string, unknown>
}

export type QueryCursorCodec = {
  seal: (state: QueryCursorState, binding: QueryCursorBinding) => string
  open: (cursor: string, binding: QueryCursorBinding) => QueryCursorState
}

const purpose = 'deepcrm.query-cursor.v1'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function cursorMismatch(): ServiceError {
  return new ServiceError(ErrorCode.VALIDATION_FAILED, 'Query cursor does not match', {
    detail: 'cursor_mismatch',
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortCount(binding: QueryCursorBinding): number {
  const sort = binding.arguments['sort']
  if (!Array.isArray(sort) || sort.length < 1 || sort.length > 3) throw cursorMismatch()
  return sort.length
}

function parseState(value: unknown, binding: QueryCursorBinding): QueryCursorState {
  if (!isRecord(value)) throw cursorMismatch()
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('values') || !keys.includes('id')) throw cursorMismatch()
  const id = value['id']
  const values = value['values']
  if (
    !Uuid.safeParse(id).success
    || !Array.isArray(values)
    || values.length !== sortCount(binding)
  ) {
    throw cursorMismatch()
  }
  const parsedValues: QueryCursorState['values'][number][] = []
  for (const item of values) {
    if (!isRecord(item)) throw cursorMismatch()
    const itemKeys = Object.keys(item)
    if (itemKeys.length !== 2 || !itemKeys.includes('isNull') || !itemKeys.includes('value')) {
      throw cursorMismatch()
    }
    const isNull = item['isNull']
    const itemValue = item['value']
    if (typeof isNull !== 'boolean') throw cursorMismatch()
    if (isNull) {
      if (itemValue !== null) throw cursorMismatch()
      parsedValues.push({ isNull, value: null })
    } else {
      if (typeof itemValue !== 'string') throw cursorMismatch()
      parsedValues.push({ isNull, value: itemValue })
    }
  }
  if (typeof id !== 'string') throw cursorMismatch()
  return { id, values: parsedValues }
}

function additionalData(binding: QueryCursorBinding): Uint8Array {
  return encoder.encode(canonicalJson({
    format: 'deepcrm.query-cursor.v1',
    tool: binding.tool,
    tenant: binding.tenant,
    arguments: binding.arguments,
  }))
}

export function createQueryCursorCodec(secretBox: SecretBox): QueryCursorCodec {
  return {
    seal: (state, binding) => {
      const parsed = parseState(state, binding)
      return secretBox.seal(
        encoder.encode(canonicalJson(parsed)),
        purpose,
        additionalData(binding),
      )
    },
    open: (cursor, binding) => {
      try {
        const plaintext = secretBox.open(cursor, purpose, additionalData(binding))
        const decoded: unknown = JSON.parse(decoder.decode(plaintext))
        return parseState(decoded, binding)
      } catch {
        throw cursorMismatch()
      }
    },
  }
}
