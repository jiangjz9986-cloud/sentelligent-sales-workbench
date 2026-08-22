import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chooseBestInvoiceReplacement,
  rankInvoiceCombinations,
} from "../src/travelExpense/invoiceReplacement.js";

describe("invoice replacement combinations", () => {
  it("prefers one exact invoice over a multi-invoice exact combination", () => {
    const best = chooseBestInvoiceReplacement({
      targetCents: 10000,
      invoices: [
        { id: "sixty", totalCents: 6000 },
        { id: "forty", totalCents: 4000 },
        { id: "exact", totalCents: 10000 },
      ],
    });

    assert.equal(best.exact, true);
    assert.deepEqual(best.invoiceIds, ["exact"]);
    assert.deepEqual(best.allocations, [{ invoiceId: "exact", allocatedCents: 10000, wasteCents: 0 }]);
    assert.equal(best.requiresManualConfirmation, true);
  });

  it("prefers a multi-invoice exact combination over an oversized single invoice", () => {
    const best = chooseBestInvoiceReplacement({
      targetCents: 10000,
      invoices: [
        { id: "large", totalCents: 20000 },
        { id: "sixty", totalCents: 6000 },
        { id: "forty", totalCents: 4000 },
        { id: "small", totalCents: 3000 },
      ],
    });

    assert.deepEqual(best.invoiceIds, ["forty", "sixty"]);
    assert.equal(best.wasteCents, 0);
    assert.deepEqual(best.allocations.map((item) => item.allocatedCents), [4000, 6000]);
  });

  it("ranks the smallest overage before the number of sheets", () => {
    const candidates = rankInvoiceCombinations({
      targetCents: 10000,
      invoices: [
        { id: "large", totalCents: 20000 },
        { id: "sixty", totalCents: 6000 },
        { id: "fifty", totalCents: 5000 },
        { id: "forty-five", totalCents: 4500 },
      ],
    });

    assert.equal(candidates[0].wasteCents, 500);
    assert.deepEqual(candidates[0].invoiceIds, ["forty-five", "sixty"]);
    assert.equal(candidates[0].allocations[1].wasteCents, 500);
    assert.equal(candidates.at(-1).invoiceIds.includes("large"), true);
  });

  it("filters unavailable or incompatible invoices without mutating input", () => {
    const invoices = [
      { id: "usable", totalCents: 6000, availableCents: 6000, category: "lodging" },
      { id: "used", totalCents: 6000, availableCents: 0, category: "lodging" },
      { id: "wrong", totalCents: 10000, category: "transport" },
    ];
    const best = chooseBestInvoiceReplacement({
      targetCents: 5000,
      invoices,
      isEligible: (invoice, target) => invoice.category === target.category,
      target: { category: "lodging" },
    });

    assert.equal(best.invoiceIds[0], "usable");
    assert.equal(best.wasteCents, 1000);
    assert.equal(invoices[0].availableCents, 6000);
    assert.equal(invoices[1].availableCents, 0);
  });

  it("returns no automatic selection when no invoice can cover the target", () => {
    assert.equal(chooseBestInvoiceReplacement({
      targetCents: 10000,
      invoices: [{ id: "small", totalCents: 5000 }],
    }), null);
  });

  it("bounds combinatorial search and marks truncated candidates for review", () => {
    const candidates = rankInvoiceCombinations({
      targetCents: 10_000,
      maxInvoices: 12,
      maxSearchNodes: 100,
      invoices: Array.from({ length: 20 }, (_, index) => ({
        id: `invoice-${index}`,
        totalCents: 1_000,
      })),
    });
    assert.ok(candidates.length > 0);
    assert.equal(candidates.every((candidate) => candidate.searchTruncated), true);
    assert.equal(candidates.every((candidate) => candidate.requiresManualConfirmation), true);
  });
});
