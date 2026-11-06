import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  initializePicnicClient: vi.fn(),
  getPromotions: vi.fn(),
  getPromotionGroup: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    sendRequest: vi.fn(),
    catalog: {
      getPromotions: mocks.getPromotions,
      getPromotionGroup: mocks.getPromotionGroup,
    },
  }),
  initializePicnicClient: mocks.initializePicnicClient,
  saveSession: vi.fn(),
  verifyPicnic2FACode: vi.fn(),
}))

function parseToolResult(result: ToolResult) {
  return JSON.parse(result.content[0].text ?? "")
}

/** A product tile as picnic-api 5 returns it (ProductTile). */
function tile(overrides: Record<string, unknown> = {}) {
  return {
    id: "s100",
    name: "Hähnchenbrustfilet",
    namePrefix: null,
    brand: null,
    qualityCue: null,
    imageId: "img-s100",
    displayPrice: 599,
    originalPrice: 899,
    unitPrice: "€17,11/kg",
    priceRanges: null,
    unitQuantity: "350g",
    labels: [
      { position: "topLeft", type: null, text: "Neu" },
      { position: "bottomLeft", type: "PROMO", text: "jetzt 5.99€" },
    ],
    isUnavailable: false,
    ...overrides,
  }
}

function promotionsPage() {
  return {
    sections: [
      {
        id: "1-personal",
        title: "Für dich",
        products: [tile()],
        groups: [],
      },
      {
        id: "2-meat",
        title: "Fleisch & Fisch",
        // s100 appears again in its category section
        products: [
          tile(),
          tile({
            id: "s200",
            name: "Hüftsteak",
            brand: "Edeka",
            displayPrice: 629,
            originalPrice: null,
            unitPrice: null,
            labels: [{ position: "bottomLeft", type: "PROMO", text: "10% Rabatt" }],
            imageId: null,
          }),
        ],
        groups: [
          { id: "grp-1", name: "Wurstaufschnitt", example: "Bsp. Salami", label: "2 für 3€" },
        ],
      },
      {
        id: "3-dairy",
        title: "Molkerei",
        products: [
          tile({
            id: "s300",
            name: "Mozzarella",
            displayPrice: 99,
            originalPrice: 129,
            labels: [],
            isUnavailable: true,
          }),
        ],
        groups: [{ id: "grp-2", name: "Alpro", example: null, label: null }],
      },
    ],
  }
}

async function loadTools() {
  const { toolRegistry } = await import("../../../src/tools/registry.js")
  await import("../../../src/tools/picnic-tools.js")
  return toolRegistry
}

describe("promotions tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.initializePicnicClient.mockResolvedValue(undefined)
    mocks.getPromotions.mockResolvedValue(promotionsPage())
  })

  it("lists promoted products from all sections once, with prices and labels", async () => {
    const toolRegistry = await loadTools()
    const payload = parseToolResult(await toolRegistry.executeTool("picnic_get_promotions", {}))

    expect(mocks.getPromotions).toHaveBeenCalledTimes(1)
    expect(payload.promotions).toEqual([
      {
        product_id: "s100",
        name: "Hähnchenbrustfilet",
        price: 599,
        original_price: 899,
        promotion_label: "jetzt 5.99€",
        unit: "350g",
        unit_price: "€17,11/kg",
        section: "Für dich",
        image_id: "img-s100",
      },
      {
        product_id: "s200",
        name: "Hüftsteak",
        brand: "Edeka",
        price: 629,
        promotion_label: "10% Rabatt",
        unit: "350g",
        section: "Fleisch & Fisch",
      },
      {
        product_id: "s300",
        name: "Mozzarella",
        price: 99,
        original_price: 129,
        unit: "350g",
        unit_price: "€17,11/kg",
        section: "Molkerei",
        unavailable: true,
        image_id: "img-s100",
      },
    ])
    expect(payload.sections).toEqual([
      { title: "Für dich", products: 1, groups: 0 },
      { title: "Fleisch & Fisch", products: 2, groups: 1 },
      { title: "Molkerei", products: 1, groups: 1 },
    ])
    expect(payload.promotion_groups).toEqual([
      {
        group_id: "grp-1",
        name: "Wurstaufschnitt",
        promotion_label: "2 für 3€",
        example: "Bsp. Salami",
        section: "Fleisch & Fisch",
      },
      { group_id: "grp-2", name: "Alpro", section: "Molkerei" },
    ])
    expect(payload.pagination).toEqual({
      offset: 0,
      limit: 25,
      returned: 3,
      total: 3,
      hasMore: false,
    })
  })

  it("filters by section title, case-insensitively", async () => {
    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_promotions", { section: "fleisch" }),
    )

    expect(payload.section_filter).toBe("fleisch")
    expect(payload.promotions.map((p: { product_id: string }) => p.product_id)).toEqual([
      "s100",
      "s200",
    ])
    expect(payload.promotions[0].section).toBe("Fleisch & Fisch")
    expect(payload.promotion_groups).toHaveLength(1)
    // the overview still lists every section, so the caller can pick another filter
    expect(payload.sections).toHaveLength(3)
  })

  it("paginates and can leave out promotion groups", async () => {
    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_promotions", {
        offset: 1,
        limit: 1,
        include_groups: false,
      }),
    )

    expect(payload.promotions).toEqual([expect.objectContaining({ product_id: "s200" })])
    expect(payload.pagination).toEqual({
      offset: 1,
      limit: 1,
      returned: 1,
      total: 3,
      hasMore: true,
    })
    expect(payload.promotion_groups).toBeUndefined()
  })

  it("lists the products of a promotion group", async () => {
    const toolRegistry = await loadTools()
    mocks.getPromotionGroup.mockResolvedValue({
      id: "grp-1",
      name: "Wurstaufschnitt",
      products: [tile({ id: "s400", name: "Salami", labels: [] })],
    })

    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_promotion_group", { group_id: "grp-1" }),
    )

    expect(mocks.getPromotionGroup).toHaveBeenCalledWith("grp-1")
    expect(payload).toMatchObject({ group_id: "grp-1", name: "Wurstaufschnitt", total: 1 })
    expect(payload.products[0]).toMatchObject({
      product_id: "s400",
      name: "Salami",
      price: 599,
      original_price: 899,
    })
    expect(payload.products[0].section).toBeUndefined()
  })
})
