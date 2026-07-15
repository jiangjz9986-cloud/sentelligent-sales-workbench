import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { triggerBlobDownload } from "./downloadFile.js";

function createDownloadHarness({ clickError } = {}) {
  const events = [];
  const anchor = {
    download: "",
    href: "",
    style: {},
    click() {
      events.push("click");
      if (clickError) throw clickError;
    },
    remove() {
      events.push("remove");
    },
  };
  const documentRef = {
    body: {
      append(node) {
        assert.equal(node, anchor);
        events.push("append");
      },
    },
    createElement(tagName) {
      assert.equal(tagName, "a");
      events.push("create-anchor");
      return anchor;
    },
  };
  const urlApi = {
    createObjectURL(value) {
      events.push(["create-url", value]);
      return "blob:weekly-report";
    },
    revokeObjectURL(value) {
      events.push(["revoke-url", value]);
    },
  };

  return { anchor, documentRef, events, urlApi };
}

describe("triggerBlobDownload", () => {
  it("clicks a hidden download anchor and waits for release before revoking the URL", async () => {
    const blob = { type: "application/msword" };
    const harness = createDownloadHarness();
    let finishRelease;
    const release = () => {
      harness.events.push("release");
      return new Promise((resolve) => {
        finishRelease = resolve;
      });
    };

    const download = triggerBlobDownload(
      { blob, filename: "sales-weekly.doc" },
      { documentRef: harness.documentRef, urlApi: harness.urlApi, release },
    );

    assert.equal(harness.anchor.href, "blob:weekly-report");
    assert.equal(harness.anchor.download, "sales-weekly.doc");
    assert.equal(harness.anchor.style.display, "none");
    assert.deepEqual(harness.events, [
      "create-anchor",
      ["create-url", blob],
      "append",
      "click",
      "remove",
      "release",
    ]);

    finishRelease();
    await download;

    assert.deepEqual(harness.events.at(-1), ["revoke-url", "blob:weekly-report"]);
  });

  it("removes the anchor and revokes its URL when clicking throws", async () => {
    const clickError = new Error("download click failed");
    const blob = { type: "application/msword" };
    const harness = createDownloadHarness({ clickError });

    await assert.rejects(
      () => triggerBlobDownload(
        { blob, filename: "sales-weekly.doc" },
        {
          documentRef: harness.documentRef,
          urlApi: harness.urlApi,
          release: async () => {
            harness.events.push("release");
          },
        },
      ),
      clickError,
    );

    assert.deepEqual(harness.events, [
      "create-anchor",
      ["create-url", blob],
      "append",
      "click",
      "remove",
      "release",
      ["revoke-url", "blob:weekly-report"],
    ]);
  });
});
