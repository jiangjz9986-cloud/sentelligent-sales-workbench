import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createBusinessOwnerResolver,
  isValidBusinessOwner,
} from "../src/assistant/businessOwnerResolver.js";

// v0.9.3：resolver 改查绑定表（注入桩），闭合矩阵——绑定中/未绑定/disabled/
// 空串/超长/控制字符一律 null，绝不回退全量。
describe("assistant business-owner resolver", () => {
  it("maps only accounts with an active weixin binding", () => {
    const bindings = new Map([
      ["jiangjz", "active"],
      ["testb", "disabled"],
    ]);
    const resolve = createBusinessOwnerResolver({
      hasActiveBinding: (account) => bindings.get(account) === "active",
    });
    assert.equal(resolve("jiangjz"), "jiangjz");
    assert.equal(resolve(" jiangjz "), "jiangjz");
    assert.equal(resolve("testb"), null, "a disabled binding must resolve closed");
    assert.equal(resolve("ghostacct"), null, "an unbound account must resolve closed");
    assert.equal(resolve(""), null);
  });

  it("fails closed for missing, oversized, or control-character accounts and a throwing lookup", () => {
    const resolve = createBusinessOwnerResolver({ hasActiveBinding: () => true });
    for (const value of ["", null, undefined, "owner\u0000x", "x".repeat(201)]) {
      assert.equal(resolve(value), null);
      assert.equal(isValidBusinessOwner(value), false);
    }
    assert.equal(isValidBusinessOwner("owner"), true);
    // 查表桩返回非 true 值（含异常语义的 falsy）一律闭合。
    const nonBoolean = createBusinessOwnerResolver({ hasActiveBinding: () => "yes" });
    assert.equal(nonBoolean("owner"), null);
    assert.throws(() => createBusinessOwnerResolver({}), TypeError);
  });
});
