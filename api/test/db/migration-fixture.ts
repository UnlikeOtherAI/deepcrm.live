import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createDb } from '@deepcrm/db'

/**
 * Runs migrations one by one against a scratch database, the way a deploy
 * meets them: everything before a migration, then that migration (again, to
 * prove it idempotent), then the rest.
 */

const execFile = promisify(execFileCallback)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const dbDir = resolve(repoRoot, 'packages/db')
const migrationsDir = resolve(dbDir, 'prisma/migrations')
const schemaPath = resolve(dbDir, 'prisma/schema.prisma')
const prismaCli = resolve(dirname(createRequire(resolve(dbDir, 'package.json')).resolve('prisma/package.json')),
  'build/index.js')

export const migrationTestTimeout = 240_000

function databaseUrl(base: string, name: string): string {
  const parsed = new URL(base)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

function quotedDatabase(name: string): string {
  if (!/^deepcrm_w1_[0-9a-f]{32}$/u.test(name)) throw new Error('Unsafe database name')
  return `"${name}"`
}

/** A fresh, empty database for the callback, dropped afterwards. */
export async function withDatabase(base: string, callback: (database: string) => Promise<void>): Promise<void> {
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

async function migrationNames(): Promise<string[]> {
  return (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/** Applies one migration, by directory name. */
export async function runMigration(database: string, name: string): Promise<void> {
  if (!(await migrationNames()).includes(name)) throw new Error(`Unknown migration ${name}`)
  await executeFile(database, resolve(migrationsDir, name, 'migration.sql'))
}

/** Applies every migration that sorts before `name`. */
export async function deployBefore(database: string, name: string): Promise<void> {
  for (const migration of (await migrationNames()).filter((candidate) => candidate < name)) {
    await runMigration(database, migration)
  }
}

/** Applies every migration that sorts after `name`. */
export async function deployAfter(database: string, name: string): Promise<void> {
  for (const migration of (await migrationNames()).filter((candidate) => candidate > name)) {
    await runMigration(database, migration)
  }
}
