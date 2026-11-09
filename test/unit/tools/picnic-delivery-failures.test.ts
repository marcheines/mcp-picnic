import { describe, expect, it } from "vitest"
import {
  addDeliveryFailures,
  filterDeliveryData,
  readDeliveryFailures,
  readRefundedItems,
  refundsToDeliveryFailures,
} from "../../../src/tools/picnic-tools.js"

const delivery = {
  id: "d1",
  status: "COMPLETED",
  windowStart: "2026-11-09T15:00:00.000+01:00",
  windowEnd: "2026-11-09T17:30:00.000+01:00",
  totalPrice: 790,
  totalCount: 3,
  returnedContainers: [],
  cancellable: false,
  orders: [
    {
      id: "o1",
      status: "COMPLETED",
      creationTime: "2026-11-07T18:56:26.422+01:00",
      checkoutTotalPrice: 790,
      items: [
        { id: "655", productId: "s1", name: "Schnittlauch", displayPrice: 119, quantity: 1 },
        { id: "656_657", productId: "s2", name: "Caramelle", displayPrice: 670, quantity: 2 },
      ],
    },
  ],
} as unknown as Parameters<typeof filterDeliveryData>[0]

describe("readDeliveryFailures", () => {
  it("reads failures from the line, its articles and the order's decorator overrides", () => {
    const failures = readDeliveryFailures({
      orders: [
        {
          id: "o1",
          decorator_overrides: {
            "657": [
              {
                type: "ARTICLE_DELIVERY_FAILURES",
                failures: { "657": ["PRODUCT_NOT_SHIPPED"] },
                prices: { "657": 335 },
              },
            ],
          },
          items: [
            { id: "655", decorators: [{ type: "PRICE", display_price: 119 }] },
            {
              id: "656_657",
              decorators: [
                {
                  type: "ARTICLE_DELIVERY_FAILURES",
                  failures: { "656": ["PRODUCT_ABSENT"] },
                  prices: { "656": 335 },
                },
              ],
              items: [{ id: "657" }],
            },
          ],
        },
      ],
    })

    expect(failures.get("o1")?.get("656_657")).toEqual({
      reasons: ["PRODUCT_ABSENT", "PRODUCT_NOT_SHIPPED"],
      failed_count: 2,
      refund: 670,
    })
    expect(failures.get("o1")?.has("655")).toBe(false)
  })

  it("returns nothing for a missing or malformed raw delivery", () => {
    expect(readDeliveryFailures(null).size).toBe(0)
    expect(readDeliveryFailures({ orders: "x" }).size).toBe(0)
  })
})

describe("addDeliveryFailures", () => {
  it("marks the failed line and lists it in not_delivered", () => {
    const failures = new Map([
      ["o1", new Map([["656_657", { reasons: ["PRODUCT_ABSENT"], failed_count: 2, refund: 670 }]])],
    ])
    const result = addDeliveryFailures(filterDeliveryData(delivery), failures) as ReturnType<
      typeof filterDeliveryData
    > & { not_delivered?: unknown[] }

    expect(result.orders[0].items[1]).toMatchObject({
      delivery_failure: { reasons: ["PRODUCT_ABSENT"], refund: 670 },
    })
    expect(result.orders[0].items[0]).not.toHaveProperty("delivery_failure")
    expect(result.not_delivered).toEqual([
      {
        order_id: "o1",
        name: "Caramelle",
        reasons: ["PRODUCT_ABSENT"],
        failed_count: 2,
        refund: 670,
      },
    ])
  })

  it("leaves a fully delivered delivery unchanged", () => {
    const filtered = filterDeliveryData(delivery)
    expect(addDeliveryFailures(filtered, new Map())).toBe(filtered)
  })
})

describe("readRefundedItems", () => {
  it("lists refunds without substitutions, named from the shop items", () => {
    expect(
      readRefundedItems({
        shop_items: [{ items: [{ id: "s2", name: "Caramelle" }] }],
        article_issue_refunds: [
          { article_id: "s2", quantity: 2, amount: 670, substitutions: [] },
          { article_id: "s3", quantity: 1, amount: 99, substitutions: [{ name: "Ersatz" }] },
        ],
      }),
    ).toEqual([{ product_id: "s2", name: "Caramelle", quantity: 2, refund: 670 }])
  })

  it("returns an empty list without refunds", () => {
    expect(readRefundedItems(null)).toEqual([])
  })
})

describe("refundsToDeliveryFailures", () => {
  it("matches wallet refunds to order lines by product name", () => {
    const failures = refundsToDeliveryFailures(filterDeliveryData(delivery), [
      {
        product_id: "13501890",
        name: "Caramelle",
        quantity: 2,
        refund: 670,
        reason: "PRODUCT_NOT_SHIPPED",
      },
      { product_id: "99", name: "Nicht bestellt", quantity: 1, refund: 50 },
    ])
    expect([...failures.get("o1")!.entries()]).toEqual([
      ["656_657", { reasons: ["PRODUCT_NOT_SHIPPED"], failed_count: 2, refund: 670 }],
    ])
  })

  it("returns nothing without refunds", () => {
    expect(refundsToDeliveryFailures(filterDeliveryData(delivery), []).size).toBe(0)
  })
})
