import { createDb, writeAudit, type Db } from '@deepcrm/db'
import { createProjectionLinkWriter } from '@deepcrm/schema-engine'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createAppDeps, type AppDeps } from '../src/deps.js'
import { parseEnv, type Env } from '../src/env.js'

const testEnv: Env = parseEnv({ DATABASE_URL: 'postgresql://unused', NODE_ENV: 'test' })

function makeDeps(ok: boolean): AppDeps {
  const db: Db = createDb('postgresql://unused')
  const queryRaw = (): Promise<unknown> =>
    ok ? Promise.resolve([{ '?column?': 1 }]) : Promise.reject(new Error('db down'))
  Reflect.defineProperty(db, '$queryRaw', { value: queryRaw, configurable: true })
  return {
    db,
    clock: () => new Date(),
    ids: () => 'id_test',
    version: '0.0.0',
    orgAllowlist: null,
    linkWriter: createProjectionLinkWriter(),
    writeAudit,
  }
}

describe('GET /health', () => {
  it('returns 200 with ok:true and db:ok when the database answers SELECT 1', async () => {
    const app = buildApp(makeDeps(true), testEnv)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, version: '0.0.0', db: 'ok' })
    await app.close()
  })

  it('returns 503 with ok:true and db:error when the database fails', async () => {
    const app = buildApp(makeDeps(false), testEnv)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ ok: true, version: '0.0.0', db: 'error' })
    await app.close()
  })
})

describe('createAppDeps', () => {
  it('parses the organization allowlist once into a normalized set', async () => {
    const deps = createAppDeps(parseEnv({
      DATABASE_URL: 'postgresql://unused',
      NODE_ENV: 'test',
      DEEPCRM_ORG_ALLOWLIST: ' org_a,org_b, org_a ',
    }))

    expect(deps.orgAllowlist).not.toBeNull()
    if (deps.orgAllowlist === null) throw new Error('expected an organization allowlist')
    expect([...deps.orgAllowlist]).toEqual(['org_a', 'org_b'])
    expect(deps.writeAudit).toBe(writeAudit)
    await deps.db.$disconnect()
  })
})
