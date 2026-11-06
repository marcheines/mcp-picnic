import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  initializePicnicClient: vi.fn(),
  sendRequest: vi.fn(),
  createUserDefinedRecipe: vi.fn(),
  setUserDefinedRecipeNote: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    url: "https://storefront-prod.de.picnicinternational.com/api/15",
    sendRequest: mocks.sendRequest,
    recipe: {
      createUserDefinedRecipe: mocks.createUserDefinedRecipe,
      setUserDefinedRecipeNote: mocks.setUserDefinedRecipeNote,
    },
  }),
  initializePicnicClient: mocks.initializePicnicClient,
  saveSession: vi.fn(),
  verifyPicnic2FACode: vi.fn(),
}))

const OWN_RECIPE_ID = "0123456789abcdef0123456789abcdef"

function parseToolResult(result: ToolResult) {
  return JSON.parse(result.content[0].text ?? "")
}

describe("picnic_create_recipe", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.initializePicnicClient.mockResolvedValue(undefined)
    mocks.createUserDefinedRecipe.mockResolvedValue({ sellingGroupId: OWN_RECIPE_ID })
    mocks.setUserDefinedRecipeNote.mockResolvedValue(undefined)
  })

  it("creates the recipe with portions, ingredients and an HTML note", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    await import("../../../src/tools/picnic-tools.js")

    const result = await toolRegistry.executeTool("picnic_create_recipe", {
      name: "Hähnchen-Wraps",
      portions: 3,
      ingredients: [{ product_id: "s1001", quantity: 2 }, { product_id: "s1002" }],
      note: "500 g Hähnchen <in Streifen>\n\nWraps kurz erwärmen & füllen.",
    })

    expect(result.isError).toBeFalsy()
    expect(mocks.createUserDefinedRecipe).toHaveBeenCalledWith(
      "Hähnchen-Wraps",
      [
        { sellingUnitId: "s1001", quantity: 2 },
        { sellingUnitId: "s1002", quantity: 1 },
      ],
      3,
    )
    expect(mocks.setUserDefinedRecipeNote).toHaveBeenCalledWith(
      OWN_RECIPE_ID,
      "<p>500 g Hähnchen &lt;in Streifen&gt;</p><p>Wraps kurz erwärmen &amp; füllen.</p>",
    )
    expect(parseToolResult(result)).toMatchObject({
      recipeId: OWN_RECIPE_ID,
      portions: 3,
      ingredientCount: 2,
      note: "saved",
    })
  })

  it("defaults to 4 portions and skips the note call without a note", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    await import("../../../src/tools/picnic-tools.js")

    await toolRegistry.executeTool("picnic_create_recipe", {
      name: "Nudeln",
      ingredients: [{ product_id: "s1001" }],
    })

    expect(mocks.createUserDefinedRecipe).toHaveBeenCalledWith(
      "Nudeln",
      [{ sellingUnitId: "s1001", quantity: 1 }],
      4,
    )
    expect(mocks.setUserDefinedRecipeNote).not.toHaveBeenCalled()
  })

  it("reports a failed note as a warning instead of failing the created recipe", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    await import("../../../src/tools/picnic-tools.js")
    mocks.setUserDefinedRecipeNote.mockRejectedValue(new Error("note rejected"))

    const result = await toolRegistry.executeTool("picnic_create_recipe", {
      name: "Nudeln",
      ingredients: [{ product_id: "s1001" }],
      note: "Kochen",
    })

    expect(result.isError).toBeFalsy()
    const parsed = parseToolResult(result)
    expect(parsed.recipeId).toBe(OWN_RECIPE_ID)
    expect(parsed.note).toBe("failed")
    expect(parsed.warning).toContain("note rejected")
  })

  it("rejects duplicate products and invalid product ids before calling Picnic", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    await import("../../../src/tools/picnic-tools.js")

    await expect(
      toolRegistry.executeTool("picnic_create_recipe", {
        name: "Doppelt",
        ingredients: [{ product_id: "s1001" }, { product_id: "s1001" }],
      }),
    ).rejects.toThrow(/only once/)

    await expect(
      toolRegistry.executeTool("picnic_create_recipe", {
        name: "Falsch",
        ingredients: [{ product_id: "banane" }],
      }),
    ).rejects.toThrow()

    await expect(
      toolRegistry.executeTool("picnic_create_recipe", {
        name: "x".repeat(44),
        ingredients: [{ product_id: "s1001" }],
      }),
    ).rejects.toThrow()

    expect(mocks.createUserDefinedRecipe).not.toHaveBeenCalled()
  })

  it("adds an own recipe (32-character id) to the cart via the selling-group endpoint", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    await import("../../../src/tools/picnic-tools.js")
    mocks.sendRequest.mockResolvedValue({})

    const result = await toolRegistry.executeTool("picnic_add_recipe_to_cart", {
      recipe_url_or_id: OWN_RECIPE_ID,
      portions: 2,
    })

    expect(result.isError).toBeFalsy()
    expect(mocks.sendRequest).toHaveBeenCalledWith(
      "POST",
      "/pages/task/assign-selling-group-to-basket",
      { payload: { selling_group_id: OWN_RECIPE_ID, portions: 2 } },
      { includePicnicHeaders: true },
    )
  })
})
