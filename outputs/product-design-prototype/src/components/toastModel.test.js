import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TOAST_LIMIT,
  appendToast,
  dismissToast,
  normalizeToastInput,
  toastDurationFor,
} from "./toastModel.js";

describe("toast queue model", () => {
  it("keeps the default auto-dismiss duration at 4s and extends errors to 6s", () => {
    assert.equal(toastDurationFor("info"), 4000);
    assert.equal(toastDurationFor("success"), 4000);
    assert.equal(toastDurationFor("error"), 6000);
    assert.equal(normalizeToastInput({ tone: "error", title: "失败" }).duration, 6000);
    assert.equal(normalizeToastInput({ tone: "success", title: "完成" }).duration, 4000);
  });

  it("honors an explicit positive duration and falls back on invalid ones", () => {
    assert.equal(toastDurationFor("info", 1500), 1500);
    assert.equal(toastDurationFor("error", 0), 6000);
    assert.equal(toastDurationFor("info", Number.NaN), 4000);
  });

  it("normalizes unknown tones to info and trims copy", () => {
    const normalized = normalizeToastInput({ tone: "warning", title: " 已保存 ", description: " 详情 " });
    assert.equal(normalized.tone, "info");
    assert.equal(normalized.title, "已保存");
    assert.equal(normalized.description, "详情");
  });

  it("caps concurrent toasts at three by evicting the oldest entry", () => {
    assert.equal(TOAST_LIMIT, 3);
    let queue = [];
    for (const id of ["a", "b", "c"]) queue = appendToast(queue, { id });
    assert.deepEqual(queue.map((item) => item.id), ["a", "b", "c"]);
    queue = appendToast(queue, { id: "d" });
    assert.deepEqual(queue.map((item) => item.id), ["b", "c", "d"], "the oldest toast yields");
  });

  it("dismisses a single toast by id and leaves the rest ordered", () => {
    const queue = [{ id: "a" }, { id: "b" }, { id: "c" }];
    assert.deepEqual(dismissToast(queue, "b").map((item) => item.id), ["a", "c"]);
    assert.deepEqual(dismissToast(queue, "missing").map((item) => item.id), ["a", "b", "c"]);
  });
});
