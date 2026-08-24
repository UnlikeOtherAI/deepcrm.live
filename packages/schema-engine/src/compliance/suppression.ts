import { createHash } from 'node:crypto'
import { domainToASCII } from 'node:url'
import emailAddresses from 'email-addresses'
import { parsePhoneNumberFromString } from 'libphonenumber-js'
import { getDomain } from 'tldts'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

export type SuppressionKind = 'email' | 'phone' | 'domain' | 'company_number' | 'postal'

function validationFailed(): ServiceError {
  return new ServiceError(ErrorCode.VALIDATION_FAILED, 'Suppression value is invalid', {
    issues: [{ path: '/value', message: 'Invalid suppression value' }],
  })
}

function email(value: string): string {
  const parsed = emailAddresses.parseOneAddress({ input: value.trim(), strict: true })
  if (parsed === null || parsed.type !== 'mailbox') throw validationFailed()
  return `${parsed.local}@${parsed.domain}`.toLocaleLowerCase()
}

function hostnameFor(value: string): string {
  const trimmed = value.trim()
  if (/^https?:\/\//iu.test(trimmed)) return new URL(trimmed).hostname
  if (trimmed.includes('://')) throw validationFailed()
  return domainToASCII(trimmed)
}

function domain(value: string): string {
  const registrable = getDomain(hostnameFor(value), { allowPrivateDomains: true })
  if (registrable === null) throw validationFailed()
  return registrable.toLocaleLowerCase()
}

function phone(value: string): string {
  const trimmed = value.trim()
  if (!/^\+[0-9](?:[0-9\s]*[0-9])?$/u.test(trimmed)) throw validationFailed()
  const parsed = parsePhoneNumberFromString(trimmed)
  if (parsed === undefined || !parsed.isValid()) throw validationFailed()
  return parsed.number
}

function companyNumber(value: string): string {
  const canonical = value.toLocaleUpperCase().replace(/[\s.-]/gu, '').replace(/^0+/u, '')
  if (canonical === '') throw validationFailed()
  return canonical
}

function postal(value: string): string {
  const canonical = value.trim().toLocaleUpperCase().replace(/\s+/gu, ' ')
  if (canonical === '') throw validationFailed()
  return canonical
}

export function normalizeSuppression(kind: SuppressionKind, value: string): string {
  switch (kind) {
    case 'email':
      return email(value)
    case 'phone':
      return phone(value)
    case 'domain':
      return domain(value)
    case 'company_number':
      return companyNumber(value)
    case 'postal':
      return postal(value)
  }
}

export function suppressionHash(kind: SuppressionKind, value: string): string {
  const normalized = normalizeSuppression(kind, value)
  return createHash('sha256').update(`${kind}\x1f${normalized}`, 'utf8').digest('hex')
}
