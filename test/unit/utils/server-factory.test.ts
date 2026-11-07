import { describe, it, expect, vi, beforeEach } from "vitest"
import packageJson from "../../../package.json"

const constructed: Array<{ info: unknown; init: any }> = []

// Mock the SDK McpServer: a plain class records its constructor arguments.
vi.mock("@modelcontextprotocol/server", () => ({
  McpServer: class {
    info: unknown
    init: unknown
    constructor(info: unknown, init: unknown) {
      this.info = info
      this.init = init
      constructed.push({ info, init })
    }
  },
}))

const { createMCPServer } = await import("../../../src/utils/server-factory")

describe("createMCPServer", () => {
  beforeEach(() => {
    constructed.length = 0
  })

  it("should create a server with default configuration", () => {
    createMCPServer()

    expect(constructed).toHaveLength(1)
    expect(constructed[0].info).toEqual({
      name: packageJson.name,
      version: packageJson.version,
    })
    // Capabilities are flags; the lists come from the request handlers.
    expect(constructed[0].init.capabilities).toEqual({ tools: {}, prompts: {}, resources: {} })
  })

  it("should create a server with custom configuration", () => {
    createMCPServer({
      name: "CustomServer",
      version: "2.0.0",
      capabilities: { tools: { listChanged: false } },
    })

    expect(constructed[0].info).toEqual({ name: "CustomServer", version: "2.0.0" })
    expect(constructed[0].init.capabilities).toEqual({
      tools: { listChanged: false },
      prompts: {},
      resources: {},
    })
  })

  it("should merge custom capabilities with default capabilities", () => {
    createMCPServer({ capabilities: { extra: "capability" } as any })

    expect(constructed[0].init.capabilities).toEqual({
      tools: {},
      prompts: {},
      resources: {},
      extra: "capability",
    })
  })
})
