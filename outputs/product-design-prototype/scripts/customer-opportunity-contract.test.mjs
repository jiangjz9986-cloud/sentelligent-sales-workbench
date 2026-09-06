import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

import { appSourceFiles } from "./app-source.mjs";
import { salesWorkbenchPageFiles } from "./pages-source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const entityWorkspaceSource = readFileSync(join(root, "src/features/salesWorkbench/pages/EntityWorkspace.jsx"), "utf8");
const appSource = [
  ...appSourceFiles(root).map((file) => join(root, file)),
  join(root, "src/data/salesWorkbenchData.js"),
  ...salesWorkbenchPageFiles(root).map((file) => join(root, file)),
]
  .map((filePath) => readFileSync(filePath, "utf8"))
  .join("\n");

const requiredContract = [
  "stakeholders",
  "decisionChain",
  "historyProjects",
  "infrastructure",
  "syncPreview",
  "requirements",
  "competitors",
  "solutionDirection",
  "sourceRecord",
  "组织架构与决策链",
  "历史项目",
  "现有基础架构",
  "快速记录承接",
  "客户诉求 / 需求",
  "竞争对手",
  "方案方向",
  "来源记录",
];

for (const token of requiredContract) {
  assert.ok(appSource.includes(token), `Missing customer/opportunity contract token: ${token}`);
}

assert.ok(
  (appSource.includes('setActive("customer")') || appSource.includes('navigateTo("customer")'))
  && (appSource.includes('setActive("opportunity")') || appSource.includes('navigateTo("opportunity")')),
  "Customer and opportunity detail pages must keep bidirectional navigation.",
);

assert.match(entityWorkspaceSource, /<article[\s\S]*className=\{`list-button customer-list-row/);
assert.match(entityWorkspaceSource, /<button className="list-row-main" type="button" onClick=/);

for (const page of ["customerConfig", "opportunityConfig", "actionsConfigBase", "riskConfig", "knowledgeConfigBase"]) {
  assert.match(appSource, new RegExp(`${page}[\\s\\S]*rowPrimary:`));
}

assert.ok(
  appSource.includes('const [recordText, setRecordText] = useState("");'),
  "Quick record composer should open as a blank new-record input by default.",
);

const createDetailTestIds = [
  "customer-create-detail",
  "opportunity-create-detail",
  "knowledge-create-detail",
];
for (const testId of createDetailTestIds) {
  assert.match(appSource, new RegExp(`testId:\\s*"${testId}"`));
}
assert.match(appSource, /testId:\s*"actions-create-detail"/);

const createInitialModes = appSource.match(/initialMode=\{isCreateView \? "new" : "edit"\}/g) ?? [];
assert.equal(
  createInitialModes.length,
  3,
  "Create and edit detail views should initialize editors from the explicit page mode.",
);

// v0.9.2：owner=服务端按会话注入的归属键，客户/商机表单不再有“负责人”输入项。
const emptyCreateFormTokens = [
  'relation: customer?.relation == null ? "" : String(customer.relation)',
  'customerId: hasOpportunity ? (opportunity?.customerId ?? selectedCustomer?.id ?? "") : ""',
  'customer: hasOpportunity ? (opportunity?.customer ?? selectedCustomer?.name ?? "") : ""',
  'stage: opportunity?.stage ?? ""',
  'amount: opportunity?.amount ?? ""',
  'probability: opportunity?.probability == null ? "" : String(opportunity.probability)',
  '<option value="">请选择客户</option>',
];

const removedOwnerFormTokens = [
  'owner: customer?.owner ?? ""',
  'owner: opportunity?.owner ?? ""',
];

for (const token of removedOwnerFormTokens) {
  assert.ok(!appSource.includes(token), `Owner must stay out of the create/edit forms (v0.9.2): found ${token}`);
}

for (const token of emptyCreateFormTokens) {
  assert.ok(appSource.includes(token), `Create forms should start empty: missing ${token}`);
}
