import { describe, expect, it, vi } from 'vitest'

import { assertSafeUrl, createSafeFetch, type HostResolver } from './safe-fetch.js'

const publicResolver: HostResolver = async () => [{ address: '203.0.113.10', family: 4 }]

describe('safe webhook transport', () => {
  it('accepts only public HTTPS port 443 targets without userinfo', async () => {
    await expect(assertSafeUrl('https://hooks.example.test/path', publicResolver)).resolves.toBeInstanceOf(URL)
    await expect(assertSafeUrl('http://hooks.example.test', publicResolver)).rejects.toThrow('HTTPS')
    await expect(assertSafeUrl('https://hooks.example.test:8443', publicResolver)).rejects.toThrow('port 443')
    await expect(assertSafeUrl('https://user:pass@hooks.example.test', publicResolver)).rejects.toThrow('userinfo')
  })

  it.each([
    ['127.0.0.1', 4], ['10.0.0.1', 4], ['169.254.1.1', 4], ['192.168.1.1', 4],
    ['::1', 6], ['fc00::1', 6], ['fe80::1', 6],
  ] as const)('rejects non-public address %s', async (address, family) => {
    await expect(assertSafeUrl('https://hooks.example.test', async () => [{ address, family }]))
      .rejects.toThrow('non-public')
  })

  it('re-resolves, pins the accepted addresses, and refuses redirects on every attempt', async () => {
    const resolver = vi.fn<HostResolver>()
      .mockResolvedValueOnce([{ address: '203.0.113.10', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    const requester = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    const safeFetch = createSafeFetch(resolver, requester)

    await expect(safeFetch('https://hooks.example.test/events', { method: 'POST' }))
      .resolves.toEqual({ ok: true, status: 204 })
    expect(requester.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
    await expect(safeFetch('https://hooks.example.test/events', { method: 'POST' }))
      .rejects.toThrow('non-public')
    expect(requester).toHaveBeenCalledTimes(1)
  })
})
