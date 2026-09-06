import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createWeixinConfirmationOutboxRepository } from "../src/weixin/outboxRepository.js";
import {
  MAX_MESSAGE_CHARS,
  renderDailyDigestMessage,
  renderFridayCloseoutMessage,
} from "../src/dailyDigest/digestMessage.js";

function dailyPayload(overrides = {}) {
  return {
    kind: "daily_digest",
    digestDate: "2026-08-28",
    headline: "焦点：今天有 2 站拜访，首站 日照中医医院。",
    sections: [
      { heading: "今日行程（2 站）", lines: ["· 日照两院拜访 ｜ 2 站 ｜ 首站 日照中医医院"] },
      { heading: "待办（逾期 1 ｜ 今日 1）", lines: ["逾期：", "· [高] 给王工送方案 ｜ 08-27 09:00 ｜ a1b2c3"] },
    ],
    footer: "回复“完成待办 <编号>”处理待办。",
    ...overrides,
  };
}

function fridayPayload(overrides = {}) {
  return {
    kind: "friday_closeout",
    digestDate: "2026-08-28",
    weekStart: "2026-08-24",
    sections: [
      { heading: "周报", lines: ["本周已有周报 1 份（最新：就绪）。发送“销售周报”可查看预览。"] },
      { heading: "凭证与发票", lines: ["本周凭证与发票已齐 ✓"] },
    ],
    footer: "补传凭证/发票请在系统差旅页操作。",
    ...overrides,
  };
}

describe("daily digest message", () => {
  it("renders the card with the weekday header, headline, sections, and footer", () => {
    const message = renderDailyDigestMessage(dailyPayload());
    const lines = message.split("\n");
    assert.equal(lines[0], "【小小晨报】08-28 周五");
    assert.equal(lines[1], "焦点：今天有 2 站拜访，首站 日照中医医院。");
    assert.ok(message.includes("\n\n■ 今日行程（2 站）\n· 日照两院拜访 ｜ 2 站 ｜ 首站 日照中医医院"));
    assert.ok(message.includes("\n\n■ 待办（逾期 1 ｜ 今日 1）\n逾期：\n"));
    assert.ok(message.endsWith("\n——\n回复“完成待办 <编号>”处理待办。"));
  });

  it("omits the headline and empty sections", () => {
    const message = renderDailyDigestMessage(dailyPayload({
      headline: null,
      sections: [
        { heading: "今日行程（2 站）", lines: ["· 一行"] },
        { heading: "空段", lines: [] },
        { heading: "空白段", lines: ["   ", ""] },
      ],
    }));
    assert.ok(message.startsWith("【小小晨报】08-28 周五\n\n■ 今日行程（2 站）"));
    assert.ok(!message.includes("焦点"));
    assert.ok(!message.includes("空段"));
    assert.ok(!message.includes("空白段"));
  });

  it("fails closed on wrong kind, bad date, no sections, and oversized content", () => {
    assert.throws(() => renderDailyDigestMessage(fridayPayload()), TypeError);
    assert.throws(() => renderDailyDigestMessage(dailyPayload({ digestDate: "2026-8-28" })), TypeError);
    assert.throws(() => renderDailyDigestMessage(dailyPayload({ digestDate: "2026-13-99" })), TypeError);
    assert.throws(() => renderDailyDigestMessage(dailyPayload({ sections: [] })), /empty/u);
    assert.throws(() => renderDailyDigestMessage(dailyPayload({ sections: [{ heading: "空", lines: [] }] })), /empty/u);
    assert.throws(() => renderDailyDigestMessage(dailyPayload({ footer: "" })), TypeError);
    const oversized = dailyPayload({
      sections: Array.from({ length: 8 }, (_, sectionIndex) => ({
        heading: `段${sectionIndex}`,
        lines: Array.from({ length: 14 }, () => `· ${"很".repeat(180)}`),
      })),
    });
    assert.throws(() => renderDailyDigestMessage(oversized), /too large/u);
    assert.ok(MAX_MESSAGE_CHARS === 3500);
  });

  it("renders the friday closeout with the week range header", () => {
    const message = renderFridayCloseoutMessage(fridayPayload());
    const lines = message.split("\n");
    assert.equal(lines[0], "【小小周五收尾】本周 08-24 ~ 08-30");
    assert.ok(message.includes("■ 周报\n本周已有周报 1 份"));
    assert.ok(message.endsWith("——\n补传凭证/发票请在系统差旅页操作。"));
    assert.throws(() => renderFridayCloseoutMessage(dailyPayload()), TypeError);
    assert.throws(() => renderFridayCloseoutMessage(fridayPayload({ weekStart: undefined })), TypeError);
  });

  it("passes the outbox forbidden-key inspection end to end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sentelligent-digest-message-"));
    const db = openDatabase({ databaseUrl: join(dir, "outbox.sqlite") });
    try {
      const outbox = createWeixinConfirmationOutboxRepository(db, { clock: () => new Date("2026-08-28T02:00:00.000Z") });
      const daily = outbox.enqueue({
        owner: "digest-owner",
        conversationId: "conversation-1",
        idempotencyKey: "daily-digest:2026-08-28",
        payload: dailyPayload(),
      });
      assert.equal(daily.replayed, false);
      const friday = outbox.enqueue({
        owner: "digest-owner",
        conversationId: "conversation-1",
        idempotencyKey: "friday-closeout:2026-08-28",
        payload: fridayPayload(),
      });
      assert.equal(friday.replayed, false);
      assert.equal(outbox.hasKey({ owner: "digest-owner", idempotencyKey: "daily-digest:2026-08-28" }), true);
      assert.equal(outbox.hasKey({ owner: "digest-owner", idempotencyKey: "daily-digest:2026-08-29" }), false);
      assert.equal(outbox.hasKey({ owner: "other-owner", idempotencyKey: "daily-digest:2026-08-28" }), false);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
