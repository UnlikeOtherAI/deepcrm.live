import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer } from './harness.js'

let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>

beforeAll(async () => {
  const started = await startTestServer()
  client = started.client
  closeServer = started.close
})

afterAll(async () => {
  await closeServer()
})

describe('MCP prompts', () => {
  it('lists the three CRM prompts with private cache metadata', async () => {
    const result = await client.listPrompts()

    expect(result.prompts.map((prompt) => prompt.name)).toEqual([
      'crm/qualify-lead',
      'crm/prepare-account-review',
      'crm/clean-duplicates',
    ])
    expect(result).toMatchObject({
      ttlMs: 300_000,
      cacheScope: 'private',
      resultType: 'complete',
    })
    for (const prompt of result.prompts) {
      expect(prompt.arguments).toHaveLength(1)
      expect(prompt.arguments?.[0]).toMatchObject({ required: true })
    }
  })

  it('substitutes record_id in the qualify-lead prompt', async () => {
    const result = await client.getPrompt({
      name: 'crm/qualify-lead',
      arguments: { record_id: 'rec_qualify_123' },
    })

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({
      role: 'user',
      content: { type: 'text' },
    })
    const content = result.messages[0]?.content
    expect(content?.type).toBe('text')
    if (content?.type !== 'text') throw new Error('Expected a text prompt message')
    expect(content.text).toContain('rec_qualify_123')
    expect(content.text).toContain('approval gates server-side')
  })
})
