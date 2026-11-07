import http from "http"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// Real SDK, real server factory; only the Picnic-backed registries are stubbed.
vi.mock("../../../src/tools/index.js", () => ({
  toolRegistry: {
    getToolsList: () => [
      {
        name: "picnic_get_cart",
        description: "Get the cart",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    executeTool: async (name: string) => ({
      content: [{ type: "text", text: `ran ${name}` }],
    }),
  },
}))
vi.mock("../../../src/prompts/index.js", () => ({
  promptRegistry: { getPromptsList: () => [], executePrompt: async () => ({ messages: [] }) },
}))
vi.mock("../../../src/resources/index.js", () => ({
  resourceRegistry: { getResourcesList: () => [], readResource: async () => ({ contents: [] }) },
}))

const { StreamableHttpServer } = await import("../../../src/transports/streamable-http")

const MODERN = "2026-07-28"
const meta = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
}

describe("StreamableHttpServer protocol support", () => {
  let server: InstanceType<typeof StreamableHttpServer>
  let port: number

  beforeAll(async () => {
    server = new StreamableHttpServer({ port: 0, enableRequestLogging: false })
    await server.start()
    // @ts-expect-error - private property access
    port = (server.server.address() as { port: number }).port
  })

  afterAll(async () => {
    await server.stop()
  })

  function post(
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; messages: any[] }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...headers,
          },
        },
        (res) => {
          let data = ""
          res.on("data", (chunk) => (data += chunk))
          res.on("end", () => {
            const messages = /^(event|data):/.test(data)
              ? data
                  .split("\n")
                  .filter((l) => l.startsWith("data:"))
                  .map((l) => JSON.parse(l.slice(5)))
              : data
                ? [JSON.parse(data)]
                : []
            resolve({ status: res.statusCode!, messages })
          })
        },
      )
      req.on("error", reject)
      req.end(JSON.stringify(body))
    })
  }

  const modernHeaders = (method: string, name?: string) => ({
    "MCP-Protocol-Version": MODERN,
    "Mcp-Method": method,
    ...(name ? { "Mcp-Name": name } : {}),
  })

  it("answers the server/discover probe of a 2026-07-28 client", async () => {
    const res = await post(
      {
        jsonrpc: "2.0",
        id: "server-discover-probe-1",
        method: "server/discover",
        params: { _meta: meta },
      },
      modernHeaders("server/discover"),
    )

    expect(res.status).toBe(200)
    expect(res.messages[0].error).toBeUndefined()
    expect(res.messages[0].result.supportedVersions).toContain(MODERN)
    expect(res.messages[0].result.capabilities.tools).toBeDefined()
  })

  it("serves 2026-07-28 tool calls, also in parallel", async () => {
    const calls = Array.from({ length: 5 }, (_, i) =>
      post(
        {
          jsonrpc: "2.0",
          id: i,
          method: "tools/call",
          params: { name: "picnic_get_cart", arguments: {}, _meta: meta },
        },
        modernHeaders("tools/call", "picnic_get_cart"),
      ),
    )
    const results = await Promise.all(calls)

    for (const res of results) {
      expect(res.status).toBe(200)
      expect(res.messages[0].result.content[0].text).toBe("ran picnic_get_cart")
    }
  })

  it("still serves 2025-era clients via initialize", async () => {
    const init = await post({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    })
    expect(init.status).toBe(200)
    expect(init.messages[0].result.protocolVersion).toBe("2025-11-25")

    const list = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "MCP-Protocol-Version": "2025-11-25" },
    )
    expect(list.messages[0].result.tools[0].name).toBe("picnic_get_cart")
  })

  it("logs SDK Uint8Array response bodies as JSON", async () => {
    await server.stop()
    server = new StreamableHttpServer({ port: 0, enableRequestLogging: true })
    await server.start()
    // @ts-expect-error - private property access
    port = (server.server.address() as { port: number }).port
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await post(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "picnic_get_cart", arguments: { secret: "do-not-log" }, _meta: meta },
      },
      modernHeaders("tools/call", "picnic_get_cart"),
    )

    const logged = errorSpy.mock.calls.flat().join("\n")
    errorSpy.mockRestore()
    expect(logged).toContain(
      `[MCP] tools/call(picnic_get_cart) meta=${MODERN} id=9 hdr=${MODERN} -> 200`,
    )
    expect(logged).not.toContain("non-json response")
    expect(logged).not.toContain("do-not-log")
  })
})
