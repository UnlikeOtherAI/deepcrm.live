import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../../src/app.js'
import { createAppDeps } from '../../src/deps.js'
import { parseEnv } from '../../src/env.js'

const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSJ9fQ=='

export type StartTestServerOptions = {
  headers?: Record<string, string>
}

export async function startTestServer(
  options: StartTestServerOptions = {},
): Promise<{ client: Client; url: URL; close: () => Promise<void> }> {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP transport tests')
  const env = parseEnv({
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    REQUIRE_AUTH: 'false',
    DEEPCRM_API_PUBLIC_URL: 'http://127.0.0.1',
    DEEPCRM_SECRET_KEYRING_B64: keyring,
  })
  const deps = createAppDeps(env)
  const app = buildApp(deps, env)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP test address')
  const port = address.port
  const url = new URL(`http://127.0.0.1:${port}/mcp`)
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: options.headers },
  })
  const client = new Client({ name: 'deepcrm-test', version: '0.0.0' }, { capabilities: {} })

  try {
    await client.connect(transport)
  } catch (error) {
    await app.close()
    await deps.db.$disconnect()
    throw error
  }

  return {
    client,
    url,
    close: async () => {
      await client.close()
      await app.close()
      await deps.db.$disconnect()
    },
  }
}
