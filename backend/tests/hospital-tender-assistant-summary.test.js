import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAgentManifestRegistry, getAgentManifest } from "../src/assistant/agentManifest.js";
import { getCapability } from "../src/assistant/capabilityCatalog.js";
import { getToolPolicy } from "../src/assistant/policy.js";
import { createAssistantToolHandlers } from "../src/assistant/runtimeHandlers.js";
import { openDatabase } from "../src/db.js";
import { createHospitalTenderRepository } from "../src/hospitalTender/repository.js";

function notice(overrides = {}) {
  return {
    identityKey: "source-a:item-1",
    sourceId: "source-a",
    sourceName: "示例采购平台",
    city: "日照市",
    title: "日照中医医院 PACS 存储扩容招标公告",
    url: "https://example.com/notices/1",
    publishedAt: "2026-08-28T08:00:00.000Z",
    noticeType: "tender",
    relevance: "high",
    sourceItemId: "item-1",
    contentSha256: "a".repeat(64),
    ...overrides,
  };
}

function buildHandlers(db, hospitalTenderRepository) {
  return createAssistantToolHandlers({
    db,
    sessionRepository: {
      getOrCreate: () => ({ id: "conversation-tender-1" }),
      listDraftParts: () => [],
      clearDraftParts: () => {},
    },
    hospitalTenderRepository,
  });
}

describe("hospital tender assistant summary", () => {
  it("registers as a confirmation-free read-only capability with a valid manifest", () => {
    const policy = getToolPolicy("hospital-tender.summary");
    assert.equal(policy.denied, false);
    assert.equal(policy.risk, "R0");
    assert.equal(policy.confirmation, "none");

    const manifest = getAgentManifest("hospital-tender");
    assert.ok(manifest);
    assert.equal(manifest.contractVersion, "hospital-tender-v1");
    assert.equal(manifest.modelPolicy, "none");
    assert.deepEqual(manifest.tools, ["hospital-tender.summary"]);
    // The registry↔manifest startup consistency check must accept the set.
    assert.ok(createAgentManifestRegistry().has("hospital-tender"));

    const capability = getCapability("hospital-tender.summary");
    assert.equal(capability.status, "ready");
    assert.equal(capability.confirmationLevel, "none");
    assert.ok(capability.mappings.apis.includes("GET /api/hospital-tenders/summary"));
  });

  it("renders the summary card from repository data", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const repository = createHospitalTenderRepository(db, {
        clock: () => new Date("2026-08-28T17:20:00.000Z"),
      });
      repository.upsertNotice(notice(), {
        matchedCustomerIds: ["rizhao"],
        matchReasons: { rizhao: ["hospital_name"] },
        matchedNeeds: {},
        matchScore: 80,
      });
      repository.upsertNotice(notice({
        identityKey: "source-a:item-2",
        sourceItemId: "item-2",
        title: "东营人民医院机房改造招标预告",
        relevance: "medium",
        publishedAt: "2026-08-27T02:00:00.000Z",
      }));
      const handlers = buildHandlers(db, repository);
      const result = await handlers["hospital-tender.summary"]({}, {
        owner: "jiangjz",
        channel: "weixin",
        conversation: "conversation-1",
        event: "event-1",
      });
      assert.equal(result.status, "ok");
      const lines = result.text.split("\n");
      assert.equal(lines[0], "【医院招标监测】");
      assert.match(result.text, /公告总数：2/u);
      assert.match(result.text, /高相关：1/u);
      assert.match(result.text, /已匹配客户：1/u);
      assert.match(result.text, /最新发布：2026-08-28T08:00:00.000Z/u);
      assert.match(result.text, /最近采集：待首轮采集/u);
      assert.match(result.text, /高相关新公告会自动推送；详情见工作台「招标监测」页。/u);
      assert.equal(result.summary.totalNotices, 2);
    } finally {
      db.close();
    }
  });

  it("renders an empty-library card and fails soft without a repository", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const repository = createHospitalTenderRepository(db, {
        clock: () => new Date("2026-08-28T17:20:00.000Z"),
      });
      const handlers = buildHandlers(db, repository);
      const empty = await handlers["hospital-tender.summary"]({}, {
        owner: "jiangjz",
        channel: "weixin",
        conversation: "conversation-1",
        event: "event-2",
      });
      assert.equal(empty.status, "ok");
      assert.match(empty.text, /公告总数：0/u);
      assert.match(empty.text, /最近采集：待首轮采集/u);

      const unconfigured = buildHandlers(db, null);
      const failed = await unconfigured["hospital-tender.summary"]({}, {
        owner: "jiangjz",
        channel: "weixin",
        conversation: "conversation-1",
        event: "event-3",
      });
      assert.equal(failed.status, "error");
      assert.match(failed.text, /招标监测尚未完成配置/u);
    } finally {
      db.close();
    }
  });
});
