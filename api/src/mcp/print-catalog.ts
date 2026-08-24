import { describeTools } from './catalog.js'

process.stdout.write(`${JSON.stringify(await describeTools())}\n`)
