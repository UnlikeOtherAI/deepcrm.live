import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createDb, policyDefaults, seedTenant, type Db, type TenantRef } from '@deepcrm/db'
import { describe, expect, it } from 'vitest'

import { seedDefaultPolicies } from '../../src/services/policy.js'

// Migration 20260929120000_nessie_agent_policy_bindings on a team provisioned
// before policy-defaults.json gained its agent:nessie:* rows: the team ends
// with exactly the rows a fresh seed writes, so seedDefaultPolicies reports no
// drift, and its policy_version moves once however often the migration runs.

const execFile = promisify(execFileCallback)
const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required for the policy seed migration test')
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const dbDir = resolve(repoRoot, 'packages/db')
const migrationsDir = resolve(dbDir, 'prisma/migrations')
const schemaPath = resolve(dbDir, 'prisma/schema.prisma')
const prismaCli = resolve(dirname(createRequire(resolve(dbDir, 'package.json')).resolve('prisma/package.json')),
  'build/index.js')
const migrationName = '20260929120000_nessie_agent_policy_bindings'
const migrationTestTimeout = 240_000
const NESSIE_WILDCARD = 'agent:nessie:*'

function databaseUrl(base: string, name: string): string {
  const parsed = new URL(base)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

function quotedDatabase(name: string): string {
  if (!/^deepcrm_w1_[0-9a-f]{32}$/u.test(name)) throw new Error('Unsafe database name')
  return `"${name}"`
}

async function withDatabase(base: string, callback: (database: string) => Promise<void>): Promise<void> {
  const name = `deepcrm_w1_${randomUUID().replaceAll('-', '')}`
  const admin = createDb(databaseUrl(base, 'postgres'))
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE ${quotedDatabase(name)}`)
    await callback(databaseUrl(base, name))
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quotedDatabase(name)} WITH (FORCE)`)
    await admin.$disconnect()
  }
}

async function executeFile(database: string, file: string): Promise<void> {
  try {
    // The CLI's own entry under node: no shell, so the same call works on every platform.
    await execFile(process.execPath, [prismaCli, 'db', 'execute', '--schema', schemaPath, '--file', file], {
      cwd: dbDir,
      env: { ...process.env, DATABASE_URL: database, DIRECT_DATABASE_URL: database },
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (error) {
    const output = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : ''
    throw new Error(`prisma db execute failed for ${file}\n${output.replaceAll(database, '[DATABASE_URL]')}`, {
      cause: error,
    })
  }
}

async function deployBeforeMigration(database: string): Promise<void> {
  const names = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name < migrationName)
    .map((entry) => entry.name)
    .sort()
  for (const name of names) await executeFile(database, resolve(migrationsDir, name, 'migration.sql'))
}

async function runMigration(database: string): Promise<void> {
  await executeFile(database, resolve(migrationsDir, migrationName, 'migration.sql'))
}

/** A team provisioned from the pre-migration JSON: the seed minus its agent:nessie:* rows. */
async function legacyTeam(db: Db): Promise<TenantRef> {
  const seeded = await seedTenant(db)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  await db.$transaction((tx) => seedDefaultPolicies(tx, tenant))
  await db.policyRule.deleteMany({ where: {
    ...tenant, bindings: { some: { actorType: 'agent', actorId: NESSIE_WILDCARD } },
  } })
  await db.team.update({ where: { id: tenant.teamId }, data: { policyVersion: 1 } })
  return tenant
}

async function teamState(db: Db, tenant: TenantRef) {
  const [rules, nessie, team] = await Promise.all([
    db.policyRule.count({ where: tenant }),
    db.policyRule.count({ where: {
      ...tenant, bindings: { some: { actorType: 'agent', actorId: NESSIE_WILDCARD } },
    } }),
    db.team.findUniqueOrThrow({ where: { id: tenant.teamId }, select: { policyVersion: true } }),
  ])
  return { rules, nessie, policyVersion: team.policyVersion }
}

const nessieRules = policyDefaults.rules.filter((rule) => rule.bindings.some(
  ([actorType, actorId]) => actorType === 'agent' && actorId === NESSIE_WILDCARD,
))

describe('nessie agent policy bindings migration', () => {
  it('seeds the wildcard into existing seeded teams without drift and re-runs as a no-op', async () => {
    expect(nessieRules).toHaveLength(26)
    await withDatabase(url, async (database) => {
      await deployBeforeMigration(database)
      const db = createDb(database)
      try {
        const first = await legacyTeam(db)
        const second = await legacyTeam(db)
        const unseededTeam = await seedTenant(db)
        const unseeded = { organizationId: unseededTeam.organizationId, teamId: unseededTeam.teamId }
        const legacyRules = policyDefaults.rules.length - nessieRules.length
        expect(await teamState(db, first)).toEqual({ rules: legacyRules, nessie: 0, policyVersion: 1 })

        await runMigration(database)
        for (const team of [first, second]) {
          expect(await teamState(db, team)).toEqual({
            rules: policyDefaults.rules.length, nessie: 26, policyVersion: 2,
          })
          await expect(db.$transaction((tx) => seedDefaultPolicies(tx, team))).resolves.toEqual({ seeded: false })
        }
        expect(await teamState(db, unseeded)).toEqual({ rules: 0, nessie: 0, policyVersion: 0 })

        await runMigration(database)
        for (const team of [first, second]) {
          expect(await teamState(db, team)).toEqual({
            rules: policyDefaults.rules.length, nessie: 26, policyVersion: 2,
          })
        }
        const bindings = await db.policyBinding.count({ where: {
          actorId: NESSIE_WILDCARD, policyRule: { organizationId: first.organizationId, teamId: first.teamId },
        } })
        expect(bindings).toBe(26)
      } finally {
        await db.$disconnect()
      }
    })
  }, migrationTestTimeout)
})
