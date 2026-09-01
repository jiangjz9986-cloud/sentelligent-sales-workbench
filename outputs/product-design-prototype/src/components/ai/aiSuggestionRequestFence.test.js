import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAiSuggestionRequestFence } from "./aiSuggestionRequestFence.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

describe("AI suggestion request fence", () => {
  it("ignores a late old-source response even when the fake client ignores abort", async () => {
    const fence = createAiSuggestionRequestFence();
    const pending = new Map([
      ["customer:a", deferred()],
      ["customer:b", deferred()],
    ]);
    const fakeClient = {
      listAiSuggestions({ sourceId }) {
        return pending.get(`customer:${sourceId}`).promise;
      },
    };
    let sourceKey = "customer:a";
    let visible = null;

    async function load(sourceId) {
      const requestKey = `customer:${sourceId}`;
      const request = fence.start(requestKey, 30_000);
      const response = await fakeClient.listAiSuggestions(
        { sourceId },
        { signal: request.controller.signal },
      );
      if (fence.isCurrent(request, sourceKey)) visible = response.items[0].id;
      fence.finish(request);
    }

    const oldLoad = load("a");
    sourceKey = "customer:b";
    const currentLoad = load("b");
    assert.equal(fence.isCurrent(null, sourceKey), false);
    pending.get("customer:b").resolve({ items: [{ id: "suggestion-b" }] });
    await currentLoad;
    assert.equal(visible, "suggestion-b");

    // The fake client intentionally resolves after its signal was aborted.
    pending.get("customer:a").resolve({ items: [{ id: "suggestion-a-late" }] });
    await oldLoad;
    assert.equal(visible, "suggestion-b");
  });

  it("rejects an ignored-abort response after disposal", async () => {
    const fence = createAiSuggestionRequestFence();
    const late = deferred();
    let committed = false;
    const request = fence.start("knowledge:k1", 30_000);
    const task = late.promise.then(() => {
      if (fence.isCurrent(request, "knowledge:k1")) committed = true;
    });
    fence.dispose();
    late.resolve({ items: [{ id: "late" }] });
    await task;
    assert.equal(request.controller.signal.aborted, true);
    assert.equal(committed, false);
  });

  it("rejects a late success after timeout when the fake client ignores abort", async () => {
    const fence = createAiSuggestionRequestFence();
    const late = deferred();
    let committed = false;
    const request = fence.start("opportunity:o1", 5);
    const task = late.promise.then(() => {
      if (fence.isCurrent(request, "opportunity:o1")) committed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(request.timedOut, true);
    assert.equal(request.controller.signal.aborted, true);
    late.resolve({ items: [{ id: "late-after-timeout" }] });
    await task;
    assert.equal(committed, false);
  });

  it("keeps the newer request current when an older finally block finishes", () => {
    const fence = createAiSuggestionRequestFence();
    const first = fence.start("customer:a", 30_000);
    const second = fence.start("customer:a", 30_000);
    fence.finish(first);
    assert.equal(first.controller.signal.aborted, true);
    assert.equal(fence.isCurrent(second, "customer:a"), true);
    fence.finish(second);
  });
});
