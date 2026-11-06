import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  initializePicnicClient: vi.fn(),
  getRecipe: vi.fn(),
  getCart: vi.fn(),
  renameUserDefinedRecipe: vi.fn(),
  updateUserDefinedRecipePortions: vi.fn(),
  updateRecipeIngredient: vi.fn(),
  updateRecipeIngredientInCart: vi.fn(),
  removeRecipeIngredient: vi.fn(),
  addUserDefinedRecipeIngredient: vi.fn(),
  setUserDefinedRecipeNote: vi.fn(),
  deleteUserDefinedRecipeNote: vi.fn(),
  deleteUserDefinedRecipe: vi.fn(),
  removeRecipeFromCart: vi.fn(),
  getUserDefinedRecipeSuggestedImages: vi.fn(),
  uploadUserDefinedRecipeImage: vi.fn(),
  selectUserDefinedRecipeImage: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    url: "https://storefront-prod.de.picnicinternational.com/api/15",
    sendRequest: vi.fn(),
    cart: { getCart: mocks.getCart },
    recipe: {
      getRecipe: mocks.getRecipe,
      renameUserDefinedRecipe: mocks.renameUserDefinedRecipe,
      updateUserDefinedRecipePortions: mocks.updateUserDefinedRecipePortions,
      updateRecipeIngredient: mocks.updateRecipeIngredient,
      updateRecipeIngredientInCart: mocks.updateRecipeIngredientInCart,
      removeRecipeIngredient: mocks.removeRecipeIngredient,
      addUserDefinedRecipeIngredient: mocks.addUserDefinedRecipeIngredient,
      setUserDefinedRecipeNote: mocks.setUserDefinedRecipeNote,
      deleteUserDefinedRecipeNote: mocks.deleteUserDefinedRecipeNote,
      deleteUserDefinedRecipe: mocks.deleteUserDefinedRecipe,
      removeRecipeFromCart: mocks.removeRecipeFromCart,
      getUserDefinedRecipeSuggestedImages: mocks.getUserDefinedRecipeSuggestedImages,
      uploadUserDefinedRecipeImage: mocks.uploadUserDefinedRecipeImage,
      selectUserDefinedRecipeImage: mocks.selectUserDefinedRecipeImage,
    },
  }),
  initializePicnicClient: mocks.initializePicnicClient,
  saveSession: vi.fn(),
  verifyPicnic2FACode: vi.fn(),
}))

const ID = "c771ae44030c40d7ac1206f6fcd13d9f"
const WRITES = [
  "renameUserDefinedRecipe",
  "updateUserDefinedRecipePortions",
  "updateRecipeIngredient",
  "removeRecipeIngredient",
  "addUserDefinedRecipeIngredient",
  "setUserDefinedRecipeNote",
  "deleteUserDefinedRecipeNote",
  "deleteUserDefinedRecipe",
  "removeRecipeFromCart",
] as const

function ingredient(productId: string, quantity = 1) {
  return {
    ingredientId: `ing-${productId}`,
    name: productId,
    sellingUnitId: productId,
    quantity,
    checked: true,
    type: "CORE",
    isAvailable: true,
    unitQuantity: null,
    neededText: null,
    price: 100,
  }
}

function recipe(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    name: "Rindergulasch",
    portions: 4,
    defaultPortions: 4,
    isRecipeOwner: true,
    ingredients: [ingredient("s1", 2), ingredient("s2"), ingredient("s3")],
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

function expectNoWrites() {
  for (const name of WRITES) expect(mocks[name]).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.initializePicnicClient.mockResolvedValue(undefined)
  mocks.getRecipe.mockResolvedValue(recipe())
  for (const name of WRITES) mocks[name].mockResolvedValue(undefined)
  mocks.updateRecipeIngredient.mockResolvedValue({ shouldUpdateCart: false })
  mocks.addUserDefinedRecipeIngredient.mockResolvedValue({ newComponentId: "new" })
})

describe("picnic_update_recipe", () => {
  it("applies all changes in a safe order and lists them", async () => {
    const toolRegistry = await loadTools()
    const calls: string[] = []
    for (const name of WRITES) {
      mocks[name].mockImplementation(async () => {
        calls.push(name)
        return name === "updateRecipeIngredient" ? { shouldUpdateCart: true } : undefined
      })
    }
    mocks.updateRecipeIngredientInCart.mockImplementation(async () => {
      calls.push("updateRecipeIngredientInCart")
    })

    const result = parseToolResult(
      await toolRegistry.executeTool("picnic_update_recipe", {
        recipe_id: ID.toUpperCase(),
        name: "Wintergulasch",
        portions: 6,
        note: "Langsam schmoren.",
        update_ingredients: [{ product_id: "s1", quantity: 3 }],
        replace_ingredients: [{ product_id: "s2", new_product_id: "s9" }],
        remove_ingredients: ["s3"],
        add_ingredients: [{ product_id: "s7", quantity: 2 }],
      }),
    )

    expect(calls).toEqual([
      "renameUserDefinedRecipe",
      "updateRecipeIngredient",
      "updateRecipeIngredientInCart",
      "removeRecipeIngredient", // s3
      "removeRecipeIngredient", // s2 (replace)
      "addUserDefinedRecipeIngredient", // s9 (replace)
      "addUserDefinedRecipeIngredient", // s7
      "setUserDefinedRecipeNote",
      "updateUserDefinedRecipePortions",
    ])
    const selection = {
      quantities: { s1: 3 },
      portions: 4,
      swapType: "WITHIN_SELLING_GROUP_COMPONENT",
    }
    expect(mocks.updateRecipeIngredient).toHaveBeenCalledWith(ID, "ing-s1", selection)
    expect(mocks.updateRecipeIngredientInCart).toHaveBeenCalledWith(ID, "ing-s1", selection)
    // the replacement keeps the old position and quantity
    expect(mocks.addUserDefinedRecipeIngredient).toHaveBeenNthCalledWith(1, ID, "s9", {
      quantity: 1,
      portions: 4,
      order: 1,
    })
    expect(mocks.addUserDefinedRecipeIngredient).toHaveBeenNthCalledWith(2, ID, "s7", {
      quantity: 2,
      portions: 4,
      order: 2,
    })
    expect(mocks.setUserDefinedRecipeNote).toHaveBeenCalledWith(ID, "<p>Langsam schmoren.</p>")
    expect(mocks.updateUserDefinedRecipePortions).toHaveBeenCalledWith(ID, 6)
    expect(result.recipeId).toBe(ID)
    expect(result.changes).toHaveLength(7)
  })

  it("deletes the note for an empty string and skips unchanged name and portions", async () => {
    const toolRegistry = await loadTools()

    const result = parseToolResult(
      await toolRegistry.executeTool("picnic_update_recipe", {
        recipe_id: ID,
        name: "Rindergulasch",
        portions: 4,
        note: "",
      }),
    )

    expect(mocks.deleteUserDefinedRecipeNote).toHaveBeenCalledWith(ID)
    expect(mocks.renameUserDefinedRecipe).not.toHaveBeenCalled()
    expect(mocks.updateUserDefinedRecipePortions).not.toHaveBeenCalled()
    expect(result.changes).toEqual(["note deleted"])
  })

  it.each([
    [{ remove_ingredients: ["s404"] }, /not an ingredient/],
    [{ add_ingredients: [{ product_id: "s2" }] }, /already an ingredient/],
    [
      { update_ingredients: [{ product_id: "s1", quantity: 2 }], remove_ingredients: ["s1"] },
      /only one operation/,
    ],
    [{}, /Nothing to change/],
  ])("validates %j before changing anything", async (changes, error) => {
    const toolRegistry = await loadTools()
    await expect(
      toolRegistry.executeTool("picnic_update_recipe", { recipe_id: ID, ...changes }),
    ).rejects.toThrow(error)
    expectNoWrites()
  })

  it("allows re-adding a product that is removed in the same call", async () => {
    const toolRegistry = await loadTools()
    await toolRegistry.executeTool("picnic_update_recipe", {
      recipe_id: ID,
      remove_ingredients: ["s2"],
      add_ingredients: [{ product_id: "s2", quantity: 3 }],
    })
    expect(mocks.removeRecipeIngredient).toHaveBeenCalledWith(ID, "ing-s2")
    expect(mocks.addUserDefinedRecipeIngredient).toHaveBeenCalledWith(ID, "s2", {
      quantity: 3,
      portions: 4,
      order: 2,
    })
  })

  it("refuses catalog recipes and malformed ids", async () => {
    const toolRegistry = await loadTools()
    mocks.getRecipe.mockResolvedValue(recipe({ isRecipeOwner: false }))
    await expect(
      toolRegistry.executeTool("picnic_update_recipe", { recipe_id: ID, name: "x" }),
    ).rejects.toThrow(/not one of your own recipes/)
    await expect(
      toolRegistry.executeTool("picnic_update_recipe", {
        recipe_id: "6299c215cd9ca8295124570c",
        name: "x",
      }),
    ).rejects.toThrow()
    expectNoWrites()
  })

  it("reports which steps were done when a later step fails", async () => {
    const toolRegistry = await loadTools()
    mocks.setUserDefinedRecipeNote.mockRejectedValue(new Error("note too long"))

    await expect(
      toolRegistry.executeTool("picnic_update_recipe", {
        recipe_id: ID,
        name: "Neu",
        note: "Text",
      }),
    ).rejects.toThrow(/Step "note replaced" failed: note too long\. Already done: renamed to "Neu"/)
  })
})

describe("picnic_delete_recipe", () => {
  it("removes the recipe from the cart first when it is there", async () => {
    const toolRegistry = await loadTools()
    const calls: string[] = []
    mocks.getCart.mockResolvedValue({ recipes: [{ id: ID, title: "Rindergulasch" }] })
    mocks.removeRecipeFromCart.mockImplementation(async () => calls.push("removeFromCart"))
    mocks.deleteUserDefinedRecipe.mockImplementation(async () => calls.push("delete"))

    const result = parseToolResult(
      await toolRegistry.executeTool("picnic_delete_recipe", { recipe_id: ID }),
    )

    expect(calls).toEqual(["removeFromCart", "delete"])
    expect(result).toEqual({
      message: "Recipe deleted",
      recipeId: ID,
      name: "Rindergulasch",
      removedFromCart: true,
    })
  })

  it("leaves the cart alone when the recipe is not in it or keep_in_cart is set", async () => {
    const toolRegistry = await loadTools()
    mocks.getCart.mockResolvedValue({ recipes: [] })

    await toolRegistry.executeTool("picnic_delete_recipe", { recipe_id: ID })
    await toolRegistry.executeTool("picnic_delete_recipe", { recipe_id: ID, keep_in_cart: true })

    expect(mocks.removeRecipeFromCart).not.toHaveBeenCalled()
    expect(mocks.getCart).toHaveBeenCalledTimes(1)
    expect(mocks.deleteUserDefinedRecipe).toHaveBeenCalledTimes(2)
  })

  it("refuses to delete a catalog recipe", async () => {
    const toolRegistry = await loadTools()
    mocks.getRecipe.mockResolvedValue(recipe({ isRecipeOwner: false }))
    await expect(
      toolRegistry.executeTool("picnic_delete_recipe", { recipe_id: ID }),
    ).rejects.toThrow(/not one of your own recipes/)
    expectNoWrites()
  })
})

describe("recipe images", () => {
  const suggestion = {
    id: "img1",
    referenceImage: {
      id: "img1",
      namespace: "recipes",
      primary_image: true,
      rank_value: 1,
      sellable_id: "6299c215cd9ca8295124570c",
      type: "RECIPE",
    },
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("lists suggested images with preview URLs", async () => {
    const toolRegistry = await loadTools()
    mocks.getUserDefinedRecipeSuggestedImages.mockResolvedValue([suggestion])

    const result = parseToolResult(
      await toolRegistry.executeTool("picnic_get_recipe_image_suggestions", { recipe_id: ID }),
    )

    expect(result.images).toEqual([
      {
        image_id: "img1",
        preview_url:
          "https://storefront-prod.de.picnicinternational.com/static/images/recipes/img1/large.png",
      },
    ])
  })

  it("sets a suggested image with its reference metadata", async () => {
    const toolRegistry = await loadTools()
    mocks.getUserDefinedRecipeSuggestedImages.mockResolvedValue([suggestion])

    await toolRegistry.executeTool("picnic_set_recipe_image", { recipe_id: ID, image_id: "img1" })

    expect(mocks.selectUserDefinedRecipeImage).toHaveBeenCalledWith(
      ID,
      "img1",
      suggestion.referenceImage,
    )
  })

  it("downloads an own image and uploads it", async () => {
    const toolRegistry = await loadTools()
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } }),
      )
    vi.stubGlobal("fetch", fetchMock)
    mocks.uploadUserDefinedRecipeImage.mockResolvedValue({ image_id: "up1" })

    const result = parseToolResult(
      await toolRegistry.executeTool("picnic_set_recipe_image", {
        recipe_id: ID,
        image_url: "https://example.com/gulasch.jpg",
      }),
    )

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" })
    expect(mocks.uploadUserDefinedRecipeImage).toHaveBeenCalledWith(ID, {
      data: bytes,
      type: "image/jpeg",
    })
    expect(mocks.selectUserDefinedRecipeImage).toHaveBeenCalledWith(ID, "up1")
    expect(result).toMatchObject({ imageId: "up1", bytes: 4 })
  })

  it.each([
    ["http://example.com/a.jpg", /https/],
    ["https://localhost/a.jpg", /public host/],
    ["https://10.0.0.5/a.jpg", /public host/],
    ["https://mcp-picnic.railway.internal/a.jpg", /public host/],
  ])("refuses %s", async (url, error) => {
    const toolRegistry = await loadTools()
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      toolRegistry.executeTool("picnic_set_recipe_image", { recipe_id: ID, image_url: url }),
    ).rejects.toThrow(error)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.uploadUserDefinedRecipeImage).not.toHaveBeenCalled()
  })

  it("refuses non-image downloads and wrong argument combinations", async () => {
    const toolRegistry = await loadTools()
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
        ),
    )

    await expect(
      toolRegistry.executeTool("picnic_set_recipe_image", {
        recipe_id: ID,
        image_url: "https://example.com/page",
      }),
    ).rejects.toThrow(/JPEG, PNG or WebP/)
    await expect(
      toolRegistry.executeTool("picnic_set_recipe_image", { recipe_id: ID }),
    ).rejects.toThrow(/exactly one/)
    expect(mocks.uploadUserDefinedRecipeImage).not.toHaveBeenCalled()
  })
})
