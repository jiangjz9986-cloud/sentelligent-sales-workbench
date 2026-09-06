import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../src/server.js";

function serverOptions(overrides = {}) {
  return {
    databaseUrl: ":memory:",
    seed: false,
    nodeEnv: "test",
    authRequired: false,
    aiAnalysisMode: "mock",
    proactiveAssistantAutoRun: false,
    proactiveNotificationAutoRun: false,
    hospitalTenderAutoRun: false,
    actionReminderAutoRun: false,
    invoiceEscalationAutoRun: false,
    dailyDigestAutoRun: false,
    weixinAgentApiToken: "",
    weixinAgentOwner: "",
    ...overrides,
  };
}

function suggestionRepository() {
  return {
    list: () => [],
    get: () => null,
    count: () => 0,
    listOwners: () => [],
  };
}

function scanRepository() {
  return { pendingEventCount: () => 0 };
}

async function listenAndClose(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("v0.12.0 server wiring prefers injected worker repositories and exposes shared services", async () => {
  const workerScanRepository = scanRepository();
  const optionScanRepository = scanRepository();
  const workerSuggestionRepository = suggestionRepository();
  const optionSuggestionRepository = suggestionRepository();
  const workerSubjectService = {
    suggestionRepository: workerSuggestionRepository,
    assertCurrentRevision() {},
  };
  const optionSubjectService = { suggestionRepository: optionSuggestionRepository };
  const actionRiskWritebackService = { kind: "action-risk-writeback" };
  const customerImportHttp = { kind: "customer-import-http" };
  let startCount = 0;
  let stopCount = 0;
  const worker = {
    scanRepository: workerScanRepository,
    suggestionRepository: workerSuggestionRepository,
    customerProactiveSubjectService: workerSubjectService,
    start() { startCount += 1; },
    stop() { stopCount += 1; },
    status: () => ({}),
  };

  const server = createServer(serverOptions({
    proactiveAssistantWorker: worker,
    proactiveScanRepository: optionScanRepository,
    proactiveSuggestionRepository: optionSuggestionRepository,
    customerProactiveSubjectService: optionSubjectService,
    actionRiskWritebackService,
    customerImportHttp,
  }));

  assert.equal(server.proactiveAssistantWorker, worker);
  assert.equal(server.proactiveScanRepository, workerScanRepository);
  assert.equal(server.proactiveSuggestionRepository, workerSuggestionRepository);
  assert.equal(server.customerProactiveSubjectService, workerSubjectService);
  assert.equal(server.actionRiskWritebackService, actionRiskWritebackService);
  assert.equal(server.customerImportHttp, customerImportHttp);
  assert.equal(startCount, 0);

  await listenAndClose(server);
  assert.equal(stopCount, 1);
});

test("v0.12.0 server wiring rejects a customer subject service bound to another suggestion repository", () => {
  const workerSuggestionRepository = suggestionRepository();
  const mismatchedSuggestionRepository = suggestionRepository();
  const worker = {
    scanRepository: scanRepository(),
    suggestionRepository: workerSuggestionRepository,
    customerProactiveSubjectService: {
      suggestionRepository: mismatchedSuggestionRepository,
      assertCurrentRevision() {},
    },
    start() {},
    stop() {},
    status: () => ({}),
  };

  assert.throws(
    () => createServer(serverOptions({ proactiveAssistantWorker: worker })),
    /customerProactiveSubjectService must use the shared proactiveSuggestionRepository/u,
  );
});
