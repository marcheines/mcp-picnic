import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  initializePicnicClient: vi.fn(),
  getRecipeOverview: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    url: "https://storefront-prod.de.picnicinternational.com/api/15",
    sendRequest: vi.fn(),
    recipe: { getRecipeOverview: mocks.getRecipeOverview },
  }),
  initializePicnicClient: mocks.initializePicnicClient,
  saveSession: vi.fn(),
  verifyPicnic2FACode: vi.fn(),
}))

function summary(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    imageType: "GALLERY",
    imageId: `recipes/img-${id}`,
    subtitle: null,
    tags: [],
    cookingTimeMinutes: null,
    ...overrides,
  }
}

function parseToolResult(result: ToolResult) {
  return JSON.parse(result.content[0].text ?? "")
}

async function loadTools() {
  const { toolRegistry } = await import("../../../src/tools/registry.js")
  await import("../../../src/tools/picnic-tools.js")
  return toolRegistry
}

describe("picnic_get_recipe_overview", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.initializePicnicClient.mockResolvedValue(undefined)
    mocks.getRecipeOverview.mockResolvedValue({
      sections: [
        {
          title: "Favoriten",
          pill: "Nochmal bestellen",
          recipes: [
            summary("6299c215cd9ca8295124570c", "Hähnchen in Spinat-Parmesan-Sahne", {
              subtitle: "mit Tagliatelle",
              tags: ["25 min", "Kinder"],
              cookingTimeMinutes: 25,
            }),
          ],
        },
        {
          title: "Diese Woche",
          pill: "Für dich",
          recipes: [
            summary("668b85249a2ba07f8c34ec1a", "Tomate Mozzarella Auflauf", { imageId: null }),
          ],
        },
      ],
      categorySections: [],
    })
  })

  it("returns all rows with compact recipes", async () => {
    const toolRegistry = await loadTools()
    const result = parseToolResult(await toolRegistry.executeTool("picnic_get_recipe_overview", {}))

    expect(result.rows).toEqual([
      { title: "Favoriten", filter: "Nochmal bestellen" },
      { title: "Diese Woche", filter: "Für dich" },
    ])
    expect(result.sections).toEqual([
      {
        title: "Favoriten",
        filter: "Nochmal bestellen",
        recipes: [
          {
            recipeId: "6299c215cd9ca8295124570c",
            name: "Hähnchen in Spinat-Parmesan-Sahne",
            subtitle: "mit Tagliatelle",
            tags: ["25 min", "Kinder"],
            cookingTimeMinutes: 25,
            imageUrl:
              "https://storefront-prod.de.picnicinternational.com/static/images/recipes/img-6299c215cd9ca8295124570c/large.png",
            sourceUrl: expect.stringContaining("6299c215cd9ca8295124570c"),
          },
        ],
      },
      {
        title: "Diese Woche",
        filter: "Für dich",
        recipes: [
          {
            recipeId: "668b85249a2ba07f8c34ec1a",
            name: "Tomate Mozzarella Auflauf",
            sourceUrl: expect.stringContaining("668b85249a2ba07f8c34ec1a"),
          },
        ],
      },
    ])
  })

  it("filters rows by the selected filter or the title, still listing every row", async () => {
    const toolRegistry = await loadTools()
    const byFilter = parseToolResult(
      await toolRegistry.executeTool("picnic_get_recipe_overview", { section: "nochmal" }),
    )
    const byTitle = parseToolResult(
      await toolRegistry.executeTool("picnic_get_recipe_overview", { section: "WOCHE" }),
    )

    expect(byFilter.section_filter).toBe("nochmal")
    expect(byFilter.sections.map((s: { title: string }) => s.title)).toEqual(["Favoriten"])
    expect(byFilter.rows).toHaveLength(2)
    expect(byTitle.sections.map((s: { title: string }) => s.title)).toEqual(["Diese Woche"])
  })
})
