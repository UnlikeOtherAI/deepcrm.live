import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const migrationsDir = 'packages/db/prisma/migrations'

if (!existsSync(migrationsDir)) {
  process.exit(0)
}

const namePattern = /^\d{14}_[a-z0-9_]+$/
const hotTables = /\b(?:records|record_changes|record_search)\b/
const createIndex = /CREATE\s+(?:UNIQUE\s+)?INDEX(?!\s+CONCURRENTLY)/i

const entries = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

let failed = false

for (const name of entries) {
  if (!namePattern.test(name)) {
    console.error(`${migrationsDir}/${name}: directory name must match ^\\d{14}_[a-z0-9_]+$`)
    failed = true
  }
}

// The first directory alphabetically is the initial migration and may
// create its indexes plainly; later migrations touching hot tables must
// use CREATE INDEX CONCURRENTLY.
const initial = entries[0]

for (const name of entries) {
  if (name === initial) continue
  const dir = join(migrationsDir, name)
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.sql')) continue
    const sql = readFileSync(join(dir, file), 'utf8')
    for (const statement of sql.split(';')) {
      if (createIndex.test(statement) && hotTables.test(statement)) {
        console.error(
          `${migrationsDir}/${name}/${file}: CREATE INDEX on records|record_changes|record_search ` +
            'without CONCURRENTLY (only the initial migration may do this)',
        )
        failed = true
      }
    }
  }
}

process.exit(failed ? 1 : 0)
