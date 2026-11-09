import PicnicClient from "picnic-api"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  initializePicnicClient: vi.fn(),
  getFavorites: vi.fn(),
  getFavoritesInAisle: vi.fn(),
  getCategories: vi.fn(),
  getSubcategories: vi.fn(),
  getCategoryProducts: vi.fn(),
  getCategoryPromotions: vi.fn(),
  getReplacements: vi.fn(),
  getMinimumOrderValue: vi.fn(),
  updateRecipePortionsInCart: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    sendRequest: vi.fn(),
    catalog: {
      getFavorites: mocks.getFavorites,
      getFavoritesInAisle: mocks.getFavoritesInAisle,
      getCategories: mocks.getCategories,
      getSubcategories: mocks.getSubcategories,
      getCategoryProducts: mocks.getCategoryProducts,
      getCategoryPromotions: mocks.getCategoryPromotions,
    },
    cart: {
      getReplacements: mocks.getReplacements,
      getMinimumOrderValue: mocks.getMinimumOrderValue,
    },
    recipe: { updateRecipePortionsInCart: mocks.updateRecipePortionsInCart },
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

function tile(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Produkt ${id}`,
    namePrefix: null,
    brand: null,
    qualityCue: null,
    imageId: `img-${id}`,
    displayPrice: 199,
    originalPrice: null,
    unitPrice: null,
    priceRanges: null,
    unitQuantity: "1 Stück",
    labels: [],
    isUnavailable: false,
    numberOfOrders: 12,
    ...overrides,
  }
}

const RECIPE_ID = "0123456789abcdef01234567"

describe("favorites, categories, replacements and other new tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.initializePicnicClient.mockResolvedValue(undefined)
  })

  it("returns the favorites per aisle compactly", async () => {
    mocks.getFavorites.mockResolvedValue({
      aisles: [
        {
          id: "DAIRY",
          title: "Molkerei",
          complete: false,
          products: [tile("s1", { brand: "Bio" })],
        },
      ],
    })
    const toolRegistry = await loadTools()

    const payload = parseToolResult(await toolRegistry.executeTool("picnic_get_favorites", {}))

    expect(payload).toEqual({
      aisles: [
        {
          aisle_id: "DAIRY",
          title: "Molkerei",
          complete: false,
          products: [
            {
              product_id: "s1",
              name: "Produkt s1",
              brand: "Bio",
              price: 199,
              unit: "1 Stück",
              image_id: "img-s1",
            },
          ],
        },
      ],
    })
  })

  it("lists one aisle's favorites with pagination", async () => {
    mocks.getFavoritesInAisle.mockResolvedValue([tile("s1"), tile("s2"), tile("s3")])
    const toolRegistry = await loadTools()

    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_favorites", { aisle_id: "DAIRY", limit: 2 }),
    )

    expect(mocks.getFavoritesInAisle).toHaveBeenCalledWith("DAIRY")
    expect(payload.products.map((p: { product_id: string }) => p.product_id)).toEqual(["s1", "s2"])
    expect(payload.pagination).toMatchObject({ total: 3, hasMore: true })
  })

  it("returns the category tree without app pages", async () => {
    mocks.getCategories.mockResolvedValue([
      {
        title: "Alle Kategorien",
        links: [
          {
            name: "Obst",
            imageId: null,
            label: "200+ Produkte",
            deeplink: "x",
            target: { type: "subcategories", categoryId: "c1" },
          },
          { name: "Info", imageId: null, label: null, deeplink: "y", target: { type: "page" } },
        ],
      },
    ])
    const toolRegistry = await loadTools()

    const payload = parseToolResult(await toolRegistry.executeTool("picnic_get_categories", {}))

    expect(payload).toEqual({
      sections: [
        {
          title: "Alle Kategorien",
          categories: [
            { name: "Obst", label: "200+ Produkte", opens: "subcategories", category_id: "c1" },
          ],
        },
      ],
    })
  })

  it("returns subcategories for a category id", async () => {
    mocks.getSubcategories.mockResolvedValue({
      categoryId: "c1",
      title: "Obst",
      links: [
        {
          name: "Äpfel",
          imageId: null,
          label: null,
          deeplink: "z",
          target: { type: "products", categoryId: "c2" },
        },
      ],
    })
    const toolRegistry = await loadTools()

    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_categories", { category_id: "c1" }),
    )

    expect(payload).toEqual({
      category_id: "c1",
      title: "Obst",
      categories: [{ name: "Äpfel", opens: "products", category_id: "c2" }],
    })
  })

  it("lists category products once each, with their section", async () => {
    mocks.getCategoryProducts.mockResolvedValue({
      categoryId: "c2",
      title: "Äpfel",
      results: {
        sections: [
          { id: "a", type: "RFY", title: "Wieder kaufen", products: [tile("s1")] },
          { id: "b", type: "VISUAL", title: "Rote Äpfel", products: [tile("s1"), tile("s2")] },
        ],
        visualFilters: [],
        powerFilters: [],
        textualFilters: [],
      },
    })
    const toolRegistry = await loadTools()

    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_category_products", { category_id: "c2" }),
    )

    expect(payload.products).toMatchObject([
      { product_id: "s1", section: "Wieder kaufen" },
      { product_id: "s2", section: "Rote Äpfel" },
    ])
    expect(payload.pagination.total).toBe(2)
    expect(mocks.getCategoryPromotions).not.toHaveBeenCalled()
  })

  it("reads a category's promotions when asked", async () => {
    mocks.getCategoryPromotions.mockResolvedValue({
      categoryId: "c2",
      title: "Angebote",
      results: { sections: [], visualFilters: [], powerFilters: [], textualFilters: [] },
    })
    const toolRegistry = await loadTools()

    await toolRegistry.executeTool("picnic_get_category_products", {
      category_id: "c2",
      promotions_only: true,
    })

    expect(mocks.getCategoryPromotions).toHaveBeenCalledWith("c2")
  })

  it("returns Picnic's replacements for an unavailable cart product", async () => {
    mocks.getReplacements.mockResolvedValue({
      productId: "s9",
      reason: "TEMPORARILY_UNAVAILABLE",
      replacements: [
        tile("s10", {
          originalPrice: 249,
          labels: [{ type: "PROMO", text: "20%", position: "topLeft" }],
        }),
      ],
    })
    const toolRegistry = await loadTools()

    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_replacements", { productId: "s9" }),
    )

    expect(payload).toEqual({
      product_id: "s9",
      reason: "TEMPORARILY_UNAVAILABLE",
      replacements: [
        {
          product_id: "s10",
          name: "Produkt s10",
          price: 199,
          original_price: 249,
          promotion_label: "20%",
          unit: "1 Stück",
          image_id: "img-s10",
        },
      ],
    })
  })

  it("returns the minimum order value and explains a missing slot", async () => {
    mocks.getMinimumOrderValue.mockResolvedValueOnce({
      slot_id: "slot1",
      minimum_order_value: 3500,
    })
    const toolRegistry = await loadTools()

    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_minimum_order_value", {}),
    )
    expect(payload).toEqual({ slot_id: "slot1", minimum_order_value: 3500 })

    mocks.getMinimumOrderValue.mockRejectedValueOnce(
      new PicnicClient.PicnicApiError(500, "INTERNAL", "boom"),
    )
    await expect(toolRegistry.executeTool("picnic_get_minimum_order_value", {})).rejects.toThrow(
      /picnic_set_delivery_slot/,
    )
  })

  it("changes a recipe's portions in the cart", async () => {
    mocks.updateRecipePortionsInCart.mockResolvedValue(undefined)
    const toolRegistry = await loadTools()

    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_update_recipe_portions_in_cart", {
        recipe_url_or_id: RECIPE_ID,
        portions: 2,
      }),
    )

    expect(mocks.updateRecipePortionsInCart).toHaveBeenCalledWith(RECIPE_ID, {
      dayOffset: 0,
      portions: 2,
    })
    expect(payload.recipeId).toBe(RECIPE_ID)
  })

  it("warns that a failed portion change may still have landed", async () => {
    mocks.updateRecipePortionsInCart.mockRejectedValue(new Error("500"))
    const toolRegistry = await loadTools()

    await expect(
      toolRegistry.executeTool("picnic_update_recipe_portions_in_cart", {
        recipe_url_or_id: RECIPE_ID,
        portions: 6,
      }),
    ).rejects.toThrow(/picnic_get_cart/)
  })
})
