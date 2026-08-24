import { createHash, randomBytes } from 'node:crypto'

const name = process.argv[2]

if (name === undefined || !/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
  process.stderr.write('usage: node scripts/generate-app-key.mjs <name>\n')
  process.exit(2)
}

const key = `dck_${randomBytes(32).toString('base64url')}`
const hash = createHash('sha256').update(key, 'utf8').digest('hex')

process.stdout.write(`key=${key}\n${name}:${hash}\n`)
