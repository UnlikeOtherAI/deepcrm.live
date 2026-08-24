import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

import { z } from 'zod'

const algorithm = 'aes-256-gcm'
const envelopeVersion = 1
const ivBytes = 12
const tagBytes = 16
const domain = Buffer.from('deepcrm.secret-box.v1\u0000', 'utf8')

const KeyringSchema = z.object({
  active: z.string().min(1).max(64),
  keys: z.record(z.string().min(1).max(128)),
}).strict().superRefine(({ active, keys }, context) => {
  if (!(active in keys)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'active key is absent' })
  }
  if (Object.keys(keys).length > 32) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'too many keys' })
  }
})

const EnvelopeSchema = z.object({
  v: z.literal(envelopeVersion),
  kid: z.string().min(1).max(64),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
  tag: z.string().min(1),
}).strict()

type Envelope = z.infer<typeof EnvelopeSchema>

export type SecretBoxErrorCode = 'INVALID_KEYRING' | 'INVALID_ENVELOPE'

export class SecretBoxError extends Error {
  constructor(public readonly code: SecretBoxErrorCode, message: string) {
    super(message)
    this.name = 'SecretBoxError'
  }
}

export type SecretBox = {
  assertKey(keyId: string): void
  seal(plaintext: Uint8Array, purpose: string, additionalData: Uint8Array): string
  open(envelope: string, purpose: string, additionalData: Uint8Array): Uint8Array
  sign(message: Uint8Array, keyId: string): string
  verify(signature: string, message: Uint8Array, keyId: string): boolean
}

function invalidKeyring(): never {
  throw new SecretBoxError('INVALID_KEYRING', 'Invalid secret keyring')
}

function invalidEnvelope(): never {
  throw new SecretBoxError('INVALID_ENVELOPE', 'Invalid sealed value')
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    invalidKeyring()
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) invalidKeyring()
  return decoded
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalidEnvelope()
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) invalidEnvelope()
  return decoded
}

function parseEnvelope(value: string): Envelope {
  let decoded: Buffer
  try {
    decoded = decodeBase64Url(value)
  } catch (error) {
    if (error instanceof SecretBoxError) throw error
    invalidEnvelope()
  }
  let raw: unknown
  try {
    raw = JSON.parse(decoded.toString('utf8'))
  } catch {
    invalidEnvelope()
  }
  const parsed = EnvelopeSchema.safeParse(raw)
  if (!parsed.success) invalidEnvelope()
  return parsed.data
}

function aad(purpose: string, additionalData: Uint8Array): Buffer {
  if (purpose.length === 0 || purpose.length > 128 || additionalData.byteLength > 65_536) {
    invalidEnvelope()
  }
  return Buffer.concat([domain, Buffer.from(purpose, 'utf8'), Buffer.from([0]), Buffer.from(additionalData)])
}

function encodeEnvelope(envelope: Envelope): string {
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')
}

export function parseSecretBox(encodedKeyring: string): SecretBox {
  let raw: unknown
  try {
    raw = JSON.parse(decodeBase64(encodedKeyring).toString('utf8'))
  } catch (error) {
    if (error instanceof SecretBoxError) throw error
    invalidKeyring()
  }
  const parsed = KeyringSchema.safeParse(raw)
  if (!parsed.success) invalidKeyring()

  const keys = new Map<string, Buffer>()
  for (const [kid, encodedKey] of Object.entries(parsed.data.keys)) {
    const key = decodeBase64(encodedKey)
    if (key.byteLength !== 32) invalidKeyring()
    keys.set(kid, key)
  }
  const activeKey = keys.get(parsed.data.active)
  if (activeKey === undefined) invalidKeyring()

  return {
    assertKey(keyId) {
      if (!keys.has(keyId)) invalidKeyring()
    },
    seal(plaintext, purpose, additionalData) {
      const iv = randomBytes(ivBytes)
      const cipher = createCipheriv(algorithm, activeKey, iv, { authTagLength: tagBytes })
      cipher.setAAD(aad(purpose, additionalData))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const tag = cipher.getAuthTag()
      return encodeEnvelope({
        v: envelopeVersion,
        kid: parsed.data.active,
        iv: iv.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        tag: tag.toString('base64url'),
      })
    },
    open(value, purpose, additionalData) {
      const envelope = parseEnvelope(value)
      const key = keys.get(envelope.kid)
      if (key === undefined) invalidEnvelope()
      const iv = decodeBase64Url(envelope.iv)
      const ciphertext = decodeBase64Url(envelope.ciphertext)
      const tag = decodeBase64Url(envelope.tag)
      if (iv.byteLength !== ivBytes || tag.byteLength !== tagBytes) invalidEnvelope()
      try {
        const decipher = createDecipheriv(algorithm, key, iv, { authTagLength: tagBytes })
        decipher.setAAD(aad(purpose, additionalData))
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(ciphertext), decipher.final()])
      } catch {
        invalidEnvelope()
      }
    },
    sign(message, keyId) {
      const key = keys.get(keyId)
      if (key === undefined) invalidKeyring()
      return createHmac('sha256', key).update(message).digest('base64url')
    },
    verify(signature, message, keyId) {
      const key = keys.get(keyId)
      if (key === undefined) invalidKeyring()
      if (!/^[A-Za-z0-9_-]+$/u.test(signature)) return false
      const supplied = Buffer.from(signature, 'base64url')
      const expected = createHmac('sha256', key).update(message).digest()
      return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
    },
  }
}
