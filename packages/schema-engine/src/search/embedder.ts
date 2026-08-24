import { createHash } from 'node:crypto'

import { EMBEDDING_DIMENSIONS } from '@deepcrm/schemas'
import { z } from 'zod'

export type Embedder = {
  readonly model: string
  embed(texts: string[]): Promise<number[][]>
}

export type LedgerEmbedderOptions = {
  publicUrl: string
  token: string
  model: string
  fetcher?: typeof fetch
}

const LedgerResponse = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) }).passthrough()),
}).passthrough()

function assertEmbeddings(embeddings: number[][], expected: number): number[][] {
  if (embeddings.length !== expected) throw new Error('Embedding response count does not match input')
  for (const embedding of embeddings) {
    if (embedding.length !== EMBEDDING_DIMENSIONS || embedding.some((value) => !Number.isFinite(value))) {
      throw new Error(`Embedding width must be ${EMBEDDING_DIMENSIONS}`)
    }
  }
  return embeddings
}

export class LedgerEmbedder implements Embedder {
  readonly model: string
  readonly #endpoint: string
  readonly #token: string
  readonly #fetcher: typeof fetch

  constructor(options: LedgerEmbedderOptions) {
    this.model = options.model
    this.#endpoint = `${options.publicUrl.replace(/\/$/u, '')}/v1/jina/embeddings`
    this.#token = options.token
    this.#fetcher = options.fetcher ?? globalThis.fetch
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const response = await this.#fetcher(this.#endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts, dimensions: EMBEDDING_DIMENSIONS }),
    })
    if (!response.ok) throw new Error(`Ledger embedding request failed with status ${response.status}`)
    const body: unknown = await response.json()
    const parsed = LedgerResponse.safeParse(body)
    if (!parsed.success) throw new Error('Ledger embedding response is invalid')
    return assertEmbeddings(parsed.data.data.map((item) => item.embedding), texts.length)
  }
}

export class FakeEmbedder implements Embedder {
  constructor(readonly model: string = 'fake-sha256-v1') {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const embedding: number[] = []
      for (let block = 0; embedding.length < EMBEDDING_DIMENSIONS; block += 1) {
        const digest = createHash('sha256').update(text).update('\0').update(String(block)).digest()
        for (const byte of digest) {
          if (embedding.length === EMBEDDING_DIMENSIONS) break
          embedding.push(byte / 127.5 - 1)
        }
      }
      return embedding
    })
  }
}

