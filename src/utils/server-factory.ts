import { McpServer } from "@modelcontextprotocol/server"
import packageJson from "../../package.json"

export interface ServerConfig {
  name?: string
  version?: string
  capabilities?: {
    tools?: Record<string, unknown>
    prompts?: Record<string, unknown>
    resources?: Record<string, unknown>
  }
}

export function createMCPServer(config: ServerConfig = {}): McpServer {
  const defaultConfig = {
    name: packageJson.name,
    version: packageJson.version,
    // Capabilities are flags, not definitions; the lists are served by the request handlers.
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
  }

  const finalConfig = {
    name: config.name || defaultConfig.name,
    version: config.version || defaultConfig.version,
    capabilities: {
      ...defaultConfig.capabilities,
      ...config.capabilities,
    },
  }

  return new McpServer(
    {
      name: finalConfig.name,
      version: finalConfig.version,
    },
    {
      capabilities: finalConfig.capabilities,
    },
  )
}
