import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  initializePicnicClient: vi.fn(),
  sendRequest: vi.fn(),
  getRecipe: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    sendRequest: mocks.sendRequest,
    recipe: { getRecipe: mocks.getRecipe },
  }),
  initializePicnicClient: mocks.initializePicnicClient,
  saveSession: vi.fn(),
}))

const RECIPE_A = "0123456789abcdef01234567"
const RECIPE_B = "fedcba9876543210fedcba98"

function parseToolResult(result: ToolResult) {
  return JSON.parse(result.content[0].text ?? "")
}

/** A recipe as picnic-api 5 returns it (Recipe), with one core and one cupboard ingredient. */
function recipeModel(recipeId: string, recipeName: string) {
  return {
    id: recipeId,
    name: recipeName,
    portions: 2,
    defaultPortions: 4,
    ingredients: [
      {
        ingredientId: `ingredient-${recipeId}`,
        name: `${recipeName} ingredient`,
        sellingUnitId: `s-${recipeId}`,
        quantity: 2,
        checked: true,
        type: "CORE",
        isAvailable: true,
        unitQuantity: "500 g",
        neededText: "(400 g benötigt)",
        price: 125,
      },
      {
        ingredientId: `salt-${recipeId}`,
        name: null,
        sellingUnitId: "s-salt",
        quantity: 1,
        checked: false,
        type: "CUPBOARD",
        isAvailable: false,
        unitQuantity: null,
        neededText: null,
        price: null,
      },
    ],
  }
}

function expectedIngredients(recipeId: string, recipeName: string) {
  return {
    recipeId,
    recipeName,
    portions: 2,
    ingredients: [
      {
        ingredientId: `ingredient-${recipeId}`,
        sellingUnitId: `s-${recipeId}`,
        name: `${recipeName} ingredient`,
        packageInfo: "500 g",
        priceCents: 125,
        quantity: 2,
        isPantryItem: false,
        needed: "(400 g benötigt)",
      },
      {
        ingredientId: `salt-${recipeId}`,
        sellingUnitId: "s-salt",
        name: "",
        packageInfo: "",
        priceCents: null,
        quantity: 1,
        isPantryItem: true,
        unavailable: true,
      },
    ],
  }
}

async function loadTools() {
  vi.resetModules()
  const { toolRegistry } = await import("../../../src/tools/registry.js")
  const registerSpy = vi.spyOn(toolRegistry, "register")
  await import("../../../src/tools/picnic-tools.js")
  return { registerSpy, toolRegistry }
}

describe("recipe meal-planning tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reads recipe ingredients through picnic-api's getRecipe, with names resolved", async () => {
    mocks.getRecipe.mockResolvedValue(recipeModel(RECIPE_A, "Recipe A"))

    const { toolRegistry } = await loadTools()
    const result = await toolRegistry.executeTool("picnic_get_recipe_ingredients", {
      recipe_url_or_id: `https://picnic.app/de/rezepte/${RECIPE_A}/recipe-a`,
    })

    expect(mocks.getRecipe).toHaveBeenCalledWith(RECIPE_A, { resolveIngredientNames: true })
    expect(parseToolResult(result)).toEqual(expectedIngredients(RECIPE_A, "Recipe A"))
  })

  it("falls back to the recipe without name lookup when it fails", async () => {
    mocks.getRecipe
      .mockRejectedValueOnce(new Error("product page failed"))
      .mockResolvedValueOnce(recipeModel(RECIPE_A, "Recipe A"))

    const { toolRegistry } = await loadTools()
    const result = await toolRegistry.executeTool("picnic_get_recipe_ingredients", {
      recipe_url_or_id: RECIPE_A,
    })

    expect(mocks.getRecipe).toHaveBeenNthCalledWith(2, RECIPE_A)
    expect(parseToolResult(result).recipeName).toBe("Recipe A")
  })

  it("returns successes and per-input errors when fetching multiple recipe ingredients", async () => {
    mocks.getRecipe.mockImplementation(async (recipeId: string) => {
      if (recipeId === RECIPE_B) throw new Error("Recipe unavailable")
      return recipeModel(RECIPE_A, "Recipe A")
    })

    const { toolRegistry } = await loadTools()
    const result = await toolRegistry.executeTool("picnic_get_multiple_recipe_ingredients", {
      recipe_urls_or_ids: [RECIPE_A, RECIPE_B],
    })

    expect(parseToolResult(result)).toEqual({
      recipes: [expectedIngredients(RECIPE_A, "Recipe A")],
      errors: [{ input: RECIPE_B, error: "Recipe unavailable" }],
    })
  })

  it("registers the existing recipe cart tool only once", async () => {
    const { registerSpy } = await loadTools()

    const recipeCartRegistrations = registerSpy.mock.calls.filter(
      ([tool]) => tool.name === "picnic_add_recipe_to_cart",
    )

    expect(recipeCartRegistrations).toHaveLength(1)
  })
})
