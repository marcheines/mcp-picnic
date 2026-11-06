import PicnicClient from "picnic-api"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  initializePicnicClient: vi.fn(),
  getDeliveryRoute: vi.fn(),
  getOrderStatus: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    sendRequest: vi.fn(),
    delivery: { getDeliveryRoute: mocks.getDeliveryRoute },
    checkout: { getOrderStatus: mocks.getOrderStatus },
  }),
  initializePicnicClient: mocks.initializePicnicClient,
  saveSession: vi.fn(),
  verifyPicnic2FACode: vi.fn(),
}))

function parseToolResult(result: ToolResult) {
  return JSON.parse(result.content[0].text ?? "")
}

async function loadTools() {
  const { toolRegistry } = await import("../../../src/tools/registry.js")
  await import("../../../src/tools/picnic-tools.js")
  return toolRegistry
}

describe("delivery and order tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.initializePicnicClient.mockResolvedValue(undefined)
  })

  it("reads the delivery route through picnic-api's getDeliveryRoute", async () => {
    mocks.getDeliveryRoute.mockResolvedValue({ version: 3, driverName: "Sam", points: [] })
    const toolRegistry = await loadTools()

    const result = await toolRegistry.executeTool("picnic_get_delivery_scenario", {
      deliveryId: "d1",
    })

    expect(mocks.getDeliveryRoute).toHaveBeenCalledWith("d1")
    expect(parseToolResult(result)).toMatchObject({ driverName: "Sam" })
  })

  it("explains a missing route instead of passing on Picnic's 404", async () => {
    mocks.getDeliveryRoute.mockRejectedValue(
      new PicnicClient.PicnicApiError(404, "NOT_FOUND", "DeliveryScenario was not found"),
    )
    const toolRegistry = await loadTools()

    await expect(
      toolRegistry.executeTool("picnic_get_delivery_scenario", { deliveryId: "d1" }),
    ).rejects.toThrow(/only has it while the delivery is on its way/)
  })

  it("reads the order status through picnic-api's checkout service", async () => {
    mocks.getOrderStatus.mockResolvedValue({ checkout_status: "SUCCESS" })
    const toolRegistry = await loadTools()

    const result = await toolRegistry.executeTool("picnic_get_order_status", { orderId: "o1" })

    expect(mocks.getOrderStatus).toHaveBeenCalledWith("o1")
    expect(parseToolResult(result)).toEqual({ checkout_status: "SUCCESS" })
  })
})
