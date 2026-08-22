import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";

const machineHeader = "fixture-machine-header";
let tempDir;
let server;

describe("assistant runtime business-owner wiring", () => {
  afterEach(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    server = null;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("uses an explicit machine-account to business-owner resolver for HTTP assistant reads", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sentelligent-owner-runtime-"));
    const databaseUrl = join(tempDir, "assistant.sqlite");
    const db = openDatabase({ databaseUrl });
    db.prepare("INSERT INTO customers (id, name, region, owner) VALUES ('business-customer', '业务归属医院', '山东', 'business-owner')").run();
    db.close();

    server = createServer({
      databaseUrl,
      nodeEnv: "test",
      authRequired: false,
      authSessionSecret: Buffer.alloc(32, 21).toString("base64url"),
      weixinAgentApiToken: machineHeader,
      weixinAgentOwner: "machine-account",
      resolveBusinessOwner: (account) => account === "machine-account" ? "business-owner" : null,
      weixinAllowedSenderIds: "owner-runtime-sender",
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/integrations/weixin-agent/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${machineHeader}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "owner-runtime-search",
      },
      body: JSON.stringify({
        conversationId: "owner-runtime-conversation",
        text: "/customer.search 业务归属医院",
        sourceMessageId: "owner-runtime-search",
        senderId: "owner-runtime-sender",
        chatType: "direct",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.match(body.text, /business-customer/);
    assert.doesNotMatch(body.text, /未找到客户/);
  });

  it("scopes machine HTTP customer reads and rejects a forged weekly-draft owner", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sentelligent-owner-http-scope-"));
    const databaseUrl = join(tempDir, "assistant.sqlite");
    const db = openDatabase({ databaseUrl });
    db.exec(`
      INSERT INTO customers (id, name, region, owner)
      VALUES ('owner-http-customer', 'Owner HTTP Hospital', '山东', 'business-owner');
      INSERT INTO customers (id, name, region, owner)
      VALUES ('other-http-customer', 'Other HTTP Hospital', '山东', 'other-owner');
    `);
    db.close();

    server = createServer({
      databaseUrl,
      nodeEnv: "test",
      authRequired: false,
      authSessionSecret: Buffer.alloc(32, 22).toString("base64url"),
      weixinAgentApiToken: machineHeader,
      weixinAgentOwner: "business-owner",
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const customers = await fetch(`http://127.0.0.1:${server.address().port}/api/customers`, {
      headers: { Authorization: `Bearer ${machineHeader}` },
    });
    const customerBody = await customers.json();
    assert.equal(customers.status, 200);
    assert.deepEqual(customerBody.items.map((item) => item.id), ["owner-http-customer"]);

    const forged = await fetch(`http://127.0.0.1:${server.address().port}/api/reports/weekly/draft`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${machineHeader}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        owner: "other-owner",
        periodStart: "2026-08-03",
        periodEnd: "2026-08-09",
      }),
    });
    const forgedBody = await forged.json();
    assert.equal(forged.status, 403);
    assert.equal(forgedBody.error.code, "OWNER_SCOPE_DENIED");
  });

  it("fails closed when the configured business owner has no active business rows", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sentelligent-owner-runtime-missing-"));
    const databaseUrl = join(tempDir, "assistant.sqlite");
    server = createServer({
      databaseUrl,
      nodeEnv: "test",
      authRequired: false,
      authSessionSecret: Buffer.alloc(32, 23).toString("base64url"),
      weixinAgentApiToken: machineHeader,
      weixinAgentOwner: "unbound-business-owner",
      weixinAllowedSenderIds: "owner-runtime-sender",
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/integrations/weixin-agent/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${machineHeader}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "owner-runtime-missing",
      },
      body: JSON.stringify({
        conversationId: "owner-runtime-missing-conversation",
        text: "/customer.search 任意客户",
        sourceMessageId: "owner-runtime-missing",
        senderId: "owner-runtime-sender",
        chatType: "direct",
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.match(body.text, /未找到客户/);
  });
});
