import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { BaseTransportServer } from "./base.js"

/**
 * Configuration options for the stdio server
 */
export interface StdioServerOptions {
  // Add any future configuration options here
}

/**
 * Class to handle stdio server setup using the MCP SDK's serveStdio entry, which serves both
 * 2026-07-28 (server/discover) and 2025-era (initialize) clients from one server factory.
 */
export class StdioServer extends BaseTransportServer {
  private handle?: ReturnType<typeof serveStdio>

  /**
   * Start the stdio server
   *
   * @returns Promise that resolves when the server is started
   */
  public async start(): Promise<void> {
    this.handle = serveStdio(() => this.createConfiguredServer(), {
      onerror: (error: Error) => console.error(`[MCP stdio] ${error.message}`),
    })
    console.error("MCP Server Template running on stdio")
  }

  /**
   * Stop the stdio server
   *
   * @returns Promise that resolves when the server is stopped
   */
  public async stop(): Promise<void> {
    if (this.handle) {
      await this.handle.close()
      this.handle = undefined
    }
  }
}
