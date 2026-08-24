import { EMBEDDING_DIMENSIONS } from '@deepcrm/schemas'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { FakeEmbedder, LedgerEmbedder } from '../src/search/embedder.js'

describe('search embedders', () => {
  it('produces deterministic, model-labelled 1024-wide fake vectors', async () => {
    const embedder = new FakeEmbedder('fake-test-v1')
    const result = await embedder.embed(['same input', 'same input', 'different input'])
    expect(embedder.model).toBe('fake-test-v1')
    expect(result).toHaveLength(3)
    expect(result[0]).toHaveLength(EMBEDDING_DIMENSIONS)
    expect(result[0]).toEqual(result[1])
    expect(result[0]).not.toEqual(result[2])
  })

  it('sends the exact Ledger request and rejects a wrong response width', async () => {
    let endpoint = ''
    let authorization = ''
    let body: unknown
    const fetcher: typeof fetch = async (input, init) => {
      endpoint = String(input)
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      body = JSON.parse(typeof init?.body === 'string' ? init.body : '')
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.25) }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const embedder = new LedgerEmbedder({
      publicUrl: 'https://ledger.example/', token: 'proxy-token', model: 'jina-test', fetcher,
    })
    await expect(embedder.embed(['index me'])).resolves.toHaveLength(1)
    expect(endpoint).toBe('https://ledger.example/v1/jina/embeddings')
    expect(authorization).toBe('Bearer proxy-token')
    expect(z.object({
      model: z.literal('jina-test'), input: z.tuple([z.literal('index me')]),
      dimensions: z.literal(EMBEDDING_DIMENSIONS),
    }).parse(body)).toBeDefined()

    const wrongWidth: typeof fetch = async () => new Response(JSON.stringify({
      data: [{ embedding: [0.25] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    await expect(new LedgerEmbedder({
      publicUrl: 'https://ledger.example', token: 'proxy-token', model: 'jina-test',
      fetcher: wrongWidth,
    }).embed(['index me'])).rejects.toThrow(`Embedding width must be ${EMBEDDING_DIMENSIONS}`)
  })
})

