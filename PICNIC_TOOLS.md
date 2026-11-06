# Picnic API MCP Tools

This MCP server provides tools to interact with the Picnic online supermarket API. The tools are based on the unofficial [picnic-api](https://github.com/MRVDH/picnic-api) Node.js package.

## Available Tools

### Authentication

**Note:** Authentication is handled automatically using environment variables (`PICNIC_USERNAME` and `PICNIC_PASSWORD`). No manual login is required.

#### `picnic_generate_2fa_code`

Generate a 2FA code for verification.

**Parameters:**

- `channel` (string, optional): Channel to send 2FA code (default: "SMS")

#### `picnic_verify_2fa_code`

Verify a 2FA code.

**Parameters:**

- `code` (string): The 2FA code to verify

### Product Search & Information

#### `picnic_search`

Search for products in Picnic.

**Parameters:**

- `query` (string): Search query for products
- `limit` (number, optional): Maximum number of results to return (1-20, default: 5)
- `offset` (number, optional): Number of results to skip for pagination (default: 0)

#### `picnic_get_promotions`

Get Picnic's current promotions/deals from the app's promotions page (via picnic-api's
`catalog.getPromotions`).

**Parameters:**

- `section` (string, optional): Only sections whose title contains this text (case-insensitive), e.g. `Fleisch`
- `include_groups` (boolean, optional): Include promotion groups (default: true)
- `limit` (number, optional): Maximum number of promoted products to return (1-100, default: 25)
- `offset` (number, optional): Number of promoted products to skip for pagination (default: 0)

**Returns:** The page's sections (title, product and group counts); promoted products, each listed
once, with product ID, name, brand, current price, original price, promotion label, unit, unit
price, section and image ID (prices in cents); promotion groups (deals on several products) with
their group ID; and pagination metadata.

#### `picnic_get_promotion_group`

List the products of a promotion group, e.g. "20% auf Alpro".

**Parameters:**

- `group_id` (string, required): Group ID from `promotion_groups` of `picnic_get_promotions`

**Returns:** Group ID, name and its products with the same fields as `picnic_get_promotions`.

#### `picnic_get_suggestions`

Get product suggestions based on a query.

**Parameters:**

- `query` (string): Query for product suggestions

#### `picnic_get_product_details`

Look up product details by selling unit ID.

**Parameters:**

- `productId` (string): The product selling unit ID returned by search or cart
- `full` (boolean, optional): Return full product details, including description, allergens, nutritional info, promotions, and similar products

#### `picnic_get_image`

Get product image data.

**Parameters:**

- `imageId` (string): The image ID returned by search, cart, or product details
- `size` (string): Image size (`tiny`, `small`, `medium`, `large`, or `extra-large`)

### Removed Legacy Product Tools

#### ~~`picnic_get_article`~~ (REMOVED)

**This tool has been removed** because the Picnic API deprecated product detail endpoints. See [GitHub issue #23](https://github.com/MRVDH/picnic-api/issues/23).

**Alternative:** Use `picnic_get_product_details` for product details or `picnic_search` for basic product information (id, name, price, unit).

#### ~~`picnic_get_categories`~~ (REMOVED)

**This tool is not available** because `picnic-api` v4 removed the underlying `getCategories()` function. Category browsing would require a new Fusion page implementation.

### Shopping Cart Management

#### `picnic_get_cart`

Get the current shopping cart contents.

#### `picnic_add_to_cart`

Add a product to the shopping cart.

**Parameters:**

- `productId` (string): The ID of the product to add
- `count` (number, optional): Number of items to add (default: 1)

#### `picnic_remove_from_cart`

Remove a product from the shopping cart.

**Parameters:**

- `productId` (string): The ID of the product to remove
- `count` (number, optional): Number of items to remove (default: 1)

#### `picnic_clear_cart`

Clear all items from the shopping cart.

### Delivery Management

#### `picnic_get_delivery_slots`

Get delivery time slots and the selected slot.

**Parameters:**

- `available_only` (boolean, optional): Only slots that can still be booked (default: true); the selected slot is always included
- `date` (string, optional): Only slots on this local date (`YYYY-MM-DD`)

**Returns:** The selected slot, the matching slots (ID, window, order deadline, availability, green choice, minimum order value in cents) and the counts with and without filters.

#### `picnic_set_delivery_slot`

Select a delivery time slot.

**Parameters:**

- `slotId` (string): The ID of the delivery slot to select

#### `picnic_get_deliveries`

Get past and current deliveries.

**Parameters:**

- `filter` (array of strings, optional): Filter deliveries by status
- `limit` / `offset` (number, optional): Pagination

**Returns:** ID, status, creation time, delivery window, number of orders and total price in cents per delivery. Use `picnic_get_delivery` for the products.

#### `picnic_get_delivery`

Get details of a specific delivery.

**Parameters:**

- `deliveryId` (string): The ID of the delivery to get details for

**Returns:** Status, window, totals, returned containers and per order the products (same shape as the cart lines), amount paid and payment type. Amounts in cents.

#### `picnic_get_delivery_position`

Get real-time position data for a delivery.

**Parameters:**

- `deliveryId` (string): The ID of the delivery to get position for

#### `picnic_get_delivery_scenario`

Get driver and route information for a delivery.

**Parameters:**

- `deliveryId` (string): The ID of the delivery to get scenario for

#### `picnic_cancel_delivery`

Cancel a delivery order.

**Parameters:**

- `deliveryId` (string): The ID of the delivery to cancel

#### `picnic_rate_delivery`

Rate a completed delivery.

**Parameters:**

- `deliveryId` (string): The ID of the delivery to rate
- `rating` (number): Rating from 0 to 10

### User Information

#### `picnic_get_user_details`

Get details of the current logged-in user.

#### `picnic_get_user_info`

Get user information including toggled features.

### Payment & Transactions

#### `picnic_get_payment_profile`

Get payment information and profile.

#### `picnic_get_wallet_transactions`

Get wallet transaction history.

**Parameters:**

- `pageNumber` (number, optional): Page number for transaction history (default: 1)

#### `picnic_get_wallet_transaction_details`

Get detailed information about a specific wallet transaction.

**Parameters:**

- `transactionId` (string): The ID of the transaction to get details for

### Recipes & Meal Planning

#### `picnic_browse_recipes`

Browse Picnic cookbook recipes. Without a `category`, this returns cookbook highlights plus available recipe category page IDs when Picnic exposes them. With a `category`, this fetches that category page.

**Parameters:**

- `category` (string, optional): Bare category ID (for example `"20minuten"`) or full page ID (for example `"recipe-cattree-jamie-oliver"`)
- `limit` (number, optional): Maximum number of recipes to return (1-100, default: 25)
- `offset` (number, optional): Number of recipes to skip for pagination (default: 0)

#### `picnic_get_recipe`

Fetch a Picnic recipe by URL or recipe ID.

**Parameters:**

- `recipe_url_or_id` (string): A Picnic recipe URL or 24-/32-character recipe ID

#### `picnic_get_recipe_overview`

Get the rows of recipes on the start page of the app's recipe tab (e.g. recipes to order again,
featured recipes), each with title and recipes (ID, name, subtitle, tags, cooking time, image and
source URL).

**Parameters:**

- `section` (string, optional): Only rows whose title or selected filter contains this text (case-insensitive), e.g. `Nochmal` for the "Nochmal bestellen" filter of the "Favoriten" row

#### `picnic_get_saved_recipes`

List recipes saved in the user's Picnic cookbook.

**Parameters:**

- `limit` (number, optional): Maximum number of recipes to return (1-100, default: 25)
- `offset` (number, optional): Number of recipes to skip for pagination (default: 0)

#### `picnic_get_own_recipes`

List user-created Picnic recipes.

**Parameters:**

- `limit` (number, optional): Maximum number of recipes to return (1-100, default: 25)
- `offset` (number, optional): Number of recipes to skip for pagination (default: 0)

#### `picnic_create_recipe`

Create an own recipe in the Picnic cookbook ("Eigene Rezepte"). The returned id (32 hex
characters) works with `picnic_get_recipe` and `picnic_add_recipe_to_cart`. Not idempotent:
check `picnic_get_own_recipes` before retrying after an error.

**Parameters:**

- `name` (string, required): Recipe name (max 43 characters, the app's limit)
- `portions` (number, optional): Default portions the quantities are for (1-20, default: 4)
- `ingredients` (array, required): `{ product_id, quantity }` objects; `product_id` is a Picnic
  product id from `picnic_search` (e.g. `s1018231`), `quantity` the number of packages (default: 1).
  Each product may appear only once.
- `note` (string, optional): Free-text note (max 5000 characters); each line becomes a paragraph

#### `picnic_update_recipe`

Edit an own recipe. Ingredients are identified by their product ID. Everything is validated before
the first change; if a step fails, the error lists the steps already done. Not idempotent.

**Parameters:**

- `recipe_id` (string, required): Own-recipe ID (32 hex characters)
- `name` (string, optional): New name (max 43 characters)
- `portions` (number, optional): New default portions (quantities are not rescaled)
- `note` (string, optional): New note; an empty string deletes it
- `add_ingredients` (array, optional): `{ product_id, quantity }` to add
- `update_ingredients` (array, optional): `{ product_id, quantity }` new package count
- `replace_ingredients` (array, optional): `{ product_id, new_product_id, quantity? }`; Picnic lists the new product last
- `remove_ingredients` (array of product IDs, optional)

If the recipe is in the cart, only quantity changes reach the cart; add the recipe again for
added or swapped products.

#### `picnic_delete_recipe`

Permanently delete an own recipe. Removes it from the cart first, like the app.

**Parameters:**

- `recipe_id` (string, required): Own-recipe ID
- `keep_in_cart` (boolean, optional): Leave its ingredients in the cart (default: false)

#### `picnic_get_recipe_image_suggestions`

List Picnic's suggested images for an own recipe, with preview URLs.

**Parameters:**

- `recipe_id` (string, required): Own-recipe ID

#### `picnic_set_recipe_image`

Set the image of an own recipe: a suggested image, or an own JPEG/PNG/WebP image (max 5 MB)
downloaded from a public https URL and uploaded to Picnic.

**Parameters:**

- `recipe_id` (string, required): Own-recipe ID
- `image_id` (string): A suggested image ID, or
- `image_url` (string): Public https URL of an own image

#### `picnic_save_recipe`

Save a recipe to the user's Picnic cookbook.

**Parameters:**

- `recipe_url_or_id` (string): A Picnic recipe URL or 24-/32-character recipe ID

#### `picnic_unsave_recipe`

Remove a recipe from the user's Picnic cookbook.

**Parameters:**

- `recipe_url_or_id` (string): A Picnic recipe URL or 24-/32-character recipe ID

#### `picnic_add_recipe_to_cart`

Add a recipe's ingredients to the shopping cart by assigning the recipe selling group to the basket.

**Parameters:**

- `recipe_url_or_id` (string): A Picnic recipe URL or 24-/32-character recipe ID
- `portions` (number, optional): Number of portions to add

**Returns:** Confirmation and, if any, `unavailable_ingredients` (product ID, name, reason) that
Picnic cannot deliver for the selected slot. Replace those in the cart; the recipe keeps its
original ingredients.

#### `picnic_remove_recipe_from_cart`

Remove a recipe's ingredients from the shopping cart.

**Parameters:**

- `recipe_url_or_id` (string): A Picnic recipe URL or 24-/32-character recipe ID

#### `picnic_get_recipe_ingredients`

Fetch structured recipe ingredients for meal planning.

**Parameters:**

- `recipe_url_or_id` (string): A Picnic recipe URL or 24-/32-character recipe ID

#### `picnic_get_multiple_recipe_ingredients`

Fetch structured ingredients for multiple recipes.

**Parameters:**

- `recipe_urls_or_ids` (array of strings): Picnic recipe URLs or 24-/32-character recipe IDs, up to 20

#### `picnic_build_shopping_list`

Consolidate structured recipe ingredients into a shopping list.

#### `picnic_find_meal_combinations`

Rank recipe combinations by shared non-pantry ingredients and optional budget.

### Other Removed Legacy Tools

The legacy `picnic_get_lists`, `picnic_get_list`, and `picnic_get_mgm_details` tools are not available because `picnic-api` v4 removed their backing APIs.

## Usage Example

**Note**: Authentication is handled automatically using environment variables. No manual login is required.

1. Search for products:

```json
{
  "tool": "picnic_search",
  "arguments": {
    "query": "milk"
  }
}
```

2. Add a product to cart:

```json
{
  "tool": "picnic_add_to_cart",
  "arguments": {
    "productId": "12345",
    "count": 2
  }
}
```

3. Get available delivery slots:

```json
{
  "tool": "picnic_get_delivery_slots",
  "arguments": {}
}
```

## Important Notes

- **Authentication**: Authentication is handled automatically using environment variables (`PICNIC_USERNAME` and `PICNIC_PASSWORD`)
- **Country Support**: Currently supports Netherlands (NL) and Germany (DE)
- **Rate Limiting**: Be mindful of API rate limits when making frequent requests
- **Security**: Credentials are read from environment variables and used to authenticate automatically when tools are called
- **Unofficial API**: This uses an unofficial API wrapper, so functionality may change if Picnic updates their API

## Error Handling

All tools include proper error handling and will throw descriptive errors if:

- Authentication is required but not provided
- Invalid parameters are passed
- API requests fail
- Network issues occur

## Dependencies

This implementation uses the [picnic-api](https://www.npmjs.com/package/picnic-api) npm package by MRVDH.
