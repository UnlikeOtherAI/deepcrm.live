import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici'

export type ResolvedAddress = { address: string; family: 4 | 6 }
export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>
export type SafeFetchResponse = { ok: boolean; status: number }
export type SafeFetch = (
  url: string,
  init: Readonly<{ method?: string; headers?: Record<string, string>; body?: string }>,
) => Promise<SafeFetchResponse>
export type SafeFetchRequester = (
  url: URL,
  init: Readonly<{
    method?: string
    headers?: Record<string, string>
    body?: string
    redirect: 'manual'
    dispatcher: Dispatcher
  }>,
) => Promise<SafeFetchResponse>

export const systemResolver: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.flatMap((address) => (
    address.family === 4 || address.family === 6
      ? [{ address: address.address, family: address.family }]
      : []
  ))
}

function ipv4Bytes(address: string): readonly number[] | null {
  if (isIP(address) !== 4) return null
  const bytes = address.split('.').map(Number)
  return bytes.length === 4 && bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? bytes
    : null
}

function publicIpv4(address: string): boolean {
  const bytes = ipv4Bytes(address)
  if (bytes === null) return false
  const first = bytes[0]
  const second = bytes[1]
  if (first === undefined || second === undefined) return false
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false
  if (first === 100 && second >= 64 && second <= 127) return false
  if (first === 169 && second === 254) return false
  if (first === 172 && second >= 16 && second <= 31) return false
  if (first === 192 && (second === 0 || second === 168)) return false
  if (first === 198 && (second === 18 || second === 19)) return false
  return true
}

function publicIpv6(address: string): boolean {
  if (isIP(address) !== 6) return false
  const normalized = address.toLowerCase().split('%')[0] ?? ''
  if (normalized === '::' || normalized === '::1') return false
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false
  if (/^fe[89ab]/u.test(normalized)) return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1]
  return mapped === undefined || publicIpv4(mapped)
}

function publicAddress(address: ResolvedAddress): boolean {
  return address.family === 4 ? publicIpv4(address.address) : publicIpv6(address.address)
}

function parseTarget(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Webhook URL is invalid')
  }
  if (url.protocol !== 'https:') throw new Error('Webhook URL must use HTTPS')
  if (url.port !== '' && url.port !== '443') throw new Error('Webhook URL must use port 443')
  if (url.username !== '' || url.password !== '') throw new Error('Webhook URL must not contain userinfo')
  return url
}

export async function assertSafeUrl(
  value: string,
  resolver: HostResolver = systemResolver,
): Promise<URL> {
  const url = parseTarget(value)
  const addresses = await resolver(url.hostname)
  if (addresses.length === 0 || addresses.some((address) => !publicAddress(address))) {
    throw new Error('Webhook URL resolves to a non-public address')
  }
  return url
}

const request: SafeFetchRequester = async (url, init) => {
  const response = await undiciFetch(url, init)
  await response.body?.cancel()
  return { ok: response.status >= 200 && response.status < 300, status: response.status }
}

export function createSafeFetch(
  resolver: HostResolver = systemResolver,
  requester: SafeFetchRequester = request,
): SafeFetch {
  return async (value, init) => {
    const url = parseTarget(value)
    const addresses = await resolver(url.hostname)
    if (addresses.length === 0 || addresses.some((address) => !publicAddress(address))) {
      throw new Error('Webhook URL resolves to a non-public address')
    }
    const first = addresses[0]
    if (first === undefined) throw new Error('Webhook hostname did not resolve')
    const dispatcher = new Agent({
      connect: {
        lookup(_hostname, options, callback) {
          if (options.all) callback(null, [...addresses])
          else callback(null, first.address, first.family)
        },
      },
    })
    try {
      return await requester(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        redirect: 'manual',
        dispatcher,
      })
    } finally {
      await dispatcher.close()
    }
  }
}
