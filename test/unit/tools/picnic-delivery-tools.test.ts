import PicnicClient from "picnic-api"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  initializePicnicClient: vi.fn(),
  getDeliveryRoute: vi.fn(),
  getOrderStatus: vi.fn(),
  getDeliverySlots: vi.fn(),
  getDeliverySummaries: vi.fn(),
  getDelivery: vi.fn(),
  getDeliveryPosition: vi.fn(),
  sendRequest: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    sendRequest: mocks.sendRequest,
    delivery: {
      getDeliveryPosition: mocks.getDeliveryPosition,
      getDeliveryRoute: mocks.getDeliveryRoute,
      getDeliverySummaries: mocks.getDeliverySummaries,
      getDelivery: mocks.getDelivery,
    },
    checkout: { getOrderStatus: mocks.getOrderStatus },
    cart: { getDeliverySlots: mocks.getDeliverySlots },
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

  describe("picnic_get_delivery_slots", () => {
    function slot(id: string, start: string, overrides: Record<string, unknown> = {}) {
      return {
        slotId: id,
        windowStart: start,
        windowEnd: start.replace("T15:00", "T17:30"),
        cutOffTime: "2026-11-08T23:00:00.000+01:00",
        isAvailable: true,
        isSelected: false,
        isGreenChoice: false,
        minimumOrderValue: 4500,
        ...overrides,
      }
    }

    beforeEach(() => {
      mocks.getDeliverySlots.mockResolvedValue({
        slots: [
          slot("a", "2026-11-07T15:00:00.000+01:00", { isAvailable: false }),
          slot("b", "2026-11-09T15:00:00.000+01:00", { isSelected: true, isGreenChoice: true }),
          slot("c", "2026-11-09T19:00:00.000+01:00", { isAvailable: false }),
          slot("d", "2026-11-10T15:00:00.000+01:00", { minimumOrderValue: null }),
        ],
        selectedSlot: {
          slotId: "b",
          state: "EXPLICIT",
          windowStart: "2026-11-09T15:00:00.000+01:00",
          windowEnd: "2026-11-09T17:30:00.000+01:00",
          isExplicitSelection: true,
        },
      })
    })

    it("returns only bookable slots by default, compactly", async () => {
      const toolRegistry = await loadTools()
      const payload = parseToolResult(
        await toolRegistry.executeTool("picnic_get_delivery_slots", {}),
      )

      expect(payload.slots).toEqual([
        {
          slot_id: "b",
          window_start: "2026-11-09T15:00:00.000+01:00",
          window_end: "2026-11-09T17:30:00.000+01:00",
          order_deadline: "2026-11-08T23:00:00.000+01:00",
          available: true,
          selected: true,
          green_choice: true,
          minimum_order_value: 4500,
        },
        {
          slot_id: "d",
          window_start: "2026-11-10T15:00:00.000+01:00",
          window_end: "2026-11-10T17:30:00.000+01:00",
          order_deadline: "2026-11-08T23:00:00.000+01:00",
          available: true,
        },
      ])
      expect(payload).toMatchObject({
        filters: { available_only: true },
        selected_slot: { slot_id: "b", explicitly_selected: true },
        total: 2,
        total_unfiltered: 4,
      })
    })

    it("filters by local date and can include unavailable slots", async () => {
      const toolRegistry = await loadTools()
      const payload = parseToolResult(
        await toolRegistry.executeTool("picnic_get_delivery_slots", {
          date: "2026-11-09",
          available_only: false,
        }),
      )

      expect(payload.slots.map((s: { slot_id: string }) => s.slot_id)).toEqual(["b", "c"])
      expect(payload.slots[1].available).toBe(false)
    })

    it("rejects a malformed date", async () => {
      const toolRegistry = await loadTools()
      await expect(
        toolRegistry.executeTool("picnic_get_delivery_slots", { date: "9.11.2026" }),
      ).rejects.toThrow()
    })
  })

  it("leaves Picnic's always-zero item count out of the delivery list", async () => {
    mocks.getDeliverySummaries.mockResolvedValue([
      {
        id: "d1",
        status: "COMPLETED",
        creationTime: "2026-10-26T18:15:12.539+01:00",
        windowStart: "2026-10-29T19:00:00.000+01:00",
        windowEnd: "2026-10-29T22:00:00.000+01:00",
        orderCount: 3,
        totalPrice: 6876,
        itemCount: 0,
      },
    ])
    const toolRegistry = await loadTools()

    const payload = parseToolResult(await toolRegistry.executeTool("picnic_get_deliveries", {}))

    expect(payload.deliveries).toEqual([
      {
        id: "d1",
        status: "COMPLETED",
        creationTime: "2026-10-26T18:15:12.539+01:00",
        windowStart: "2026-10-29T19:00:00.000+01:00",
        windowEnd: "2026-10-29T22:00:00.000+01:00",
        orderCount: 3,
        totalPrice: 6876,
      },
    ])
  })

  it("returns delivery details compactly, with order lines like the cart", async () => {
    mocks.getDelivery.mockResolvedValue({
      id: "d1",
      status: "COMPLETED",
      creationTime: "2026-10-26T18:15:12.539+01:00",
      windowStart: "2026-10-29T19:00:00.000+01:00",
      windowEnd: "2026-10-29T22:00:00.000+01:00",
      orders: [
        {
          id: "705-428-1639",
          status: "COMPLETED",
          creationTime: "2026-10-26T18:15:12.545+01:00",
          items: [
            {
              id: "611",
              productId: "s1027415",
              name: "Petersilie glatt",
              unitQuantity: "40g",
              imageId: "img-p",
              quantity: 1,
              maxCount: 99,
              displayPrice: 96,
              originalPrice: 129,
              priceColor: null,
              priceRanges: null,
              labels: [{ text: "25% Rabatt", textColor: "#FFFFFF", backgroundColor: "#295813" }],
              basePrice: null,
              freshness: null,
              characteristics: [],
              isUnavailable: false,
              unavailableReason: null,
              replacements: [],
              bundlesLink: null,
              recipeId: null,
            },
          ],
          totalPrice: 96,
          checkoutTotalPrice: 135,
          promotionSavings: 33,
          membershipSavings: 0,
          deposits: [],
          depositTotal: 39,
          fees: [],
          cancellable: false,
          payment: { paymentType: "APPLE_PAY", redactedIban: null, bankId: null },
        },
      ],
      returnedContainers: [{ type: "CRATE", name: "Kisten", quantity: 2, price: 300 }],
      totalPrice: 135,
      totalCount: 1,
      discount: 33,
      promotionSavings: 33,
      membershipSavings: 0,
      deposits: [],
      depositTotal: 39,
      fees: [],
      cancellable: false,
    })
    const toolRegistry = await loadTools()

    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_delivery", { deliveryId: "d1" }),
    )

    expect(payload).toEqual({
      id: "d1",
      status: "COMPLETED",
      window_start: "2026-10-29T19:00:00.000+01:00",
      window_end: "2026-10-29T22:00:00.000+01:00",
      total_price: 135,
      total_count: 1,
      total_savings: 33,
      deposit_total: 39,
      returned_containers: [{ name: "Kisten", quantity: 2, refund: 300 }],
      cancellable: false,
      orders: [
        {
          order_id: "705-428-1639",
          status: "COMPLETED",
          created: "2026-10-26T18:15:12.545+01:00",
          items: [
            {
              order_line_id: "611",
              price: 96,
              original_price: 129,
              articles: [
                {
                  product_id: "s1027415",
                  name: "Petersilie glatt",
                  unit: "40g",
                  price: 96,
                  quantity: 1,
                  image_id: "img-p",
                },
              ],
              labels: ["25% Rabatt"],
            },
          ],
          total_price: 135,
          total_savings: 33,
          payment_type: "APPLE_PAY",
        },
      ],
    })
  })
})

describe("narrowed delivery window (eta2)", () => {
  const slotStart = "2026-11-09T15:00:00.000+01:00"
  const slotEnd = "2026-11-09T17:30:00.000+01:00"
  const etaStart = "2026-11-09T15:40:00.000+01:00"
  const etaEnd = "2026-11-09T16:00:00.000+01:00"

  function currentDelivery() {
    return {
      id: "d1",
      status: "CURRENT",
      creationTime: "2026-11-07T18:56:26.416+01:00",
      windowStart: slotStart,
      windowEnd: slotEnd,
      orders: [],
      returnedContainers: [],
      totalPrice: 5174,
      totalCount: 25,
      discount: 0,
      promotionSavings: 0,
      membershipSavings: 0,
      deposits: [],
      depositTotal: 0,
      fees: [],
      cancellable: false,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.initializePicnicClient.mockResolvedValue(undefined)
  })

  it("adds the window from the raw delivery's eta2 to picnic_get_delivery", async () => {
    mocks.getDelivery.mockResolvedValue(currentDelivery())
    mocks.sendRequest.mockResolvedValue({ eta2: { start: etaStart, end: etaEnd } })
    const toolRegistry = await loadTools()

    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_delivery", { deliveryId: "d1" }),
    )

    expect(mocks.sendRequest).toHaveBeenCalledWith("GET", "/deliveries/d1")
    expect(payload).toMatchObject({
      window_start: slotStart,
      window_end: slotEnd,
      eta_window_start: etaStart,
      eta_window_end: etaEnd,
    })
  })

  it("still returns the delivery when the raw request fails or has no eta2", async () => {
    mocks.getDelivery.mockResolvedValue(currentDelivery())
    mocks.sendRequest.mockRejectedValueOnce(new Error("boom"))
    const toolRegistry = await loadTools()

    const failed = parseToolResult(
      await toolRegistry.executeTool("picnic_get_delivery", { deliveryId: "d1" }),
    )
    expect(failed.id).toBe("d1")
    expect(failed).not.toHaveProperty("eta_window_start")

    mocks.sendRequest.mockResolvedValueOnce({ eta2: null })
    const missing = parseToolResult(
      await toolRegistry.executeTool("picnic_get_delivery", { deliveryId: "d1" }),
    )
    expect(missing).not.toHaveProperty("eta_window_start")
  })

  it("adds the window to current deliveries in picnic_get_deliveries only", async () => {
    mocks.getDeliverySummaries.mockResolvedValue([
      {
        id: "d1",
        status: "CURRENT",
        creationTime: "2026-11-07T18:56:26.416+01:00",
        windowStart: slotStart,
        windowEnd: slotEnd,
        orderCount: 3,
        totalPrice: 5174,
        itemCount: 0,
      },
      {
        id: "d0",
        status: "COMPLETED",
        creationTime: "2026-10-26T18:15:12.539+01:00",
        windowStart: "2026-10-29T19:00:00.000+01:00",
        windowEnd: "2026-10-29T22:00:00.000+01:00",
        orderCount: 3,
        totalPrice: 6876,
        itemCount: 0,
      },
    ])
    mocks.sendRequest.mockResolvedValue([
      { delivery_id: "d1", eta2: { start: etaStart, end: etaEnd } },
      { delivery_id: "d0", eta2: { start: "x", end: "y" } },
    ])
    const toolRegistry = await loadTools()

    const payload = parseToolResult(await toolRegistry.executeTool("picnic_get_deliveries", {}))

    expect(mocks.sendRequest).toHaveBeenCalledWith("POST", "/deliveries/summary", [])
    expect(payload.deliveries[0]).toMatchObject({ etaWindowStart: etaStart, etaWindowEnd: etaEnd })
    expect(payload.deliveries[1]).not.toHaveProperty("etaWindowStart")
  })

  it("skips the extra request when no delivery on the page is current", async () => {
    mocks.getDeliverySummaries.mockResolvedValue([
      {
        id: "d0",
        status: "COMPLETED",
        creationTime: "2026-10-26T18:15:12.539+01:00",
        windowStart: null,
        windowEnd: null,
        orderCount: 1,
        totalPrice: 100,
        itemCount: 0,
      },
    ])
    const toolRegistry = await loadTools()

    await toolRegistry.executeTool("picnic_get_deliveries", {})

    expect(mocks.sendRequest).not.toHaveBeenCalled()
  })

  it("explains a missing live position instead of failing on Picnic's empty answer", async () => {
    mocks.getDeliveryPosition.mockRejectedValue(new SyntaxError("Unexpected end of JSON input"))
    const toolRegistry = await loadTools()

    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_delivery_position", { deliveryId: "d1" }),
    )

    expect(payload).toMatchObject({ inProgress: false })
    expect(payload.message).toMatch(/picnic_get_delivery/)
  })

  it("passes on other position errors", async () => {
    mocks.getDeliveryPosition.mockRejectedValue(new Error("network down"))
    const toolRegistry = await loadTools()

    await expect(
      toolRegistry.executeTool("picnic_get_delivery_position", { deliveryId: "d1" }),
    ).rejects.toThrow(/network down/)
  })
})

describe("picnic_get_delivery with wallet refunds", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.initializePicnicClient.mockResolvedValue(undefined)
  })

  it("marks products the wallet refunded for this delivery as not delivered", async () => {
    const windowStart = "2026-11-09T15:00:00.000+01:00"
    mocks.getDelivery.mockResolvedValue({
      id: "d1",
      status: "COMPLETED",
      windowStart,
      windowEnd: "2026-11-09T17:30:00.000+01:00",
      totalPrice: 670,
      totalCount: 2,
      returnedContainers: [],
      cancellable: false,
      orders: [
        {
          id: "o1",
          status: "COMPLETED",
          creationTime: "2026-11-07T18:56:26.422+01:00",
          checkoutTotalPrice: 670,
          items: [
            { id: "656_657", productId: "s2", name: "Caramelle", displayPrice: 670, quantity: 2 },
          ],
        },
      ],
    })
    const paid = Date.parse(windowStart)
    mocks.sendRequest.mockImplementation(async (method: string, path: string) => {
      if (path === "/deliveries/d1") return { orders: [] }
      if (method === "POST" && path === "/wallet/transactions") {
        return [
          { id: "t1", timestamp: paid },
          { id: "t2", timestamp: paid },
          { id: "old", timestamp: paid - 30 * 24 * 60 * 60 * 1000 },
        ]
      }
      if (path === "/wallet/transactions/t1") {
        return {
          delivery_id: "d1",
          shop_items: [{ items: [{ id: "13501890", name: "Caramelle" }] }],
          article_issue_refunds: [
            { article_id: "13501890", quantity: 2, amount: 670, reason: "PRODUCT_NOT_SHIPPED" },
          ],
        }
      }
      if (path === "/wallet/transactions/t2") return { delivery_id: "other" }
      throw new Error(`unexpected ${method} ${path}`)
    })
    const toolRegistry = await loadTools()

    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_delivery", { deliveryId: "d1" }),
    )

    expect(payload.not_delivered).toEqual([
      {
        order_id: "o1",
        name: "Caramelle",
        reasons: ["PRODUCT_NOT_SHIPPED"],
        failed_count: 2,
        refund: 670,
      },
    ])
    expect(mocks.sendRequest).not.toHaveBeenCalledWith("GET", "/wallet/transactions/old")
  })
})
