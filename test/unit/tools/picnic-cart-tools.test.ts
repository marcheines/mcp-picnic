import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  addProductToCart: vi.fn(),
  removeProductFromCart: vi.fn(),
  clearCart: vi.fn(),
  getCart: vi.fn(),
  initializePicnicClient: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    cart: {
      addProductToCart: mocks.addProductToCart,
      removeProductFromCart: mocks.removeProductFromCart,
      clearCart: mocks.clearCart,
      getCart: mocks.getCart,
    },
    sendRequest: vi.fn(),
  }),
  initializePicnicClient: mocks.initializePicnicClient,
  saveSession: vi.fn(),
  verifyPicnic2FACode: vi.fn(),
}))

function parseToolResult(result: ToolResult) {
  return JSON.parse(result.content[0].text ?? "")
}

/** A cart line as picnic-api 5 returns it (CartLineItem). */
function cartLine(overrides: Record<string, unknown> = {}) {
  return {
    id: "1871",
    productId: "s1032332",
    name: "Frosch Cremeseife",
    unitQuantity: "500ml",
    imageId: "img-1",
    quantity: 1,
    maxCount: 50,
    displayPrice: 255,
    originalPrice: null,
    priceColor: null,
    priceRanges: null,
    labels: [],
    basePrice: "€5,10/l",
    freshness: null,
    characteristics: [],
    isUnavailable: false,
    unavailableReason: null,
    replacements: [],
    bundlesLink: null,
    recipeId: null,
    ...overrides,
  }
}

/** A cart as picnic-api 5 returns it (Cart). */
function v5Cart(overrides: Record<string, unknown> = {}) {
  return {
    id: "shopping_cart",
    mts: 1,
    items: [],
    totalCount: 0,
    totalPrice: 0,
    discount: 0,
    promotionSavings: 0,
    membershipSavings: 0,
    deposits: [],
    depositTotal: 0,
    fees: [],
    minimumOrderValue: null,
    selectedSlot: null,
    recipes: [],
    ...overrides,
  }
}

const emptyCart = v5Cart({ id: "cart-1" })

describe("picnic cart tools", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await import("../../../src/tools/picnic-tools.js")
  })

  describe("mutation failures", () => {
    // Picnic applies the write and renders the cart in one request, so a failure does not
    // mean the write was rejected. The error has to say so, or the caller retries and
    // double-applies the change.
    it("warns that the cart may have changed when add_to_cart fails", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      mocks.addProductToCart.mockRejectedValue(
        new Error("Client version is required to preview the cart page"),
      )

      await expect(
        toolRegistry.executeTool("picnic_add_to_cart", { productId: "s1032332", count: 1 }),
      ).rejects.toThrow(/cart may still have been modified/i)
    })

    it("points the caller at picnic_get_cart rather than a retry", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      mocks.removeProductFromCart.mockRejectedValue(new Error("boom"))

      await expect(
        toolRegistry.executeTool("picnic_remove_from_cart", { productId: "s1", count: 1 }),
      ).rejects.toThrow(/picnic_get_cart/)
    })

    it("preserves the upstream error message", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      mocks.clearCart.mockRejectedValue(new Error("upstream detail"))

      await expect(toolRegistry.executeTool("picnic_clear_cart", {})).rejects.toThrow(
        /upstream detail/,
      )
    })
  })

  describe("successful mutations", () => {
    it("returns the filtered cart on success", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      mocks.addProductToCart.mockResolvedValue(emptyCart)

      const result = await toolRegistry.executeTool("picnic_add_to_cart", {
        productId: "s1032332",
        count: 2,
      })

      expect(mocks.addProductToCart).toHaveBeenCalledWith("s1032332", 2)
      expect(parseToolResult(result).message).toBe("Added 2 item(s) to cart")
    })

    it("does not retry the mutation itself", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      mocks.addProductToCart.mockRejectedValue(new Error("nope"))

      await expect(
        toolRegistry.executeTool("picnic_add_to_cart", { productId: "s1", count: 1 }),
      ).rejects.toThrow()
      expect(mocks.addProductToCart).toHaveBeenCalledTimes(1)
    })
  })

  describe("annotations", () => {
    it("marks cart mutations as non-idempotent and destructive", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      const list = toolRegistry.getToolsList() as Array<{
        name: string
        annotations?: Record<string, boolean>
      }>

      for (const name of [
        "picnic_add_to_cart",
        "picnic_remove_from_cart",
        "picnic_clear_cart",
        "picnic_add_recipe_to_cart",
        "picnic_remove_recipe_from_cart",
      ]) {
        const tool = list.find((t) => t.name === name)
        expect(tool, `${name} should be registered`).toBeDefined()
        expect(tool?.annotations, `${name} should carry annotations`).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
        })
      }
    })

    it("leaves read-only tools unannotated", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      const list = toolRegistry.getToolsList() as Array<{
        name: string
        annotations?: Record<string, boolean>
      }>

      expect(list.find((t) => t.name === "picnic_get_cart")?.annotations).toBeUndefined()
    })
  })
})

describe("picnic_get_cart quantities", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await import("../../../src/tools/picnic-tools.js")
  })

  // Without the quantity the caller cannot verify whether an ambiguous add landed once or twice,
  // which is exactly what the mutation error message tells it to go and check.
  it("maps picnic-api 5 cart lines to articles with name, quantity and prices", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    mocks.getCart.mockResolvedValue(
      v5Cart({
        totalCount: 3,
        totalPrice: 1089,
        promotionSavings: 50,
        minimumOrderValue: 3500,
        items: [
          cartLine({ quantity: 2, displayPrice: 510 }),
          cartLine({
            id: "1872",
            productId: "s1022214",
            name: "Hähnchenbrustfilet",
            unitQuantity: "600g",
            imageId: null,
            displayPrice: 579,
            originalPrice: 679,
            labels: [{ text: "Angebot", textColor: null, backgroundColor: null }],
            recipeId: "0123456789abcdef0123456789abcdef",
          }),
        ],
        selectedSlot: {
          slotId: "slot-1",
          state: "EXPLICIT",
          windowStart: "2026-11-07T16:00:00+01:00",
          windowEnd: "2026-11-07T18:00:00+01:00",
          isExplicitSelection: true,
        },
        recipes: [
          {
            id: "0123456789abcdef0123456789abcdef",
            title: "Hähnchen-Wraps",
            preTitle: "3 Portionen",
            subtitle: null,
            imageId: null,
          },
        ],
      }),
    )

    const cart = parseToolResult(await toolRegistry.executeTool("picnic_get_cart", {}))

    expect(cart.items).toEqual([
      {
        order_line_id: "1871",
        price: 510,
        articles: [
          {
            product_id: "s1032332",
            name: "Frosch Cremeseife",
            unit: "500ml",
            price: 255,
            quantity: 2,
            image_id: "img-1",
          },
        ],
      },
      {
        order_line_id: "1872",
        price: 579,
        original_price: 679,
        articles: [
          {
            product_id: "s1022214",
            name: "Hähnchenbrustfilet",
            unit: "600g",
            price: 579,
            quantity: 1,
          },
        ],
        labels: ["Angebot"],
        recipe_id: "0123456789abcdef0123456789abcdef",
      },
    ])
    expect(cart).toMatchObject({
      id: "shopping_cart",
      total_count: 3,
      total_price: 1089,
      total_savings: 50,
      minimum_order_value: 3500,
      selected_slot: { slot_id: "slot-1", explicitly_selected: true },
      recipes: [
        {
          recipe_id: "0123456789abcdef0123456789abcdef",
          title: "Hähnchen-Wraps",
          portions: "3 Portionen",
        },
      ],
    })
  })

  it("counts a product per line when it is in the cart twice (alone and for a recipe)", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    // As Picnic returns it: both lines report the product's total count of 2.
    mocks.getCart.mockResolvedValue(
      v5Cart({
        totalCount: 4,
        items: [
          cartLine({ id: "623", productId: "s1019780", quantity: 2, displayPrice: 259 }),
          cartLine({
            id: "647",
            productId: "s1019780",
            quantity: 2,
            displayPrice: 259,
            recipeId: "c771ae44030c40d7ac1206f6fcd13d9f",
          }),
          cartLine({ id: "643_644", productId: "s1022721", quantity: 2, displayPrice: 1558 }),
        ],
      }),
    )

    const cart = parseToolResult(await toolRegistry.executeTool("picnic_get_cart", {}))
    const articles = cart.items.map((item: { articles: unknown[] }) => item.articles[0])

    expect(articles[0]).toMatchObject({ product_id: "s1019780", quantity: 1, price: 259 })
    expect(articles[1]).toMatchObject({ product_id: "s1019780", quantity: 1, price: 259 })
    // a product in a single line keeps Picnic's quantity
    expect(articles[2]).toMatchObject({ product_id: "s1022721", quantity: 2, price: 779 })
  })

  it("flags unavailable products", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    mocks.getCart.mockResolvedValue(
      v5Cart({
        totalCount: 1,
        items: [cartLine({ isUnavailable: true, unavailableReason: "Ausverkauft" })],
      }),
    )

    const cart = parseToolResult(await toolRegistry.executeTool("picnic_get_cart", {}))
    expect(cart.items[0]).toMatchObject({ unavailable: true, unavailable_reason: "Ausverkauft" })
  })

  it("returns the mapped cart from add_to_cart and remove_from_cart", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    const cart = v5Cart({ totalCount: 1, totalPrice: 255, items: [cartLine()] })
    mocks.addProductToCart.mockResolvedValue(cart)
    mocks.removeProductFromCart.mockResolvedValue(cart)

    const added = parseToolResult(
      await toolRegistry.executeTool("picnic_add_to_cart", { productId: "s1032332", count: 1 }),
    )
    const removed = parseToolResult(
      await toolRegistry.executeTool("picnic_remove_from_cart", { productId: "s1", count: 1 }),
    )

    for (const result of [added, removed]) {
      expect(result.cart.items[0].articles[0]).toMatchObject({
        product_id: "s1032332",
        name: "Frosch Cremeseife",
        quantity: 1,
        price: 255,
      })
      expect(result.cart.total_price).toBe(255)
    }
  })
})
