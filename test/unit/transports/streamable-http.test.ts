import http from "http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  StreamableHttpServer,
  StreamableHttpServerOptions,
} from "../../../src/transports/streamable-http"
import { createMCPServer } from "../../../src/utils/server-factory"

// Mock dependencies
vi.mock("../../../src/utils/server-factory")
vi.mock("crypto", () => ({
  timingSafeEqual: vi.fn((a: Buffer, b: Buffer) => Buffer.compare(a, b) === 0),
}))

const transportOptions: unknown[] = []
const seenHeaders: Array<{ headers: Record<string, unknown>; rawHeaders: string[] }> = []

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  // A plain class: vi.restoreAllMocks() in afterEach would strip a vi.fn() implementation.
  StreamableHTTPServerTransport: class {
    constructor(options: unknown) {
      transportOptions.push(options)
    }
    async close() {}
    async handleRequest(
      req: { headers: Record<string, unknown>; rawHeaders: string[] },
      res: { status: (n: number) => any },
    ) {
      seenHeaders.push({ headers: { ...req.headers }, rawHeaders: [...req.rawHeaders] })
      res.status(200).json({ jsonrpc: "2.0", id: 1, result: {} })
    }
  },
}))

describe("StreamableHttpServer", () => {
  let server: StreamableHttpServer
  const mockCreateMCPServer = vi.mocked(createMCPServer)
  const mockUnderlyingServer = {
    setRequestHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  }
  const mockSDKServer = {
    server: mockUnderlyingServer,
    connect: vi.fn().mockResolvedValue(undefined),
    handleRequest: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateMCPServer.mockReturnValue(mockSDKServer as any)
    mockSDKServer.connect.mockResolvedValue(undefined)
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (server) {
      try {
        await server.stop()
      } catch (error) {
        // Ignore errors during test cleanup
      }
    }
  })

  it("should create a server with default options", () => {
    server = new StreamableHttpServer()
    // @ts-expect-error - private property access
    expect(server.port).toBe(3000)
    // @ts-expect-error - private property access
    expect(server.host).toBe("localhost")
  })

  it("should create a server with custom options", () => {
    const options: StreamableHttpServerOptions = {
      port: 4000,
      host: "0.0.0.0",
      enableRequestLogging: true,
      rateLimitConfig: { windowMs: 1000, maxRequests: 10 },
    }
    server = new StreamableHttpServer(options)
    // @ts-expect-error - private property access
    expect(server.port).toBe(4000)
    // @ts-expect-error - private property access
    expect(server.host).toBe("0.0.0.0")
    // @ts-expect-error - private property access
    expect(server.rateLimiter).toBeDefined()
  })

  it("should start and stop the server", async () => {
    server = new StreamableHttpServer()
    const listenSpy = vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (
      this: any,
      _port: any,
      callback: any,
    ) {
      if (typeof callback === "function") {
        callback()
      }
      return this
    })
    const closeSpy = vi.spyOn(http.Server.prototype, "close").mockImplementation(function (
      this: any,
      callback?: any,
    ) {
      if (typeof callback === "function") {
        callback()
      }
      return this
    })

    await server.start()
    // @ts-expect-error - private property access
    expect(server.server).toBeInstanceOf(http.Server)
    expect(listenSpy).toHaveBeenCalledWith(3000, expect.any(Function))

    await server.stop()
    expect(closeSpy).toHaveBeenCalled()
  })

  it("should provide a health check", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({ port: 0, enableRequestLogging: false })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const res = await new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: address.port, path: "/health", method: "GET" },
        (response) => {
          let data = ""
          response.on("data", (chunk: string) => (data += chunk))
          response.on("end", () => {
            resolve({ statusCode: response.statusCode!, body: JSON.parse(data) })
          })
        },
      )
      req.on("error", reject)
      req.end()
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(
      expect.objectContaining({ status: "ok", mode: "stateless", activeRequests: 0 }),
    )
  })

  it("should setup routes", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({ port: 0, enableRequestLogging: false })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const res = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/mcp",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (response) => {
          let data = ""
          response.on("data", (chunk: string) => (data += chunk))
          response.on("end", () => {
            resolve({ statusCode: response.statusCode! })
          })
        },
      )
      req.on("error", reject)
      req.write("{}")
      req.end()
    })

    // We get a response (not 404), meaning the /mcp route exists
    expect(res.statusCode).not.toBe(404)
  })

  it("should require authentication when authToken is configured", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({ port: 0, enableRequestLogging: false, authToken: "secret" })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const res = await new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: address.port, path: "/mcp", method: "GET" },
        (response) => {
          let data = ""
          response.on("data", (chunk: string) => (data += chunk))
          response.on("end", () => {
            resolve({ statusCode: response.statusCode!, body: JSON.parse(data) })
          })
        },
      )
      req.on("error", reject)
      req.end()
    })

    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual(
      expect.objectContaining({
        error: "Unauthorized",
      }),
    )
  })

  it("should require auth for /mcp POST when authToken is configured", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({ port: 0, enableRequestLogging: false, authToken: "secret" })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const mcpRes = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/mcp",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (response) => {
          response.on("data", () => {})
          response.on("end", () => {
            resolve({ statusCode: response.statusCode! })
          })
        },
      )
      req.on("error", reject)
      req.write("{}")
      req.end()
    })

    const healthRes = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: address.port, path: "/health", method: "GET" },
        (response) => {
          response.on("data", () => {})
          response.on("end", () => {
            resolve({ statusCode: response.statusCode! })
          })
        },
      )
      req.on("error", reject)
      req.end()
    })

    expect(mcpRes.statusCode).toBe(401)
    expect(healthRes.statusCode).toBe(200)
  })

  it("should reject wrong auth header token", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({
      port: 0,
      enableRequestLogging: false,
      authToken: "secret",
      authHeaderName: "x-api-token",
    })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const sessionsRes = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/mcp",
          method: "GET",
          headers: { "x-api-token": "wrong" },
        },
        (response) => {
          response.on("data", () => {})
          response.on("end", () => {
            resolve({ statusCode: response.statusCode! })
          })
        },
      )
      req.on("error", reject)
      req.end()
    })

    expect(sessionsRes.statusCode).toBe(401)
  })

  it("should allow custom header token authentication", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({
      port: 0,
      enableRequestLogging: false,
      authToken: "secret",
      authHeaderName: "x-api-token",
    })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const sessionsRes = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/mcp",
          method: "GET",
          headers: { "x-api-token": "secret" },
        },
        (response) => {
          response.on("data", () => {})
          response.on("end", () => {
            resolve({ statusCode: response.statusCode! })
          })
        },
      )
      req.on("error", reject)
      req.end()
    })

    expect(sessionsRes.statusCode).toBe(405)
  })

  it("should allow authorization bearer token authentication", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({ port: 0, enableRequestLogging: false, authToken: "secret" })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const sessionsRes = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/mcp",
          method: "GET",
          headers: { Authorization: "Bearer secret" },
        },
        (response) => {
          response.on("data", () => {})
          response.on("end", () => {
            resolve({ statusCode: response.statusCode! })
          })
        },
      )
      req.on("error", reject)
      req.end()
    })

    expect(sessionsRes.statusCode).toBe(405)
  })

  describe("stateless MCP endpoint", () => {
    async function request(
      method: string,
      headers: Record<string, string>,
      body?: string,
    ): Promise<{ statusCode: number; body: any }> {
      // @ts-expect-error - private property access
      const httpServer = server.server as http.Server
      const address = httpServer.address() as { port: number }
      return new Promise((resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port: address.port, path: "/mcp", method, headers },
          (response) => {
            let data = ""
            response.on("data", (chunk) => (data += chunk))
            response.on("end", () =>
              resolve({ statusCode: response.statusCode!, body: data ? JSON.parse(data) : null }),
            )
          },
        )
        req.on("error", reject)
        if (body) req.write(body)
        req.end()
      })
    }

    const toolsList = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })

    beforeEach(async () => {
      vi.useRealTimers()
      transportOptions.length = 0
      seenHeaders.length = 0
      server = new StreamableHttpServer({ port: 0, enableRequestLogging: false })
      await server.start()
    })

    it("handles a non-initialize POST without session id", async () => {
      const res = await request("POST", { "Content-Type": "application/json" }, toolsList)

      expect(res.statusCode).toBe(200)
      expect(transportOptions[0]).toEqual({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
    })

    it("handles a POST carrying a stale session id from before a redeploy", async () => {
      const res = await request(
        "POST",
        { "Content-Type": "application/json", "mcp-session-id": "from-old-deployment" },
        toolsList,
      )

      expect(res.statusCode).toBe(200)
    })

    it("uses a fresh transport and server for every request", async () => {
      await request("POST", { "Content-Type": "application/json" }, toolsList)
      await request("POST", { "Content-Type": "application/json" }, toolsList)

      expect(transportOptions).toHaveLength(2)
      expect(mockSDKServer.connect).toHaveBeenCalledTimes(2)
    })

    it("drops an MCP-Protocol-Version header the SDK does not support instead of failing", async () => {
      const res = await request(
        "POST",
        { "Content-Type": "application/json", "MCP-Protocol-Version": "2099-01-01" },
        toolsList,
      )

      expect(res.statusCode).toBe(200)
      expect(seenHeaders[0].headers["mcp-protocol-version"]).toBeUndefined()
      expect(seenHeaders[0].rawHeaders.map((h) => h.toLowerCase())).not.toContain(
        "mcp-protocol-version",
      )
    })

    it("keeps a supported MCP-Protocol-Version header", async () => {
      await request(
        "POST",
        { "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
        toolsList,
      )

      expect(seenHeaders[0].headers["mcp-protocol-version"]).toBe("2025-06-18")
    })

    it.each(["GET", "DELETE"])("answers %s with 405", async (method) => {
      const res = await request(method, {})

      expect(res.statusCode).toBe(405)
      expect(res.body.jsonrpc).toBe("2.0")
    })
  })
})
