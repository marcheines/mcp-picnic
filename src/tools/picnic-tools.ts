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
function toLineSummary(line: PicnicCartLine, quantityOverride?: number) {
  const quantity = quantityOverride ?? line.quantity ?? 1
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
 * Maps a list of cart or order lines, fixing the quantity of products that appear in more
 * than one line (e.g. once on its own and once for a recipe). Picnic then reports the
 * product's total count on every line; the line's own count is the number of unit ids it
 * joins, e.g. "643_644" holds 2 units.
 */
function toLineSummaries(lines: PicnicCartLine[]) {
  const linesPerProduct = new Map<string, number>()
  for (const line of lines) {
    linesPerProduct.set(line.productId, (linesPerProduct.get(line.productId) ?? 0) + 1)
  }
  return lines.map((line) =>
    (linesPerProduct.get(line.productId) ?? 0) > 1
      ? toLineSummary(line, String(line.id).split("_").filter(Boolean).length || 1)
      : toLineSummary(line),
  )
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
      items: toLineSummaries(order.items ?? []),
      // Amount paid for the order, including deposits and fees.
      total_price: order.checkoutTotalPrice,
      ...(order.promotionSavings ? { total_savings: order.promotionSavings } : {}),
      ...(order.payment?.paymentType && { payment_type: order.payment.paymentType }),
    })),
  }
}

type PicnicClientInstance = ReturnType<typeof getPicnicClient>

/** The narrowed delivery window Picnic shows in the app shortly before delivery. */
export type EtaWindow = { eta_window_start: string; eta_window_end: string }

/**
 * Reads Picnic's `eta2` field (`{ start, end }`) into an {@link EtaWindow}, or null when it is
 * missing or incomplete.
 */
export function toEtaWindow(eta2: unknown): EtaWindow | null {
  if (!eta2 || typeof eta2 !== "object") return null
  const { start, end } = eta2 as Record<string, unknown>
  if (typeof start !== "string" || !start || typeof end !== "string" || !end) return null
  return { eta_window_start: start, eta_window_end: end }
}

/**
 * Fetches the raw delivery (`/deliveries/{id}`), or null when the request fails. picnic-api's
 * Delivery model drops fields the tools need (the narrowed window `eta2`, products that could
 * not be delivered), so those are read from the raw answer. Failures are non-fatal: the
 * delivery is still returned without them.
 */
async function fetchRawDelivery(
  client: PicnicClientInstance,
  deliveryId: string,
): Promise<Record<string, unknown> | null> {
  try {
    return (
      (await client.sendRequest<null, Record<string, unknown>>(
        "GET",
        `/deliveries/${encodeURIComponent(deliveryId)}`,
      )) ?? null
    )
  } catch {
    return null
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const asRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.flatMap((v): Record<string, unknown>[] => {
        const r = asRecord(v)
        return r ? [r] : []
      })
    : []

/** A product of an order line that Picnic could not deliver, as the app shows it. */
export type DeliveryFailure = {
  /** Picnic's reasons, e.g. "PRODUCT_ABSENT", "PRODUCT_LOW_QUALITY", "PRODUCT_NOT_SHIPPED". */
  reasons: string[]
  /** How many units of the line failed (the number of failed article/unit ids). */
  failed_count: number
  /** The amount not charged for them in cents, when Picnic sends it. */
  refund?: number
}

/**
 * Reads the products Picnic could not deliver from a raw delivery, keyed by order id and then
 * order line id. Picnic marks them with an `ARTICLE_DELIVERY_FAILURES` decorator on the line,
 * on its article or in the order's `decorator_overrides` (keyed by line or article id).
 * picnic-api ignores that decorator, so without this a cancelled product looks delivered.
 */
export function readDeliveryFailures(
  rawDelivery: unknown,
): Map<string, Map<string, DeliveryFailure>> {
  const result = new Map<string, Map<string, DeliveryFailure>>()
  for (const order of asRecords(asRecord(rawDelivery)?.orders)) {
    const orderId = typeof order.id === "string" ? order.id : null
    if (!orderId) continue
    const overrides = asRecord(order.decorator_overrides) ?? {}
    const lines = new Map<string, DeliveryFailure>()

    for (const line of asRecords(order.items)) {
      const lineId = line.id == null ? null : String(line.id)
      if (!lineId) continue
      const articles = asRecords(line.items)
      const decorators = [
        ...asRecords(line.decorators),
        ...asRecords(overrides[lineId]),
        ...articles.flatMap((article) => [
          ...asRecords(article.decorators),
          ...(article.id == null ? [] : asRecords(overrides[String(article.id)])),
        ]),
      ].filter((decorator) => decorator.type === "ARTICLE_DELIVERY_FAILURES")

      const failures = new Map<string, string[]>()
      const prices = new Map<string, number>()
      for (const decorator of decorators) {
        for (const [key, reasons] of Object.entries(asRecord(decorator.failures) ?? {})) {
          const list = Array.isArray(reasons) ? reasons.filter((r) => typeof r === "string") : []
          if (list.length) failures.set(key, list)
        }
        for (const [key, price] of Object.entries(asRecord(decorator.prices) ?? {})) {
          if (typeof price === "number" && Number.isFinite(price)) prices.set(key, price)
        }
      }
      if (failures.size === 0) continue

      const refundKeys = [...prices.keys()].filter((key) => failures.has(key))
      lines.set(lineId, {
        reasons: [...new Set([...failures.values()].flat())],
        failed_count: failures.size,
        ...(refundKeys.length && {
          refund: refundKeys.reduce((sum, key) => sum + (prices.get(key) ?? 0), 0),
        }),
      })
    }
    if (lines.size) result.set(orderId, lines)
  }
  return result
}

/**
 * Adds the products that could not be delivered to a delivery from {@link filterDeliveryData}:
 * each affected order line gets `delivery_failure`, and the delivery a `not_delivered` summary.
 */
export function addDeliveryFailures(
  delivery: ReturnType<typeof filterDeliveryData>,
  failures: Map<string, Map<string, DeliveryFailure>>,
) {
  if (failures.size === 0) return delivery
  const notDelivered: Array<{ order_id: string; name: string } & DeliveryFailure> = []
  const orders = delivery.orders.map((order) => {
    const orderFailures = failures.get(order.order_id)
    if (!orderFailures) return order
    return {
      ...order,
      items: order.items.map((item) => {
        const failure = orderFailures.get(String(item.order_line_id))
        if (!failure) return item
        notDelivered.push({
          order_id: order.order_id,
          name: item.articles.map((article) => article.name).join(", "),
          ...failure,
        })
        return { ...item, delivery_failure: failure }
      }),
    }
  })
  return notDelivered.length ? { ...delivery, orders, not_delivered: notDelivered } : delivery
}

/**
 * Reads the products a wallet transaction refunded without a replacement (cancelled or missing
 * products) from the raw transaction. picnic-api only keeps refunds that have substitutions.
 */
export function readRefundedItems(rawTransaction: unknown) {
  const raw = asRecord(rawTransaction) ?? {}
  const names = new Map<string, string>()
  for (const line of asRecords(raw.shop_items)) {
    for (const article of asRecords(line.items)) {
      if (article.id != null && typeof article.name === "string") {
        names.set(String(article.id), article.name)
      }
    }
  }
  return asRecords(raw.article_issue_refunds)
    .filter((refund) => asRecords(refund.substitutions).length === 0)
    .map((refund) => {
      const articleId = refund.article_id == null ? null : String(refund.article_id)
      return {
        ...(articleId && { product_id: articleId }),
        name: (articleId && names.get(articleId)) || null,
        quantity: typeof refund.quantity === "number" ? refund.quantity : 1,
        ...(typeof refund.amount === "number" && { refund: refund.amount }),
        ...(typeof refund.reason === "string" && { reason: refund.reason }),
      }
    })
}

/**
 * Fetches the narrowed delivery windows of the delivery list, keyed by delivery id. Non-fatal,
 * like {@link fetchRawDelivery}.
 */
async function fetchEtaWindows(
  client: PicnicClientInstance,
  filter: PicnicDeliveryStatus[],
): Promise<Map<string, EtaWindow>> {
  const windows = new Map<string, EtaWindow>()
  try {
    const raw = await client.sendRequest<PicnicDeliveryStatus[], unknown>(
      "POST",
      "/deliveries/summary",
      filter,
    )
    for (const entry of Array.isArray(raw) ? raw : []) {
      const record = entry as Record<string, unknown>
      const window = toEtaWindow(record?.eta2)
      if (window && typeof record.delivery_id === "string") windows.set(record.delivery_id, window)
    }
  } catch {
    // Without the raw list the deliveries are still returned, just without the narrowed window.
  }
  return windows
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

  const items = toLineSummaries(cart.items ?? [])

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

/**
 * Reduces any product tile (favorites, categories, replacements) to what an LLM needs; the same
 * shape as the promotion products, with a promotion_label only when the tile has one.
 */
function toProductTile(tile: PicnicProductTile, section?: string) {
  return toPromotionProduct(tile, section)
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

// Favorites tool
const favoritesInputSchema = z.object({
  aisle_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "An aisle id from a previous call without aisle_id (e.g. 'DAIRY') to list all " +
        "favorites in that aisle. Omit for an overview of all aisles.",
    ),
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(50)
    .describe("With aisle_id: maximum number of products to return (1-100, default: 50)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("With aisle_id: number of products to skip for pagination (default: 0)"),
})

toolRegistry.register({
  name: "picnic_get_favorites",
  description:
    "Get the products the customer buys regularly ('Favoriten'), grouped by aisle in the " +
    "app's order. Without aisle_id it returns every aisle with the products the app shows " +
    "first; aisles with complete=false have more, which aisle_id lists. Prices in cents.",
  inputSchema: favoritesInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    if (args.aisle_id) {
      const products = await client.catalog.getFavoritesInAisle(args.aisle_id)
      const startIndex = args.offset || 0
      const limit = args.limit || 50
      const page = products.slice(startIndex, startIndex + limit).map((tile) => toProductTile(tile))
      return {
        aisle_id: args.aisle_id,
        products: page,
        pagination: {
          offset: startIndex,
          limit,
          returned: page.length,
          total: products.length,
          hasMore: startIndex + limit < products.length,
        },
      }
    }
    const favorites = await client.catalog.getFavorites()
    return {
      aisles: (favorites.aisles ?? []).map((aisle) => ({
        aisle_id: aisle.id,
        title: aisle.title,
        complete: aisle.complete,
        products: (aisle.products ?? []).map((tile) => toProductTile(tile)),
      })),
    }
  },
})

// Category tools
type PicnicCategoryLink = PicnicClient.Types.catalog.CategoryLink

/** Reduces a category link to its name, label and what it opens. */
function toCategoryLink(link: PicnicCategoryLink) {
  const target = link.target
  return {
    name: link.name,
    ...(link.label && { label: link.label }),
    // "subcategories": open with picnic_get_categories; "products"/"promotions": with
    // picnic_get_category_products (promotions_only for "promotions").
    opens: target.type,
    ...("categoryId" in target && { category_id: target.categoryId }),
  }
}

const categoriesInputSchema = z.object({
  category_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "A category_id whose link opens 'subcategories', to list them. Omit for the top-level " +
        "category tree.",
    ),
})

toolRegistry.register({
  name: "picnic_get_categories",
  description:
    "Browse Picnic's assortment like the app's category tab. Without category_id it returns " +
    "the top-level categories; with one, its subcategories. Each entry says what it opens: " +
    "'subcategories' (call this tool again), 'products' or 'promotions' (call " +
    "picnic_get_category_products).",
  inputSchema: categoriesInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    if (args.category_id) {
      const subcategories = await client.catalog.getSubcategories(args.category_id)
      return {
        category_id: subcategories.categoryId,
        title: subcategories.title,
        categories: (subcategories.links ?? [])
          .filter((link) => link.target.type !== "page")
          .map(toCategoryLink),
      }
    }
    const sections = await client.catalog.getCategories()
    return {
      sections: sections.map((section) => ({
        ...(section.title && { title: section.title }),
        categories: (section.links ?? [])
          .filter((link) => link.target.type !== "page")
          .map(toCategoryLink),
      })),
    }
  },
})

const categoryProductsInputSchema = z.object({
  category_id: z
    .string()
    .trim()
    .min(1)
    .describe("A category_id from picnic_get_categories whose link opens products or promotions"),
  promotions_only: z
    .boolean()
    .default(false)
    .describe("Only the category's promotions (for links that open 'promotions')"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(25)
    .describe("Maximum number of products to return (1-100, default: 25)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of products to skip for pagination (default: 0)"),
})

toolRegistry.register({
  name: "picnic_get_category_products",
  description:
    "List the products of a category from picnic_get_categories, or only its promotions. " +
    "Products appear once, with the section they are listed under. Prices in cents.",
  inputSchema: categoryProductsInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const result = args.promotions_only
      ? await client.catalog.getCategoryPromotions(args.category_id)
      : await client.catalog.getCategoryProducts(args.category_id)
    const seen = new Set<string>()
    const all = (result.results?.sections ?? []).flatMap((section) =>
      (section.products ?? [])
        .filter((tile) => {
          if (seen.has(tile.id)) return false
          seen.add(tile.id)
          return true
        })
        .map((tile) => toProductTile(tile, section.title ?? undefined)),
    )
    const startIndex = args.offset || 0
    const limit = args.limit || 25
    const page = all.slice(startIndex, startIndex + limit)
    return {
      category_id: result.categoryId,
      title: result.title,
      products: page,
      pagination: {
        offset: startIndex,
        limit,
        returned: page.length,
        total: all.length,
        hasMore: startIndex + limit < all.length,
      },
    }
  },
})

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

// Edit, delete and illustrate own (user-defined) recipes
const OWN_RECIPE_ID_RE = /^[0-9a-f]{32}$/i

const ownRecipeIdSchema = z
  .string()
  .trim()
  .regex(
    OWN_RECIPE_ID_RE,
    "Expected a 32-character own-recipe id (from picnic_get_own_recipes or picnic_create_recipe)",
  )
  .describe("Id of an own recipe (32 hex characters), from picnic_get_own_recipes.")

const productIdSchema = z
  .string()
  .regex(PICNIC_PRODUCT_ID_RE, "Expected a Picnic product id such as s1018231")

const updateRecipeInputSchema = z.object({
  recipe_id: ownRecipeIdSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .max(OWN_RECIPE_NAME_MAX)
    .optional()
    .describe(`New recipe name (max ${OWN_RECIPE_NAME_MAX} characters).`),
  portions: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("New default number of portions. Ingredient quantities are not rescaled."),
  note: z
    .string()
    .max(OWN_RECIPE_NOTE_MAX)
    .optional()
    .describe("Replaces the note (plain text, each line a paragraph). An empty string deletes it."),
  add_ingredients: z
    .array(
      z.object({
        product_id: productIdSchema.describe("Picnic product id from picnic_search."),
        quantity: z.number().int().min(1).default(1).describe("Number of packages."),
      }),
    )
    .optional()
    .describe("Products to add as new ingredients."),
  update_ingredients: z
    .array(
      z.object({
        product_id: productIdSchema.describe("Product id of an ingredient already in the recipe."),
        quantity: z.number().int().min(1).describe("New number of packages."),
      }),
    )
    .optional()
    .describe("Change the package count of ingredients in the recipe."),
  replace_ingredients: z
    .array(
      z.object({
        product_id: productIdSchema.describe("Product id of an ingredient in the recipe."),
        new_product_id: productIdSchema.describe("Product id to use instead, from picnic_search."),
        quantity: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Number of packages of the new product (default: the old quantity)."),
      }),
    )
    .optional()
    .describe(
      "Swap ingredients for other products. Picnic lists the new product at the end of the " +
        "ingredients.",
    ),
  remove_ingredients: z
    .array(productIdSchema)
    .optional()
    .describe("Product ids of ingredients to remove from the recipe."),
})

type UpdateRecipeArgs = z.input<typeof updateRecipeInputSchema>

/** Fails when the same product is targeted by more than one ingredient operation. */
function assertDistinctIngredientTargets(args: UpdateRecipeArgs): void {
  const targets = [
    ...(args.update_ingredients ?? []).map((i) => i.product_id),
    ...(args.replace_ingredients ?? []).map((i) => i.product_id),
    ...(args.remove_ingredients ?? []),
  ]
  const added = [
    ...(args.add_ingredients ?? []).map((i) => i.product_id),
    ...(args.replace_ingredients ?? []).map((i) => i.new_product_id),
  ]
  for (const list of [targets, added]) {
    const duplicates = list.filter((id, index) => list.indexOf(id) !== index)
    if (duplicates.length > 0) {
      throw new Error(
        `Each product may appear in only one operation: ${[...new Set(duplicates)].join(", ")}`,
      )
    }
  }
}

toolRegistry.register({
  name: "picnic_update_recipe",
  description:
    "Edit an own recipe: rename it, change its default portions, replace or delete its note, " +
    "and add, re-quantify, swap or remove ingredients (identified by product id). Do not use it " +
    "to work around products that are temporarily unavailable: the recipe keeps its original " +
    "products, replacements belong in the cart. Everything is " +
    "checked before the first change; if a step fails, the result lists what was already done. " +
    "If the recipe is in the cart, the cart keeps its old ingredients except for quantity " +
    "changes; add the recipe to the cart again to pick up added or swapped products.",
  inputSchema: updateRecipeInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    assertDistinctIngredientTargets(args)
    const hasChange =
      args.name !== undefined ||
      args.portions !== undefined ||
      args.note !== undefined ||
      (args.add_ingredients?.length ?? 0) > 0 ||
      (args.update_ingredients?.length ?? 0) > 0 ||
      (args.replace_ingredients?.length ?? 0) > 0 ||
      (args.remove_ingredients?.length ?? 0) > 0
    if (!hasChange) throw new Error("Nothing to change: pass at least one field to update.")

    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = args.recipe_id.toLowerCase()

    // Check everything before the first write.
    const recipe = await client.recipe.getRecipe(recipeId)
    if (!recipe.isRecipeOwner) {
      throw new Error(`Recipe ${recipeId} is not one of your own recipes and cannot be edited.`)
    }
    const ingredients = recipe.ingredients ?? []
    const byProduct = new Map(
      ingredients.map((ingredient, index) => [ingredient.sellingUnitId, { ingredient, index }]),
    )
    const findIngredient = (productId: string) => {
      const found = byProduct.get(productId)
      if (!found) {
        const inRecipe = ingredients.map((i) => i.sellingUnitId).join(", ") || "none"
        throw new Error(
          `Product ${productId} is not an ingredient of this recipe (ingredients: ${inRecipe}).`,
        )
      }
      return found
    }
    const updates = (args.update_ingredients ?? []).map((u) => ({
      ...u,
      ...findIngredient(u.product_id),
    }))
    const replacements = (args.replace_ingredients ?? []).map((r) => ({
      ...r,
      ...findIngredient(r.product_id),
    }))
    const removals = (args.remove_ingredients ?? []).map((productId) => ({
      productId,
      ...findIngredient(productId),
    }))
    const replacedOrRemoved = new Set([
      ...replacements.map((r) => r.product_id),
      ...removals.map((r) => r.productId),
    ])
    for (const added of [
      ...(args.add_ingredients ?? []).map((a) => a.product_id),
      ...replacements.map((r) => r.new_product_id),
    ]) {
      if (byProduct.has(added) && !replacedOrRemoved.has(added)) {
        throw new Error(
          `Product ${added} is already an ingredient; use update_ingredients to change its quantity.`,
        )
      }
    }
    const noteHtml = args.note ? noteToPicnicHtml(args.note) : ""
    if (args.note !== undefined && args.note.trim() && !noteHtml) {
      throw new Error("The note contains no text.")
    }

    const portions = recipe.defaultPortions || recipe.portions || 4
    const done: string[] = []
    const run = async (label: string, action: () => Promise<unknown>) => {
      try {
        await action()
        done.push(label)
      } catch (error) {
        throw new Error(
          `Step "${label}" failed: ${getErrorMessage(error)}. ` +
            (done.length > 0 ? `Already done: ${done.join("; ")}.` : "Nothing was changed."),
        )
      }
    }

    if (args.name !== undefined && args.name !== recipe.name) {
      const name = args.name
      await run(`renamed to "${name}"`, () => client.recipe.renameUserDefinedRecipe(recipeId, name))
    }
    for (const u of updates) {
      await run(`set ${u.product_id} to ${u.quantity}`, async () => {
        // Same product, new quantity: the app sends this as a change within the ingredient.
        const selection = {
          quantities: { [u.product_id]: u.quantity },
          portions,
          swapType: "WITHIN_SELLING_GROUP_COMPONENT" as const,
        }
        const result = await client.recipe.updateRecipeIngredient(
          recipeId,
          u.ingredient.ingredientId,
          selection,
        )
        if (result?.shouldUpdateCart) {
          await client.recipe.updateRecipeIngredientInCart(
            recipeId,
            u.ingredient.ingredientId,
            selection,
          )
        }
      })
    }
    // Remove before adding, so a removed product can be added back and positions stay sensible.
    for (const r of removals) {
      await run(`removed ${r.productId}`, () =>
        client.recipe.removeRecipeIngredient(recipeId, r.ingredient.ingredientId),
      )
    }
    for (const r of replacements) {
      const quantity = r.quantity ?? r.ingredient.quantity ?? 1
      await run(`replaced ${r.product_id} with ${r.new_product_id}`, async () => {
        await client.recipe.removeRecipeIngredient(recipeId, r.ingredient.ingredientId)
        await client.recipe.addUserDefinedRecipeIngredient(recipeId, r.new_product_id, {
          quantity,
          portions,
          order: r.index,
        })
      })
    }
    let order = ingredients.length - removals.length
    for (const a of args.add_ingredients ?? []) {
      const position = order++
      await run(`added ${a.product_id}`, () =>
        client.recipe.addUserDefinedRecipeIngredient(recipeId, a.product_id, {
          quantity: a.quantity ?? 1,
          portions,
          order: position,
        }),
      )
    }
    if (args.note !== undefined) {
      if (noteHtml) {
        await run("note replaced", () => client.recipe.setUserDefinedRecipeNote(recipeId, noteHtml))
      } else {
        await run("note deleted", () => client.recipe.deleteUserDefinedRecipeNote(recipeId))
      }
    }
    // Portions last: the ingredient quantities above refer to the old default portions.
    if (args.portions !== undefined && args.portions !== recipe.defaultPortions) {
      const newPortions = args.portions
      await run(`portions set to ${newPortions}`, () =>
        client.recipe.updateUserDefinedRecipePortions(recipeId, newPortions),
      )
    }

    return {
      message: done.length > 0 ? "Recipe updated" : "Nothing changed: the recipe already matched",
      recipeId,
      changes: done,
    }
  },
})

toolRegistry.register({
  name: "picnic_delete_recipe",
  description:
    "Permanently delete an own recipe from the Picnic cookbook. Like the app, it first removes " +
    "the recipe and its ingredients from the cart, unless keep_in_cart is true. Cannot be undone.",
  inputSchema: z.object({
    recipe_id: ownRecipeIdSchema,
    keep_in_cart: z
      .boolean()
      .default(false)
      .describe("Leave the recipe's ingredients in the cart (default: false)."),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = args.recipe_id.toLowerCase()

    const recipe = await client.recipe.getRecipe(recipeId)
    if (!recipe.isRecipeOwner) {
      throw new Error(`Recipe ${recipeId} is not one of your own recipes and cannot be deleted.`)
    }

    let removedFromCart = false
    if (!args.keep_in_cart) {
      const cart = await client.cart.getCart()
      if ((cart.recipes ?? []).some((r) => r.id === recipeId)) {
        await client.recipe.removeRecipeFromCart(recipeId)
        removedFromCart = true
      }
    }
    await client.recipe.deleteUserDefinedRecipe(recipeId)
    return { message: "Recipe deleted", recipeId, name: recipe.name, removedFromCart }
  },
})

// Recipe images
toolRegistry.register({
  name: "picnic_get_recipe_image_suggestions",
  description:
    "List the images Picnic suggests for an own recipe (taken from similar Picnic recipes), " +
    "with preview URLs. Pass an image_id to picnic_set_recipe_image to use it.",
  inputSchema: z.object({ recipe_id: ownRecipeIdSchema }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = args.recipe_id.toLowerCase()
    const suggestions = await client.recipe.getUserDefinedRecipeSuggestedImages(recipeId)
    const base = recipeImageBaseUrl(client)
    return {
      recipeId,
      images: suggestions.map((s) => ({
        image_id: s.id,
        preview_url: `${base}/${s.referenceImage.namespace || "recipes"}/${s.id}/large.png`,
      })),
    }
  },
})

const RECIPE_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const RECIPE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"])

/** Rejects URLs that point at the server itself or a private network. */
function assertPublicHttpsUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("image_url is not a valid URL.")
  }
  if (url.protocol !== "https:") throw new Error("image_url must use https.")
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  const isPrivate =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".railway.internal") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "::1" ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host)
  if (isPrivate) throw new Error("image_url must point to a public host.")
  return url
}

/** Downloads an image for upload, enforcing type and size limits. */
async function downloadRecipeImage(raw: string): Promise<{ data: Uint8Array; type: string }> {
  const url = assertPublicHttpsUrl(raw)
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Downloading the image failed with HTTP ${response.status}.`)
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
  if (!RECIPE_IMAGE_TYPES.has(type)) {
    throw new Error(`The image must be JPEG, PNG or WebP (got ${type || "unknown type"}).`)
  }
  const length = Number(response.headers.get("content-length") ?? 0)
  if (length > RECIPE_IMAGE_MAX_BYTES) throw new Error("The image is larger than 5 MB.")
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength > RECIPE_IMAGE_MAX_BYTES) throw new Error("The image is larger than 5 MB.")
  if (data.byteLength === 0) throw new Error("The downloaded image is empty.")
  return { data, type }
}

toolRegistry.register({
  name: "picnic_set_recipe_image",
  description:
    "Set the image of an own recipe: either one of Picnic's suggestions (image_id from " +
    "picnic_get_recipe_image_suggestions) or an own JPEG/PNG/WebP image downloaded from a " +
    "public https URL (max 5 MB), which is uploaded to Picnic. Pass exactly one of the two.",
  inputSchema: z.object({
    recipe_id: ownRecipeIdSchema,
    image_id: z.string().trim().min(1).optional().describe("A suggested image id."),
    image_url: z.string().trim().url().optional().describe("Public https URL of an own image."),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    if (Boolean(args.image_id) === Boolean(args.image_url)) {
      throw new Error("Pass exactly one of image_id or image_url.")
    }
    // Validate and download before touching the recipe.
    const download = args.image_url ? await downloadRecipeImage(args.image_url) : null

    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = args.recipe_id.toLowerCase()

    if (download) {
      const uploaded = await client.recipe.uploadUserDefinedRecipeImage(recipeId, download)
      const imageId = uploaded?.image_id ?? uploaded?.imageId
      if (!imageId) throw new Error("Picnic accepted the upload but returned no image id.")
      await client.recipe.selectUserDefinedRecipeImage(recipeId, imageId)
      return {
        message: "Own image uploaded and set",
        recipeId,
        imageId,
        bytes: download.data.byteLength,
      }
    }

    const suggestions = await client.recipe.getUserDefinedRecipeSuggestedImages(recipeId)
    const suggestion = suggestions.find((s) => s.id === args.image_id)
    if (!suggestion) {
      throw new Error(
        `Image ${args.image_id} is not among the current suggestions; call ` +
          "picnic_get_recipe_image_suggestions for valid ids.",
      )
    }
    await client.recipe.selectUserDefinedRecipeImage(
      recipeId,
      suggestion.id,
      suggestion.referenceImage,
    )
    return { message: "Suggested image set", recipeId, imageId: suggestion.id }
  },
})

// Recipe home page (the app's recipe tab), with rows such as "Nochmal bestellen"
toolRegistry.register({
  name: "picnic_get_recipe_overview",
  description:
    "Get the rows of recipes on the start page of the Picnic app's recipe tab, e.g. recipes to " +
    "order again, featured or personal recommendations, as the app shows them. Each row has a " +
    "title, the selected filter (e.g. 'Nochmal bestellen') and recipes (id, name, subtitle, " +
    "tags such as cooking time). Optionally filter rows by title or filter. Use the recipe id " +
    "with picnic_get_recipe or picnic_get_recipe_ingredients.",
  inputSchema: z.object({
    section: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Only rows whose title or selected filter contains this text (case-insensitive), " +
          "e.g. 'Nochmal' for the 'Nochmal bestellen' filter of the 'Favoriten' row. Omit " +
          "for all rows; the response always lists all rows with their filters.",
      ),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const overview = await client.recipe.getRecipeOverview()
    const base = recipeImageBaseUrl(client)
    const allSections = overview.sections ?? []
    const filter = args.section?.toLocaleLowerCase("de")
    // The app shows one filter (pill) per row, e.g. "Nochmal bestellen" in the "Favoriten" row.
    const matches = (text: string | null | undefined) =>
      Boolean(filter && text?.toLocaleLowerCase("de").includes(filter))
    const sections = filter
      ? allSections.filter((section) => matches(section.title) || matches(section.pill))
      : allSections

    return {
      ...(args.section && { section_filter: args.section }),
      rows: allSections.map((section) => ({
        title: section.title,
        ...(section.pill && { filter: section.pill }),
      })),
      sections: sections.map((section) => ({
        title: section.title,
        ...(section.pill && { filter: section.pill }),
        recipes: (section.recipes ?? []).map((recipe) => ({
          recipeId: recipe.id,
          name: recipe.name,
          ...(recipe.subtitle && { subtitle: recipe.subtitle }),
          ...(recipe.tags?.length && { tags: recipe.tags }),
          ...(recipe.cookingTimeMinutes != null && {
            cookingTimeMinutes: recipe.cookingTimeMinutes,
          }),
          ...(recipe.imageId && { imageUrl: `${base}/${recipe.imageId}/large.png` }),
          sourceUrl: buildRecipeSourceUrl(config.PICNIC_COUNTRY_CODE, recipe.id),
        })),
      })),
    }
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
    "to the basket. Optionally set the number of portions. The result lists ingredients that " +
    "are not available for the selected delivery: replace those in the cart (picnic_search, " +
    "picnic_add_to_cart, picnic_remove_from_cart) and leave the recipe itself unchanged. If " +
    "this fails, call picnic_get_cart to check whether the ingredients landed before retrying.",
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
    // Report what Picnic cannot deliver, so it can be replaced in the cart. Best effort: the
    // recipe is in the cart already, so a failing check must not turn into an error.
    let unavailable: Array<{ product_id: string; name: string; reason?: string }> | undefined
    try {
      const cart = await client.cart.getCart()
      unavailable = (cart.items ?? [])
        .filter((line) => line.recipeId === recipeId && line.isUnavailable)
        .map((line) => ({
          product_id: line.productId,
          name: line.name,
          ...(line.unavailableReason && { reason: line.unavailableReason }),
        }))
    } catch (error) {
      console.error(`[add recipe to cart] availability check failed: ${getErrorMessage(error)}`)
    }

    return {
      message: "Recipe added to cart",
      recipeId,
      ...(args.portions !== undefined && { portions: args.portions }),
      ...(unavailable?.length && {
        unavailable_ingredients: unavailable,
        hint:
          "These ingredients will not be delivered. Replace them in the cart with available " +
          "products; keep the recipe's original ingredients.",
      }),
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

const recipePortionsInCartInputSchema = recipeRefInputSchema.extend({
  portions: z.number().int().min(1).max(20).describe("The new number of portions"),
  day_offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Which delivery day the recipe is planned for, relative to the selected slot " +
        "(default: 0, the selected delivery)",
    ),
})

toolRegistry.register({
  name: "picnic_update_recipe_portions_in_cart",
  description:
    "Change the number of portions of a recipe that is already in the cart; Picnic scales " +
    "its ingredients. Call picnic_get_cart afterwards to see the new quantities.",
  inputSchema: recipePortionsInCartInputSchema,
  annotations: CART_MUTATION_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    await mutateCart("Changing the recipe's portions", () =>
      client.recipe.updateRecipePortionsInCart(recipeId, {
        dayOffset: args.day_offset ?? 0,
        portions: args.portions,
      }),
    )
    return { message: `Recipe set to ${args.portions} portion(s)`, recipeId }
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

// Replacements for unavailable cart products
const replacementsInputSchema = z.object({
  productId: z
    .string()
    .trim()
    .min(1)
    .describe("The id of a cart product marked unavailable in picnic_get_cart"),
})

toolRegistry.register({
  name: "picnic_get_replacements",
  description:
    "Get the products Picnic suggests instead of a cart product that can't be delivered " +
    "(unavailable in picnic_get_cart), in the app's order. Swap with picnic_remove_from_cart " +
    "and picnic_add_to_cart. Prices in cents.",
  inputSchema: replacementsInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const result = await client.cart.getReplacements(args.productId)
    return {
      product_id: result.productId,
      ...(result.reason && { reason: result.reason }),
      replacements: (result.replacements ?? []).map((tile) => toProductTile(tile)),
    }
  },
})

// Minimum order value tool
toolRegistry.register({
  name: "picnic_get_minimum_order_value",
  description:
    "Get the minimum order value (in cents) for the currently selected delivery slot. " +
    "A slot must be selected first (picnic_set_delivery_slot).",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async () => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    try {
      return await client.cart.getMinimumOrderValue()
    } catch (error) {
      // Picnic answers with a 500 when no slot is selected.
      if (PicnicClient.isPicnicApiError(error) && error.status === 500) {
        throw new Error(
          "Picnic has no minimum order value without a selected delivery slot. Select one " +
            "with picnic_set_delivery_slot first.",
        )
      }
      throw error
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
  description:
    "Get past and current deliveries with pagination. windowStart/windowEnd is the booked " +
    "slot; for upcoming deliveries etaWindowStart/etaWindowEnd is the narrower window the " +
    "app shows once Picnic has planned the route (absent until then).",
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
    const page = allDeliveries.slice(startIndex, startIndex + limit)
    // Only deliveries that are still coming can have a narrowed window.
    const etaWindows = page.some((delivery) => delivery.status === "CURRENT")
      ? await fetchEtaWindows(client, (args.filter ?? []) as PicnicDeliveryStatus[])
      : new Map<string, EtaWindow>()
    const paginatedDeliveries = page.map((delivery) => {
      const eta = delivery.status === "CURRENT" ? etaWindows.get(delivery.id) : undefined
      return {
        id: delivery.id,
        status: delivery.status,
        creationTime: delivery.creationTime,
        windowStart: delivery.windowStart,
        windowEnd: delivery.windowEnd,
        ...(eta && { etaWindowStart: eta.eta_window_start, etaWindowEnd: eta.eta_window_end }),
        orderCount: delivery.orderCount,
        totalPrice: delivery.totalPrice,
      }
    })

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
  description:
    "Get details of a specific delivery. window_start/window_end is the booked slot; " +
    "eta_window_start/eta_window_end is the narrower window the app shows once Picnic has " +
    "planned the route (absent until then). Products Picnic could not deliver (cancelled, " +
    "missing or rejected for quality) carry delivery_failure with the reasons and the amount " +
    "not charged, and are listed in not_delivered.",
  inputSchema: deliveryInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const [delivery, raw] = await Promise.all([
      client.delivery.getDelivery(args.deliveryId),
      fetchRawDelivery(client, args.deliveryId),
    ])
    const eta = toEtaWindow(raw?.eta2)
    const { id, status, window_start, window_end, ...rest } = addDeliveryFailures(
      filterDeliveryData(delivery),
      readDeliveryFailures(raw),
    )
    return {
      id,
      status,
      window_start,
      window_end,
      ...(status === "CURRENT" && eta),
      ...rest,
    }
  },
})

/** True for the parse error picnic-api throws when Picnic answers with an empty body. */
function isEmptyResponseError(error: unknown): boolean {
  return error instanceof SyntaxError && /JSON/i.test(error.message)
}

// Get delivery position tool
toolRegistry.register({
  name: "picnic_get_delivery_position",
  description:
    "Get real-time position data for a delivery that is on its way: expected arrival (eta, " +
    "epoch ms) and its window. Before the driver leaves Picnic has no position; then " +
    "inProgress is false — use picnic_get_delivery for the planned window.",
  inputSchema: deliveryInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    try {
      return await client.delivery.getDeliveryPosition(args.deliveryId)
    } catch (error) {
      const notFound = PicnicClient.isPicnicApiError(error) && error.status === 404
      if (isEmptyResponseError(error) || notFound) {
        return {
          inProgress: false,
          message:
            `No live position for delivery ${args.deliveryId} yet. Picnic only has one while ` +
            "the driver is on the way; picnic_get_delivery has the planned delivery window.",
        }
      }
      throw error
    }
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
  description:
    "Get detailed information about a specific wallet transaction. Products refunded without " +
    "a replacement (cancelled or missing) are listed in refunded_items; substituted ones in " +
    "substitutions.",
  inputSchema: walletTransactionDetailsInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const transactionId = args.transactionId as string
    const [details, raw] = await Promise.all([
      client.payment.getWalletTransaction(transactionId),
      client
        .sendRequest<
          null,
          unknown
        >("GET", `/wallet/transactions/${encodeURIComponent(transactionId)}`)
        .catch(() => null),
    ])
    const refundedItems = readRefundedItems(raw)
    return refundedItems.length ? { ...details, refunded_items: refundedItems } : details
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
