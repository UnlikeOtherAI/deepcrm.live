import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ActorContext } from '@deepcrm/schemas'
import { createAppDeps } from '../deps.js'
import { parseEnv } from '../env.js'
import { buildMcpServer } from './server.js'

const CATALOG_KEYRING = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSIsImV4cG9ydCI6IkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUU9In19'
const CATALOG_NOW = new Date('2026-01-01T00:00:00.000Z')

export type ToolDoc = {
  name: string
  description: string
  inputSchema: Tool['inputSchema']
}

function catalogContext(): ActorContext {
  return {
    tenant: { organizationId: 'catalog-organization', teamId: 'catalog-team' },
    app: 'catalog',
    actChain: [],
    actor: { type: 'agent', id: 'catalog-agent' },
    onBehalfOf: { uoaUserId: 'catalog-user', role: 'owner' },
    provenance: null,
    requestId: 'catalog-request',
    now: CATALOG_NOW,
  }
}

function catalogDeps() {
  const deps = createAppDeps(parseEnv({
    DATABASE_URL: 'postgresql://catalog:catalog@127.0.0.1:1/catalog',
    NODE_ENV: 'test',
    REQUIRE_AUTH: 'false',
    DEEPCRM_API_PUBLIC_URL: 'http://127.0.0.1',
    DEEPCRM_SECRET_KEYRING_B64: CATALOG_KEYRING,
  }))
  deps.clock = () => CATALOG_NOW
  return deps
}

export async function describeTools(): Promise<ToolDoc[]> {
  const deps = catalogDeps()
  const server = buildMcpServer(catalogContext(), deps)
  const client = new Client({ name: 'deepcrm-catalog', version: deps.version }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const result = await client.listTools()
    return result.tools.map((tool) => {
      if (tool.description === undefined || tool.description.trim() === '') {
        throw new Error(`Tool '${tool.name}' has no description`)
      }
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }
    })
  } finally {
    await client.close()
    await server.close()
    await deps.db.$disconnect()
  }
}
