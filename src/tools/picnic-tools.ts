import { z } from "zod"
import PicnicClient from "picnic-api"
import { toolRegistry, mcpContent } from "./registry.js"
import {
  getPicnicClient,
  initializePicnicClient,
  saveSession,
  verifyPicnic2FACode,
} from "../utils/picnic-client.js"
import {
  resolveRecipeId,
  parseSellingGroupRecipe,
  parseRecipeList,
  buildRecipeSourceUrl,
} from "../utils/recipe-parser.js"
import { buildShoppingList, findMealCombinations } from "../utils/recipe-meal-planning.js"
import type { StructuredRecipeIngredients } from "../utils/recipe-meal-planning.js"
import { config } from "../config.js"

type PicnicDeliveryStatus = PicnicClient.Types.cart.DeliveryStatus

/**
 * Picnic API tools optimized for LLM consumption
 *
 * Optimizations applied:
 * - Search results are filtered to essential fields only (id, name, price, unit, image_id)
 * - Pagination added to search and deliveries tools to prevent context overflow
 * - Cart data is filtered to reduce verbosity while keeping essential information
 * - Default limits set to reasonable values (10 for search, 10 for deliveries)
 */

// Helper function to ensure client is initialized
async function ensureClientInitialized() {
  try {
    getPicnicClient()
  } catch {
    // Client not initialized, initialize it now
    await initializePicnicClient()
  }
}

/**
 * Runs a cart mutation, converting failures into an explicitly ambiguous error.
 *
 * Picnic applies the mutation and renders the updated cart in the same request, so a
 * non-2xx response does not mean the write was rejected — it may already have landed and
 * only the render failed. A caller that reads such an error as "nothing happened" will
 * retry, and each retry applies the change again. Say so instead of reporting a clean
 * failure, and point the caller at a read rather than a retry.
 */
async function mutateCart<T>(action: string, mutation: () => Promise<T>): Promise<T> {
  try {
    return await mutation()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${action} failed: ${message}. The cart may still have been modified — ` +
        `call picnic_get_cart to check the current contents before retrying, ` +
        `because retrying can apply the change a second time.`,
    )
  }
}

// Annotations shared by every tool that mutates cart contents. Tells the calling model the
// operation is not safe to blindly retry (see mutateCart above).
const CART_MUTATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const

type PicnicCart = PicnicClient.Types.cart.Cart
type PicnicCartLine = PicnicClient.Types.cart.CartLineItem
type PicnicDelivery = PicnicClient.Types.delivery.Delivery

/**
 * Reduces a cart or order line to what an LLM needs. In picnic-api 5 every line holds one
 * product; it is reported as an order line with one article, the shape of the 4.x version.
 */
function toLineSummary(line: PicnicCartLine) {
  const quantity = line.quantity ?? 1
  return {
    order_line_id: line.id,
    // Line price in cents, after discounts (all units of the product together).
    price: line.displayPrice,
    ...(line.originalPrice != null && { original_price: line.originalPrice }),
    articles: [
      {
        product_id: line.productId,
        name: line.name,
        unit: line.unitQuantity,
        // Price per unit in cents. How many units are in the cart matters to callers: it is
        // what they check when a mutation failed ambiguously (see mutateCart).
        price: quantity > 0 ? Math.round(line.displayPrice / quantity) : line.displayPrice,
        quantity,
        ...(line.imageId && { image_id: line.imageId }),
      },
    ],
    ...(line.labels?.length && {
      labels: line.labels.map((label) => label.text).filter(Boolean),
    }),
    ...(line.isUnavailable && {
      unavailable: true,
      ...(line.unavailableReason && { unavailable_reason: line.unavailableReason }),
    }),
    ...(line.recipeId && { recipe_id: line.recipeId }),
  }
}

/**
 * Reduces a picnic-api 5 delivery to what an LLM needs: per order the products (in the same
 * shape as the cart), totals and payment type. Amounts are in cents.
 */
export function filterDeliveryData(delivery: PicnicDelivery) {
  return {
    id: delivery.id,
    status: delivery.status,
    window_start: delivery.windowStart,
    window_end: delivery.windowEnd,
    total_price: delivery.totalPrice,
    total_count: delivery.totalCount,
    ...(delivery.promotionSavings ? { total_savings: delivery.promotionSavings } : {}),
    ...(delivery.depositTotal ? { deposit_total: delivery.depositTotal } : {}),
    ...(delivery.returnedContainers?.length && {
      returned_containers: delivery.returnedContainers.map((container) => ({
        name: container.name,
        quantity: container.quantity,
        refund: container.price,
      })),
    }),
    cancellable: delivery.cancellable,
    orders: (delivery.orders ?? []).map((order) => ({
      order_id: order.id,
      status: order.status,
      created: order.creationTime,
      items: (order.items ?? []).map(toLineSummary),
      // Amount paid for the order, including deposits and fees.
      total_price: order.checkoutTotalPrice,
      ...(order.promotionSavings ? { total_savings: order.promotionSavings } : {}),
      ...(order.payment?.paymentType && { payment_type: order.payment.paymentType }),
    })),
  }
}

/**
 * Reduces the picnic-api 5 cart model to what an LLM needs.
 *
 * Keeps the output shape of the 4.x version (order lines with an `articles` list, snake_case
 * totals) so existing callers keep working. In 5.x every cart line holds exactly one product
 * with its quantity and line price, so each order line carries one article.
 */
export function filterCartData(cart: PicnicCart | null | undefined) {
  if (!cart || typeof cart !== "object") return cart

  const items = (cart.items ?? []).map(toLineSummary)

  return {
    id: cart.id,
    items,
    total_count: cart.totalCount,
    // Amount to pay in cents, including deposits and fees.
    total_price: cart.totalPrice,
    total_savings: cart.promotionSavings,
    ...(cart.membershipSavings ? { membership_savings: cart.membershipSavings } : {}),
    ...(cart.depositTotal ? { deposit_total: cart.depositTotal } : {}),
    ...(cart.fees?.length && {
      fees: cart.fees.map((fee) => ({ name: fee.name, amount: fee.amount })),
    }),
    ...(cart.minimumOrderValue != null && { minimum_order_value: cart.minimumOrderValue }),
    ...(cart.selectedSlot && {
      selected_slot: {
        slot_id: cart.selectedSlot.slotId,
        window_start: cart.selectedSlot.windowStart,
        window_end: cart.selectedSlot.windowEnd,
        explicitly_selected: cart.selectedSlot.isExplicitSelection,
      },
    }),
    ...(cart.recipes?.length && {
      recipes: cart.recipes.map((recipe) => ({
        recipe_id: recipe.id,
        title: recipe.title,
        ...(recipe.preTitle && { portions: recipe.preTitle }),
      })),
    }),
  }
}

// Search products tool
const searchInputSchema = z.object({
  query: z.string().describe("Search query for products"),
  limit: z
    .number()
    .min(1)
    .max(20)
    .default(5)
    .describe("Maximum number of results to return (1-20, default: 5)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of results to skip for pagination (default: 0)"),
})

toolRegistry.register({
  name: "picnic_search",
  description: "Search for products in Picnic with pagination and filtered results",
  inputSchema: searchInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const searchResults = await client.catalog.getSearchResults(args.query)
    // picnic-api 5 returns the results grouped in sections; a product can appear in several
    // sections (e.g. "bought before" and its product group), so flatten and de-duplicate.
    const seen = new Set<string>()
    const allResults = (searchResults.products?.sections ?? [])
      .flatMap((section) => section.products)
      .filter((product) => {
        if (seen.has(product.id)) return false
        seen.add(product.id)
        return true
      })

    // Apply pagination
    const startIndex = args.offset || 0
    const limit = args.limit || 5
    const paginatedResults = allResults.slice(startIndex, startIndex + limit)

    // Filter results to only include essential data for LLM
    const filteredResults = paginatedResults.map((product) => ({
      id: product.id,
      name: product.name,
      ...(product.brand && { brand: product.brand }),
      price: product.displayPrice,
      unit: product.unitQuantity,
      ...(product.isUnavailable && { unavailable: true }),
      // Only include image_id if it exists, for potential image retrieval
      ...(product.imageId && { image_id: product.imageId }),
    }))

    return {
      query: args.query,
      results: filteredResults,
      pagination: {
        offset: startIndex,
        limit,
        returned: filteredResults.length,
        total: allResults.length,
        hasMore: startIndex + limit < allResults.length,
      },
    }
  },
})

// Weekly promotions/deals tool
type PicnicProductTile = PicnicClient.Types.catalog.ProductTile

/** The promotion text of a product tile, e.g. "1+1 gratis": the PROMO label, else the first label. */
function promotionLabel(tile: PicnicProductTile): string | undefined {
  const labels = tile.labels ?? []
  const label = labels.find((l) => l.type === "PROMO" && l.text) ?? labels.find((l) => l.text)
  return label?.text ?? undefined
}

/** Reduces a promoted product tile to what an LLM needs. Prices are in cents. */
function toPromotionProduct(tile: PicnicProductTile, section?: string) {
  const label = promotionLabel(tile)
  return {
    product_id: tile.id,
    name: tile.name,
    ...(tile.brand && { brand: tile.brand }),
    price: tile.displayPrice,
    ...(tile.originalPrice != null && { original_price: tile.originalPrice }),
    ...(label && { promotion_label: label }),
    ...(tile.unitQuantity && { unit: tile.unitQuantity }),
    ...(tile.unitPrice && { unit_price: tile.unitPrice }),
    ...(section && { section }),
    ...(tile.isUnavailable && { unavailable: true }),
    ...(tile.imageId && { image_id: tile.imageId }),
  }
}

const promotionsInputSchema = z.object({
  section: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Only promotions from sections whose title contains this text (case-insensitive), " +
        "e.g. 'Fleisch' or 'Molkerei'. Omit for all sections; the response lists the sections.",
    ),
  include_groups: z
    .boolean()
    .default(true)
    .describe(
      "Include promotion groups (deals on several products, e.g. '20% auf Alpro'). " +
        "List their products with picnic_get_promotion_group.",
    ),
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(25)
    .describe("Maximum number of promoted products to return (1-100, default: 25)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of promoted products to skip for pagination (default: 0)"),
})

toolRegistry.register({
  name: "picnic_get_promotions",
  description:
    "Get Picnic's current promotions/deals from the app's promotions page. Returns promoted " +
    "products (current price, original price, promotion label, section), the page's sections, " +
    "and promotion groups (deals on several products). Prices are in cents. Optionally filter " +
    "by section title.",
  inputSchema: promotionsInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const page = await client.catalog.getPromotions()
    const allSections = page.sections ?? []

    const filter = args.section?.toLocaleLowerCase("de")
    const sections = filter
      ? allSections.filter((section) => section.title?.toLocaleLowerCase("de").includes(filter))
      : allSections

    // A product can be shown in several sections (e.g. personal promotions and its category);
    // list it once, under the first section it appears in.
    const seen = new Set<string>()
    const allPromotions = sections.flatMap((section) =>
      (section.products ?? [])
        .filter((tile) => {
          if (seen.has(tile.id)) return false
          seen.add(tile.id)
          return true
        })
        .map((tile) => toPromotionProduct(tile, section.title)),
    )

    const startIndex = args.offset ?? 0
    const limit = args.limit ?? 25
    const promotions = allPromotions.slice(startIndex, startIndex + limit)

    return {
      ...(args.section && { section_filter: args.section }),
      sections: allSections.map((section) => ({
        title: section.title,
        products: section.products?.length ?? 0,
        groups: section.groups?.length ?? 0,
      })),
      promotions,
      pagination: {
        offset: startIndex,
        limit,
        returned: promotions.length,
        total: allPromotions.length,
        hasMore: startIndex + limit < allPromotions.length,
      },
      ...((args.include_groups ?? true) && {
        promotion_groups: sections.flatMap((section) =>
          (section.groups ?? []).map((group) => ({
            group_id: group.id,
            name: group.name,
            ...(group.label && { promotion_label: group.label }),
            ...(group.example && { example: group.example }),
            section: section.title,
          })),
        ),
      }),
    }
  },
})

// Products of a promotion group (a deal on several products)
const promotionGroupInputSchema = z.object({
  group_id: z
    .string()
    .trim()
    .min(1)
    .describe("Promotion group id from the promotion_groups list of picnic_get_promotions."),
})

toolRegistry.register({
  name: "picnic_get_promotion_group",
  description:
    "List the products of a Picnic promotion group (a deal on several products, e.g. " +
    "'20% auf Alpro'), with current and original prices in cents and the promotion label.",
  inputSchema: promotionGroupInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const group = await client.catalog.getPromotionGroup(args.group_id)
    const products = (group.products ?? []).map((tile) => toPromotionProduct(tile))
    return {
      group_id: group.id,
      name: group.name,
      products,
      total: products.length,
    }
  },
})

// Get product suggestions tool
const suggestionsInputSchema = z.object({
  query: z.string().describe("Query for product suggestions"),
})

toolRegistry.register({
  name: "picnic_get_suggestions",
  description: "Get product suggestions based on a query",
  inputSchema: suggestionsInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const suggestions = await client.catalog.getSuggestions(args.query)
    return {
      query: args.query,
      suggestions,
    }
  },
})

// Note: picnic_get_article tool removed - endpoint deprecated (GitHub issue #23)
// Use picnic_search instead for basic product information

// Get product details tool
const productDetailsInputSchema = z.object({
  productId: z
    .string()
    .describe("The product selling unit ID (e.g. 's1001524'), as returned by search or cart"),
  full: z
    .boolean()
    .default(false)
    .describe(
      "When false (default), returns essential fields only (id, name, brand, price, unit, image). " +
        "When true, returns full details including description, allergens, nutritional info, promotions, and similar products.",
    ),
})

toolRegistry.register({
  name: "picnic_get_product_details",
  description:
    "Look up product details by ID. Returns essential info by default (name, brand, price, unit, image). " +
    "Set full=true for complete details including description, allergens, ingredients, and similar products. " +
    "Use this to resolve opaque product IDs from cart or order history.",
  inputSchema: productDetailsInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const details = await client.catalog.getProduct(args.productId)

    if (args.full) {
      return details
    }

    return {
      id: details.id,
      name: details.name,
      brand: details.brand,
      price: details.displayPrice,
      unit: details.unitQuantity,
      ...(details.imageIds.length > 0 && { image_id: details.imageIds[0] }),
    }
  },
})

// Get product image tool
const imageInputSchema = z.object({
  imageId: z.string().describe("The ID of the image to retrieve"),
  size: z
    .enum(["tiny", "small", "medium", "large", "extra-large"])
    .describe("The size of the image"),
})

toolRegistry.register({
  name: "picnic_get_image",
  description:
    "Get a product image by image ID and size. Returns the image itself as MCP image content.",
  inputSchema: imageInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const image = await client.catalog.getImage(args.imageId, args.size)
    // Picnic serves these as PNG (/static/images/<id>/<size>.png).
    return mcpContent([
      {
        type: "image",
        data: Buffer.from(image).toString("base64"),
        mimeType: "image/png",
      },
    ])
  },
})

// Recipe tools
//
// Picnic recipes are "selling groups". Recipe detail comes from
// /pages/selling-group-details-page?selling_group_id=<id>, and the cookbook /
// recipe overview from /pages/cookbook-page-content. The listing and detail tools
// still read these pages directly with their own parsers (checked against the live
// API with picnic-api 5). The ingredient tools use picnic-api's recipe.getRecipe.

// Base URL for recipe/product image derivatives, derived from the API URL, e.g.
// https://storefront-prod.de.picnicinternational.com/static/images
function recipeImageBaseUrl(client: ReturnType<typeof getPicnicClient>): string {
  return client.url.replace(/\/api\/.*$/, "/static/images")
}

const RECIPE_CATEGORY_INPUT_RE = /^(?:recipe[_-]cattree[_-])?[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/i
const RECIPE_CATEGORY_PAGE_ID_RE = /recipe[_-]cattree[_-][a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?/gi
const RECIPE_CATEGORY_PREFIX_RE = /^recipe[_-]cattree[_-]/i

async function fetchRecipePage(client: ReturnType<typeof getPicnicClient>, pageId: string) {
  const page = await client.sendRequest("GET", `/pages/${pageId}`, null, {
    includePicnicHeaders: true,
  })
  return { pageId, page }
}

async function fetchRecipeListPage(client: ReturnType<typeof getPicnicClient>, category?: string) {
  if (!category) return fetchRecipePage(client, "cookbook-page-content")

  if (RECIPE_CATEGORY_PREFIX_RE.test(category)) {
    return fetchRecipePage(client, category)
  }

  const underscorePageId = `recipe_cattree_${category}`
  try {
    return await fetchRecipePage(client, underscorePageId)
  } catch (error) {
    const dashPageId = `recipe-cattree-${category}`
    try {
      return await fetchRecipePage(client, dashPageId)
    } catch {
      throw error
    }
  }
}

function extractRecipeCategoryIds(page: unknown): string[] {
  const ids = new Set<string>()

  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(RECIPE_CATEGORY_PAGE_ID_RE)) ids.add(match[0])
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (!node || typeof node !== "object") return
    for (const value of Object.values(node as Record<string, unknown>)) visit(value)
  }

  visit(page)
  return [...ids]
}

async function fetchCookbookRecipes(client: ReturnType<typeof getPicnicClient>) {
  const { page } = await fetchRecipeListPage(client)
  return parseRecipeList(page, { imageBaseUrl: recipeImageBaseUrl(client) })
}

function paginateRecipes(all: ReturnType<typeof parseRecipeList>, offset: number, limit: number) {
  const startIndex = offset || 0
  const recipes = all.slice(startIndex, startIndex + limit).map((recipe) => ({
    ...recipe,
    sourceUrl: buildRecipeSourceUrl(config.PICNIC_COUNTRY_CODE, recipe.recipeId),
  }))
  return {
    recipes,
    pagination: {
      offset: startIndex,
      limit,
      returned: recipes.length,
      total: all.length,
      hasMore: startIndex + limit < all.length,
    },
  }
}

// Get recipe tool
const getRecipeInputSchema = z.object({
  recipe_url_or_id: z
    .string()
    .min(1)
    .describe(
      "A Picnic recipe URL (any format) or a 24-character hex recipe ID. " +
        "Examples: 'https://picnic.app/de/go/abc123', " +
        "'https://picnic.app/de/rezepte/0123456789abcdef01234567/example-recipe', " +
        "'0123456789abcdef01234567'",
    ),
})

toolRegistry.register({
  name: "picnic_get_recipe",
  description:
    "Fetch a Picnic recipe by URL or recipe ID. Returns structured recipe data: name, " +
    "description, ingredients, preparation steps, timing, servings, image URL, saved state, " +
    "and the canonical source URL. Accepts short share links (picnic.app/de/go/xxx), full " +
    "recipe URLs, or bare recipe IDs.",
  inputSchema: getRecipeInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    const page = await client.sendRequest(
      "GET",
      `/pages/selling-group-details-page?selling_group_id=${encodeURIComponent(recipeId)}`,
      null,
      { includePicnicHeaders: true },
    )
    const parsed = parseSellingGroupRecipe(page, { imageBaseUrl: recipeImageBaseUrl(client) })
    const sourceUrl = buildRecipeSourceUrl(config.PICNIC_COUNTRY_CODE, recipeId)
    return { recipeId, sourceUrl, ...parsed }
  },
})

// Browse / saved recipes
const recipeListInputSchema = z.object({
  category: z
    .string()
    .regex(
      RECIPE_CATEGORY_INPUT_RE,
      "Use a bare recipe category ID or a full recipe_cattree/recipe-cattree page ID.",
    )
    .optional()
    .describe(
      "Recipe category ID, such as '20minuten', or full page ID, such as 'recipe-cattree-jamie-oliver'.",
    ),
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(25)
    .describe("Maximum number of recipes to return (1-100, default: 25)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of recipes to skip for pagination (default: 0)"),
})

toolRegistry.register({
  name: "picnic_browse_recipes",
  description:
    "Browse Picnic's recipe/cookbook overview or a specific recipe category. Returns a " +
    "paginated list of recipes (id, name, image URL, cookbook section, source URL) and " +
    "category page IDs when available. Use the recipeId with picnic_get_recipe for full details.",
  inputSchema: recipeListInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const { pageId, page } = await fetchRecipeListPage(client, args.category)
    const all = parseRecipeList(page, { imageBaseUrl: recipeImageBaseUrl(client) })
    const result = { pageId, ...paginateRecipes(all, args.offset ?? 0, args.limit ?? 25) }
    const categories = extractRecipeCategoryIds(page)
    if ((!args.category || all.length === 0) && categories.length > 0) {
      return { ...result, categories }
    }
    return result
  },
})

toolRegistry.register({
  name: "picnic_get_saved_recipes",
  description:
    "List the recipes the user has saved/favourited in their Picnic cookbook (the " +
    "'Gespeichert' tab), distinct from the public discovery feed. Returns id, name, image URL " +
    "and source URL — useful for importing saved recipes elsewhere.",
  inputSchema: recipeListInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const all = await fetchCookbookRecipes(client)
    const saved = all.filter((recipe) => recipe.segments.includes("SAVED_RECIPES"))
    return paginateRecipes(saved, args.offset ?? 0, args.limit ?? 25)
  },
})

toolRegistry.register({
  name: "picnic_get_own_recipes",
  description:
    "List the user's own recipes (the cookbook 'Eigene Rezepte' tab — user-created recipes). " +
    "Returns id, name, image URL and source URL.",
  inputSchema: recipeListInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const all = await fetchCookbookRecipes(client)
    const own = all.filter((recipe) => recipe.segments.includes("USER_DEFINED_RECIPES"))
    return paginateRecipes(own, args.offset ?? 0, args.limit ?? 25)
  },
})

// Create an own (user-defined) recipe
const PICNIC_PRODUCT_ID_RE = /^s\d+$/
// Limits enforced by the Picnic app's recipe editor.
const OWN_RECIPE_NAME_MAX = 43
const OWN_RECIPE_NOTE_MAX = 5000

const createRecipeInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(OWN_RECIPE_NAME_MAX)
    .describe(`Recipe name (max ${OWN_RECIPE_NAME_MAX} characters, the app's limit).`),
  portions: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(4)
    .describe("Default number of portions the ingredient quantities are for (default: 4)."),
  ingredients: z
    .array(
      z.object({
        product_id: z
          .string()
          .regex(PICNIC_PRODUCT_ID_RE, "Expected a Picnic product id such as s1018231")
          .describe("Picnic product (selling unit) id from picnic_search, e.g. s1018231."),
        quantity: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("Number of product units (packages, not grams) for the given portions."),
      }),
    )
    .min(1)
    .describe("The ingredients as Picnic products. Each product may appear only once."),
  note: z
    .string()
    .max(OWN_RECIPE_NOTE_MAX)
    .optional()
    .describe(
      "Optional free-text note, e.g. preparation steps or amounts in grams. Plain text; " +
        "blank lines separate paragraphs.",
    ),
})

/** Escapes text for the HTML the Picnic recipe note editor stores. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Converts a plain-text note into the paragraph HTML produced by the Picnic app's editor,
 * e.g. `<p>400g Nudeln</p><p>Nudeln kochen.</p>`. Every line becomes its own paragraph.
 */
export function noteToPicnicHtml(note: string): string {
  return note
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("")
}

toolRegistry.register({
  name: "picnic_create_recipe",
  description:
    "Create an own recipe in the user's Picnic cookbook ('Eigene Rezepte') with a name, " +
    "default portions, ingredients as Picnic products (ids from picnic_search) and an optional " +
    "note. Returns the new recipe id, which works with picnic_get_recipe and " +
    "picnic_add_recipe_to_cart. Not idempotent: calling it twice creates two recipes, so check " +
    "picnic_get_own_recipes before retrying after an error.",
  inputSchema: createRecipeInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const productIds = args.ingredients.map((ingredient) => ingredient.product_id)
    const duplicates = productIds.filter((id, index) => productIds.indexOf(id) !== index)
    if (duplicates.length > 0) {
      throw new Error(
        `Each product may appear only once; combine the quantities of: ${[...new Set(duplicates)].join(", ")}`,
      )
    }
    const noteHtml = args.note ? noteToPicnicHtml(args.note) : ""

    await ensureClientInitialized()
    const client = getPicnicClient()
    const portions = args.portions ?? 4
    const created = await client.recipe.createUserDefinedRecipe(
      args.name,
      args.ingredients.map((ingredient) => ({
        sellingUnitId: ingredient.product_id,
        quantity: ingredient.quantity ?? 1,
      })),
      portions,
    )
    const recipeId = created?.sellingGroupId
    if (!recipeId) {
      throw new Error(
        "Picnic did not return an id for the new recipe. It may still have been created; " +
          "check picnic_get_own_recipes before retrying.",
      )
    }

    const result: Record<string, unknown> = {
      message: "Recipe created",
      recipeId,
      name: args.name,
      portions,
      ingredientCount: args.ingredients.length,
    }

    if (noteHtml) {
      try {
        await client.recipe.setUserDefinedRecipeNote(recipeId, noteHtml)
        result.note = "saved"
      } catch (error) {
        // The recipe exists already; report the partial result instead of failing, so a
        // retry does not create a duplicate recipe.
        result.note = "failed"
        result.warning =
          `The recipe was created, but saving the note failed: ${getErrorMessage(error)}. ` +
          "Do not create the recipe again."
      }
    }

    return result
  },
})

// Save / unsave recipe
const recipeRefInputSchema = z.object({
  recipe_url_or_id: z
    .string()
    .min(1)
    .describe("A Picnic recipe URL (any format) or a 24- or 32-character hex recipe ID."),
})

toolRegistry.register({
  name: "picnic_save_recipe",
  description: "Save a recipe to the user's Picnic cookbook, by URL or recipe ID.",
  inputSchema: recipeRefInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    await client.sendRequest(
      "POST",
      "/pages/task/recipe-saving",
      { payload: { recipe_id: recipeId, saved_at: new Date().toISOString() } },
      { includePicnicHeaders: true },
    )
    return { message: "Recipe saved", recipeId }
  },
})

toolRegistry.register({
  name: "picnic_unsave_recipe",
  description: "Remove a recipe from the user's Picnic cookbook, by URL or recipe ID.",
  inputSchema: recipeRefInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    await client.sendRequest(
      "POST",
      "/pages/task/recipe-saving",
      { payload: { recipe_id: recipeId, saved_at: null } },
      { includePicnicHeaders: true },
    )
    return { message: "Recipe removed from cookbook", recipeId }
  },
})

// Add a recipe's ingredients to the basket by assigning the selling group.
const addRecipeToCartInputSchema = z.object({
  recipe_url_or_id: z
    .string()
    .min(1)
    .describe(
      "A Picnic recipe URL (any format), a 24-character catalog recipe ID or a 32-character " +
        "own-recipe ID (from picnic_get_own_recipes or picnic_create_recipe).",
    ),
  portions: z
    .number()
    .min(1)
    .optional()
    .describe("Number of portions to add (defaults to the recipe's default portions)."),
})

toolRegistry.register({
  name: "picnic_add_recipe_to_cart",
  description:
    "Add a recipe's ingredients to the shopping cart by assigning the recipe (selling group) " +
    "to the basket. Optionally set the number of portions. If this fails, call picnic_get_cart " +
    "to check whether the ingredients landed before retrying.",
  inputSchema: addRecipeToCartInputSchema,
  annotations: CART_MUTATION_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    const payload: { selling_group_id: string; portions?: number } = { selling_group_id: recipeId }
    if (args.portions !== undefined) payload.portions = args.portions
    await mutateCart("Adding the recipe to the cart", () =>
      client.sendRequest(
        "POST",
        "/pages/task/assign-selling-group-to-basket",
        { payload },
        { includePicnicHeaders: true },
      ),
    )
    return {
      message: "Recipe added to cart",
      recipeId,
      ...(args.portions !== undefined && { portions: args.portions }),
    }
  },
})

// Remove a recipe's ingredients from the basket (inverse of add_recipe_to_cart).
toolRegistry.register({
  name: "picnic_remove_recipe_from_cart",
  description:
    "Remove a recipe (selling group) from the basket, undoing picnic_add_recipe_to_cart. " +
    "Removes only that recipe's ingredients, leaving the rest of the cart untouched.",
  inputSchema: recipeRefInputSchema,
  annotations: CART_MUTATION_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    await mutateCart("Removing the recipe from the cart", () =>
      client.sendRequest(
        "POST",
        "/pages/task/remove-selling-group-from-basket",
        { payload: { selling_group_id: recipeId } },
        { includePicnicHeaders: true },
      ),
    )
    return { message: "Recipe removed from cart", recipeId }
  },
})

// Recipe meal-planning tools
const recipeIngredientsInputSchema = z.object({
  recipe_url_or_id: z
    .string()
    .min(1)
    .describe("A Picnic recipe URL (any format) or a 24- or 32-character hex recipe ID."),
})

async function fetchRecipeIngredientsByRef(
  client: ReturnType<typeof getPicnicClient>,
  recipeUrlOrId: string,
) {
  const recipeId = await resolveRecipeId(recipeUrlOrId)
  // picnic-api 5 reads the recipe page the way the app shows it. Names missing from the
  // ingredient tiles are looked up on the product pages; those extra requests can fail the
  // call, so fall back to the recipe without them rather than failing outright.
  let recipe: PicnicRecipe
  try {
    recipe = await client.recipe.getRecipe(recipeId, { resolveIngredientNames: true })
  } catch (error) {
    console.error(
      `[recipe ingredients] name lookup failed for ${recipeId}, retrying without: ${getErrorMessage(error)}`,
    )
    recipe = await client.recipe.getRecipe(recipeId)
  }
  return toStructuredRecipeIngredients(recipe)
}

type PicnicRecipe = PicnicClient.Types.recipe.Recipe

/** Maps the picnic-api 5 recipe model to the ingredient shape the meal-planning tools use. */
function toStructuredRecipeIngredients(recipe: PicnicRecipe): StructuredRecipeIngredients {
  return {
    recipeId: recipe.id,
    recipeName: recipe.name,
    portions: recipe.portions,
    ingredients: (recipe.ingredients ?? []).map((ingredient) => ({
      ingredientId: ingredient.ingredientId,
      sellingUnitId: ingredient.sellingUnitId,
      name: ingredient.name ?? "",
      packageInfo: ingredient.unitQuantity ?? "",
      priceCents: ingredient.price,
      quantity: ingredient.quantity,
      // Not selected by default when adding the recipe to the cart: cupboard staples and
      // long-keeping items (CUPBOARD / CORE_STOCKABLE).
      isPantryItem: !ingredient.checked,
      ...(ingredient.neededText && { needed: ingredient.neededText }),
      ...(!ingredient.isAvailable && { unavailable: true }),
    })),
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

toolRegistry.register({
  name: "picnic_get_recipe_ingredients",
  description:
    "Fetch structured Picnic recipe ingredients by recipe URL or ID. Returns selling-unit IDs, " +
    "quantities, pantry flags, package display text, and prices for meal planning.",
  inputSchema: recipeIngredientsInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    return fetchRecipeIngredientsByRef(getPicnicClient(), args.recipe_url_or_id)
  },
})

toolRegistry.register({
  name: "picnic_get_multiple_recipe_ingredients",
  description:
    "Fetch structured ingredient lists for multiple Picnic recipes. Returns successful recipes " +
    "and per-input errors so one unavailable recipe does not discard the whole batch.",
  inputSchema: z.object({
    recipe_urls_or_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .describe("Picnic recipe URLs or 24-/32-character recipe IDs, up to 20."),
  }),
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const results = await Promise.allSettled(
      args.recipe_urls_or_ids.map((input) => fetchRecipeIngredientsByRef(client, input)),
    )

    return {
      recipes: results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
      errors: results.flatMap((result, index) =>
        result.status === "rejected"
          ? [{ input: args.recipe_urls_or_ids[index], error: getErrorMessage(result.reason) }]
          : [],
      ),
    }
  },
})

const recipeIngredientSchema = z.object({
  ingredientId: z.string(),
  sellingUnitId: z.string(),
  name: z.string(),
  packageInfo: z.string(),
  priceCents: z.number().nullable(),
  quantity: z.number(),
  isPantryItem: z.boolean(),
})

const structuredRecipeIngredientsSchema = z.object({
  recipeId: z.string(),
  recipeName: z.string(),
  portions: z.number(),
  ingredients: z.array(recipeIngredientSchema),
})

toolRegistry.register({
  name: "picnic_build_shopping_list",
  description:
    "Consolidate structured recipe ingredients into a shopping list. Skips pantry items, " +
    "deduplicates products per recipe, and totals priceCents times quantity.",
  inputSchema: z.object({
    recipes: z.array(structuredRecipeIngredientsSchema).min(1).max(20),
  }),
  handler: async (args) => buildShoppingList(args.recipes),
})

toolRegistry.register({
  name: "picnic_find_meal_combinations",
  description:
    "Rank combinations of structured Picnic recipes by shared non-pantry ingredients, " +
    "using the same conservative cost calculation as picnic_build_shopping_list.",
  inputSchema: z.object({
    recipes: z.array(structuredRecipeIngredientsSchema).min(2).max(50),
    count: z.number().int().min(2).describe("Number of recipes per combination."),
    topK: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of combinations to return."),
    maxTotalBudgetCents: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Exclude combinations whose conservative shopping-list cost exceeds this."),
  }),
  handler: async (args) => findMealCombinations(args),
})

// Get shopping cart tool
toolRegistry.register({
  name: "picnic_get_cart",
  description: "Get the current shopping cart contents with filtered data",
  inputSchema: z.object({}),
  handler: async () => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const cart = await client.cart.getCart()
    return filterCartData(cart)
  },
})

// Add product to cart tool
const addToCartInputSchema = z.object({
  productId: z.string().describe("The ID of the product to add"),
  count: z.number().min(1).default(1).describe("Number of items to add"),
})

toolRegistry.register({
  name: "picnic_add_to_cart",
  description:
    "Add a product to the shopping cart. Not idempotent: each call adds another `count` " +
    "items. If this fails, call picnic_get_cart to check whether the add landed before retrying.",
  inputSchema: addToCartInputSchema,
  annotations: CART_MUTATION_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const cart = await mutateCart(`Adding ${args.count} item(s) to cart`, () =>
      client.cart.addProductToCart(args.productId, args.count),
    )
    return {
      message: `Added ${args.count} item(s) to cart`,
      cart: filterCartData(cart),
    }
  },
})

// Remove product from cart tool
const removeFromCartInputSchema = z.object({
  productId: z.string().describe("The ID of the product to remove"),
  count: z.number().min(1).default(1).describe("Number of items to remove"),
})

toolRegistry.register({
  name: "picnic_remove_from_cart",
  description:
    "Remove a product from the shopping cart. Not idempotent: each call removes another " +
    "`count` items. If this fails, call picnic_get_cart to check whether the removal landed " +
    "before retrying.",
  inputSchema: removeFromCartInputSchema,
  annotations: CART_MUTATION_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const cart = await mutateCart(`Removing ${args.count} item(s) from cart`, () =>
      client.cart.removeProductFromCart(args.productId, args.count),
    )
    return {
      message: `Removed ${args.count} item(s) from cart`,
      cart: filterCartData(cart),
    }
  },
})

// Clear cart tool
toolRegistry.register({
  name: "picnic_clear_cart",
  description: "Clear all items from the shopping cart",
  inputSchema: z.object({}),
  annotations: CART_MUTATION_ANNOTATIONS,
  handler: async () => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const cart = await mutateCart("Clearing the cart", () => client.cart.clearCart())
    return {
      message: "Shopping cart cleared",
      cart: filterCartData(cart),
    }
  },
})

// Get delivery slots tool
const deliverySlotsInputSchema = z.object({
  available_only: z
    .boolean()
    .default(true)
    .describe(
      "Only slots that can still be booked (default: true). The selected slot is always included.",
    ),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date like 2026-11-09")
    .optional()
    .describe("Only slots on this local delivery date (YYYY-MM-DD)."),
})

toolRegistry.register({
  name: "picnic_get_delivery_slots",
  description:
    "Get delivery time slots and the currently selected slot. By default only slots that can " +
    "still be booked; optionally for one day. Times are local with UTC offset, amounts in cents.",
  inputSchema: deliverySlotsInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const result = await client.cart.getDeliverySlots()
    const availableOnly = args.available_only ?? true

    const slots = (result.slots ?? []).filter(
      (slot) =>
        (!availableOnly || slot.isAvailable || slot.isSelected) &&
        // windowStart is local time with offset, e.g. 2026-11-09T15:00:00.000+01:00
        (!args.date || slot.windowStart.startsWith(args.date)),
    )

    return {
      filters: { available_only: availableOnly, ...(args.date && { date: args.date }) },
      selected_slot: result.selectedSlot
        ? {
            slot_id: result.selectedSlot.slotId,
            window_start: result.selectedSlot.windowStart,
            window_end: result.selectedSlot.windowEnd,
            explicitly_selected: result.selectedSlot.isExplicitSelection,
          }
        : null,
      slots: slots.map((slot) => ({
        slot_id: slot.slotId,
        window_start: slot.windowStart,
        window_end: slot.windowEnd,
        order_deadline: slot.cutOffTime,
        available: slot.isAvailable,
        ...(slot.isSelected && { selected: true }),
        ...(slot.isGreenChoice && { green_choice: true }),
        ...(slot.minimumOrderValue != null && { minimum_order_value: slot.minimumOrderValue }),
      })),
      total: slots.length,
      total_unfiltered: result.slots?.length ?? 0,
    }
  },
})

// Set delivery slot tool
const setDeliverySlotInputSchema = z.object({
  slotId: z.string().describe("The ID of the delivery slot to select"),
})

toolRegistry.register({
  name: "picnic_set_delivery_slot",
  description: "Select a delivery time slot",
  inputSchema: setDeliverySlotInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const result = await client.cart.setDeliverySlot(args.slotId)
    return {
      message: "Delivery slot selected",
      slotId: args.slotId,
      order: result,
    }
  },
})

// Get deliveries tool
const deliveriesInputSchema = z.object({
  filter: z.array(z.string()).default([]).describe("Filter deliveries by status"),
  limit: z
    .number()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of deliveries to return (1-50, default: 10)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of deliveries to skip for pagination (default: 0)"),
})

toolRegistry.register({
  name: "picnic_get_deliveries",
  description: "Get past and current deliveries with pagination",
  inputSchema: deliveriesInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const allDeliveries = await client.delivery.getDeliverySummaries(
      args.filter as PicnicDeliveryStatus[],
    )

    // Apply pagination
    const startIndex = args.offset || 0
    const limit = args.limit || 10
    // Picnic's summary leaves the item count at 0, so it is left out; picnic_get_delivery has
    // the products.
    const paginatedDeliveries = allDeliveries
      .slice(startIndex, startIndex + limit)
      .map((delivery) => ({
        id: delivery.id,
        status: delivery.status,
        creationTime: delivery.creationTime,
        windowStart: delivery.windowStart,
        windowEnd: delivery.windowEnd,
        orderCount: delivery.orderCount,
        totalPrice: delivery.totalPrice,
      }))

    return {
      deliveries: paginatedDeliveries,
      pagination: {
        offset: startIndex,
        limit,
        returned: paginatedDeliveries.length,
        total: allDeliveries.length,
        hasMore: startIndex + limit < allDeliveries.length,
      },
    }
  },
})

// Get specific delivery tool
const deliveryInputSchema = z.object({
  deliveryId: z.string().describe("The ID of the delivery to get details for"),
})

toolRegistry.register({
  name: "picnic_get_delivery",
  description: "Get details of a specific delivery",
  inputSchema: deliveryInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const delivery = await client.delivery.getDelivery(args.deliveryId)
    return filterDeliveryData(delivery)
  },
})

// Get delivery position tool
toolRegistry.register({
  name: "picnic_get_delivery_position",
  description: "Get real-time position data for a delivery",
  inputSchema: deliveryInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const position = await client.delivery.getDeliveryPosition(args.deliveryId)
    return position
  },
})

// Get delivery scenario tool
toolRegistry.register({
  name: "picnic_get_delivery_scenario",
  description:
    "Get driver and route information for a delivery that is on its way (not available for " +
    "upcoming or completed deliveries).",
  inputSchema: deliveryInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    try {
      return await client.delivery.getDeliveryRoute(args.deliveryId)
    } catch (error) {
      if (PicnicClient.isPicnicApiError(error) && error.status === 404) {
        throw new Error(
          `No driver/route information for delivery ${args.deliveryId}. Picnic only has it ` +
            "while the delivery is on its way, not for upcoming or completed deliveries.",
        )
      }
      throw error
    }
  },
})

// Cancel delivery tool
toolRegistry.register({
  name: "picnic_cancel_delivery",
  description: "Cancel a delivery order",
  inputSchema: deliveryInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const result = await client.delivery.cancelDelivery(args.deliveryId)
    return {
      message: "Delivery cancelled",
      deliveryId: args.deliveryId,
      result,
    }
  },
})

// Rate delivery tool
const rateDeliveryInputSchema = z.object({
  deliveryId: z.string().describe("The ID of the delivery to rate"),
  rating: z.number().min(0).max(10).describe("Rating from 0 to 10"),
})

toolRegistry.register({
  name: "picnic_rate_delivery",
  description: "Rate a completed delivery",
  inputSchema: rateDeliveryInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const result = await client.delivery.setDeliveryRating(args.deliveryId, args.rating)
    return {
      message: `Delivery rated ${args.rating}/10`,
      deliveryId: args.deliveryId,
      result,
    }
  },
})

// Send delivery invoice email tool
const sendInvoiceEmailInputSchema = z.object({
  deliveryId: z.string().describe("The ID of the delivery to send the invoice email for"),
})

toolRegistry.register({
  name: "picnic_send_delivery_invoice_email",
  description: "Send or resend the invoice email for a completed delivery",
  inputSchema: sendInvoiceEmailInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const result = await client.delivery.sendDeliveryInvoiceEmail(args.deliveryId)
    return {
      message: "Delivery invoice email sent",
      deliveryId: args.deliveryId,
      result,
    }
  },
})

// Get order status tool
const orderStatusInputSchema = z.object({
  orderId: z.string().describe("The ID of the order to get the status for"),
})

toolRegistry.register({
  name: "picnic_get_order_status",
  description: "Get the status of a specific order",
  inputSchema: orderStatusInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    return await client.checkout.getOrderStatus(args.orderId)
  },
})

// Get user details tool
toolRegistry.register({
  name: "picnic_get_user_details",
  description: "Get details of the current logged-in user",
  inputSchema: z.object({}),
  handler: async () => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const user = await client.user.getUser()
    return user
  },
})

// Get user info tool
toolRegistry.register({
  name: "picnic_get_user_info",
  description: "Get user information including toggled features",
  inputSchema: z.object({}),
  handler: async () => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const userInfo = await client.user.getUserInfo()
    return userInfo
  },
})

// Get payment profile tool
toolRegistry.register({
  name: "picnic_get_payment_profile",
  description: "Get payment information and profile",
  inputSchema: z.object({}),
  handler: async () => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const paymentProfile = await client.payment.getPaymentProfile()
    return paymentProfile
  },
})

// Get wallet transactions tool
const walletTransactionsInputSchema = z.object({
  pageNumber: z.number().min(1).default(1).describe("Page number for transaction history"),
})

toolRegistry.register({
  name: "picnic_get_wallet_transactions",
  description: "Get wallet transaction history",
  inputSchema: walletTransactionsInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const pageNumber = args.pageNumber ?? 1
    const transactions = await client.payment.getWalletTransactions(pageNumber)
    return {
      pageNumber,
      transactions,
    }
  },
})

// Get wallet transaction details tool
const walletTransactionDetailsInputSchema = z.object({
  transactionId: z.string().describe("The ID of the transaction to get details for"),
})

toolRegistry.register({
  name: "picnic_get_wallet_transaction_details",
  description: "Get detailed information about a specific wallet transaction",
  inputSchema: walletTransactionDetailsInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const details = await client.payment.getWalletTransaction(args.transactionId as string)
    return details
  },
})

// 2FA tools
const generate2FAInputSchema = z.object({
  channel: z.string().default("SMS").describe("Channel to send 2FA code (SMS, etc.)"),
})

toolRegistry.register({
  name: "picnic_generate_2fa_code",
  description: "Generate a 2FA code for verification",
  inputSchema: generate2FAInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const channel = args.channel || "SMS"
    try {
      const result = await client.auth.generate2FACode(channel)
      return {
        message: "2FA code generated and sent",
        channel,
        result,
      }
    } catch (error: unknown) {
      // The Picnic API returns empty bodies for 2FA endpoints, which causes JSON parse errors
      // but the actual request succeeds
      if (error instanceof SyntaxError && (error as Error).message.includes("JSON")) {
        return {
          message: "2FA code generated and sent",
          channel,
        }
      }
      throw error
    }
  },
})

const verify2FAInputSchema = z.object({
  code: z.string().describe("The 2FA code to verify"),
})

toolRegistry.register({
  name: "picnic_verify_2fa_code",
  description: "Verify a 2FA code",
  inputSchema: verify2FAInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    await verifyPicnic2FACode(args.code)
    await saveSession()

    return {
      message: "2FA code verified",
      code: args.code,
    }
  },
})
