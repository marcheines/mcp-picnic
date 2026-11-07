import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const serveCalls: Array<{ factory: () => unknown; options: any }> = []
const handle = { close: vi.fn().mockResolvedValue(undefined) }

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: (factory: () => unknown, options: unknown) => {
    serveCalls.push({ factory, options })
    return handle
  },
}))

const mockServer = {
  server: { setRequestHandler: vi.fn() },
  connect: vi.fn().mockResolvedValue(undefined),
}

vi.mock("../../../src/utils/server-factory.js", () => ({
  createMCPServer: vi.fn(() => mockServer),
}))

const { StdioServer } = await import("../../../src/transports/stdio.js")

const originalConsoleError = console.error

describe("StdioServer", () => {
  beforeEach(() => {
    serveCalls.length = 0
    handle.close.mockClear()
    mockServer.server.setRequestHandler.mockClear()
    console.error = vi.fn()
  })

  afterEach(() => {
    console.error = originalConsoleError
  })

  it("serves stdio through serveStdio with a configured server factory", async () => {
    const server = new StdioServer()
    await server.start()

    expect(serveCalls).toHaveLength(1)
    // The factory builds a server with all request handlers registered.
    expect(serveCalls[0].factory()).toBe(mockServer)
    expect(mockServer.server.setRequestHandler).toHaveBeenCalledWith(
      "tools/call",
      expect.any(Function),
    )
    expect(console.error).toHaveBeenCalledWith("MCP Server Template running on stdio")
  })

  it("logs out-of-band errors", async () => {
    const server = new StdioServer()
    await server.start()

    serveCalls[0].options.onerror(new Error("boom"))
    expect(console.error).toHaveBeenCalledWith("[MCP stdio] boom")
  })

  it("closes the connection on stop and tolerates a second stop", async () => {
    const server = new StdioServer()
    await server.start()
    await server.stop()
    await server.stop()

    expect(handle.close).toHaveBeenCalledTimes(1)
  })

  it("does nothing on stop before start", async () => {
    const server = new StdioServer()
    await server.stop()

    expect(handle.close).not.toHaveBeenCalled()
  })
})
