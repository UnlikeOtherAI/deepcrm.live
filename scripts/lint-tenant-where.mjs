import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['api/src', 'worker/src', 'packages/schema-engine/src']

const callPattern = new RegExp(
  'prisma\\.(record|recordLink|recordChange|recordUniqueKey|recordMatchKey|recordMatchLookupKey|recordSearch|objectType|' +
    'attribute|relationType|matchingRule|matchingRuleGeneration|list|listEntry|view|policyRule|policyBinding|approvalRequest|' +
    'webhook|idempotencyReplay)\\.(findMany|findFirst|findUnique|count|aggregate|updateMany|deleteMany)\\(',
)

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.name.endsWith('.ts')) yield path
  }
}

let failed = false

for (const root of roots) {
  if (!existsSync(root)) continue
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line || !callPattern.test(line)) continue
      const window = lines.slice(i + 1, i + 6).join('\n')
      if (!window.includes('tenantWhere(') && !window.includes('// tenant-checked:')) {
        console.error(`${file}:${i + 1}: tenant-scoped model query must use tenantWhere() within the next 5 lines`)
        failed = true
      }
    }
  }
}

process.exit(failed ? 1 : 0)
