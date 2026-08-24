import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { SecretBoxError, parseSecretBox } from './secret-box.js'

function keyring(active = 'current', entries: Record<string, Buffer> = { current: randomBytes(32) }): string {
  return Buffer.from(JSON.stringify({
    active,
    keys: Object.fromEntries(Object.entries(entries).map(([kid, key]) => [kid, key.toString('base64')])),
  }), 'utf8').toString('base64')
}

describe('secret box', () => {
  it('seals opaque AES-GCM envelopes and binds purpose plus AAD', () => {
    const box = parseSecretBox(keyring())
    const token = box.seal(Buffer.from('cursor-state'), 'deepcrm.query-cursor.v1', Buffer.from('binding'))

    expect(token).not.toContain('cursor-state')
    expect(Buffer.from(box.open(token, 'deepcrm.query-cursor.v1', Buffer.from('binding'))).toString('utf8'))
      .toBe('cursor-state')
    expect(() => box.open(token, 'deepcrm.query-cursor.v1', Buffer.from('other')))
      .toThrow(new SecretBoxError('INVALID_ENVELOPE', 'Invalid sealed value'))
    expect(() => box.open(token, 'deepcrm.webhook.v1', Buffer.from('binding')))
      .toThrow(new SecretBoxError('INVALID_ENVELOPE', 'Invalid sealed value'))
  })

  it('accepts retained rotation keys and rejects an unknown kid or tampering', () => {
    const old = randomBytes(32)
    const current = randomBytes(32)
    const oldBox = parseSecretBox(keyring('old', { old, current }))
    const token = oldBox.seal(Buffer.from('state'), 'purpose', Buffer.from('aad'))
    const rotated = parseSecretBox(keyring('current', { old, current }))

    expect(Buffer.from(rotated.open(token, 'purpose', Buffer.from('aad'))).toString()).toBe('state')
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
    decoded.kid = 'gone'
    const unknownKid = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    expect(() => rotated.open(unknownKid, 'purpose', Buffer.from('aad'))).toThrow(SecretBoxError)
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`
    expect(() => rotated.open(tampered, 'purpose', Buffer.from('aad'))).toThrow(SecretBoxError)
  })

  it('fails closed for malformed keyrings and envelopes', () => {
    expect(() => parseSecretBox('not base64')).toThrow(new SecretBoxError('INVALID_KEYRING', 'Invalid secret keyring'))
    expect(() => parseSecretBox(Buffer.from(JSON.stringify({ active: 'a', keys: { a: 'AA==' } })).toString('base64')))
      .toThrow(SecretBoxError)

    const box = parseSecretBox(keyring())
    expect(() => box.open('not-an-envelope!', 'purpose', Buffer.from('aad'))).toThrow(SecretBoxError)
  })
})
