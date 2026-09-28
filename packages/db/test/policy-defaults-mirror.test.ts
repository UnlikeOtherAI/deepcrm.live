import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

// docs/spec/policy-defaults.json is the normative copy readers are pointed at;
// packages/db/src/policy-defaults.json is the one the seed imports. They are one
// document, byte for byte.
describe('policy defaults mirror', () => {
  it('keeps the spec copy byte-equal to the seeded source', async () => {
    const [source, spec] = await Promise.all([
      readFile(new URL('../src/policy-defaults.json', import.meta.url)),
      readFile(new URL('../../../docs/spec/policy-defaults.json', import.meta.url)),
    ])
    expect(spec.equals(source)).toBe(true)
  })
})
