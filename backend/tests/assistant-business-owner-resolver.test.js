import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createBusinessOwnerResolver,
  isValidBusinessOwner,
} from "../src/assistant/businessOwnerResolver.js";

describe("assistant business-owner resolver", () => {
  it("maps only the explicitly configured machine account", () => {
    const resolve = createBusinessOwnerResolver({ businessOwner: "业务负责人" });
    assert.equal(resolve("业务负责人"), "业务负责人");
    assert.equal(resolve(" 业务负责人 "), "业务负责人");
    assert.equal(resolve("machine-account"), null);
    assert.equal(resolve(""), null);
  });

  it("fails closed for missing, oversized, or control-character configuration", () => {
    for (const value of ["", null, "owner\u0000x", "x".repeat(201)]) {
      const resolve = createBusinessOwnerResolver({ businessOwner: value });
      assert.equal(resolve("owner"), null);
      assert.equal(isValidBusinessOwner(value), false);
    }
    assert.equal(isValidBusinessOwner("owner"), true);
  });
});
