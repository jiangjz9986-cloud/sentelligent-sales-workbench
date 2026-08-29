import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

import { salesWorkbenchPageFiles } from "./pages-source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = [
  "../src/App.jsx",
  "../src/data/salesWorkbenchData.js",
  ...salesWorkbenchPageFiles(join(here, "..")).map((file) => `../${file}`),
]
  .map((relativePath) => readFileSync(join(here, relativePath), "utf8"))
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
  appSource.includes("setActive(\"customer\")") && appSource.includes("setActive(\"opportunity\")"),
  "Customer and opportunity detail pages must keep bidirectional navigation.",
);

const listRowContainers = appSource.match(/<article\b[^>]*className=\{`list-button customer-list-row[^>]*>/g) ?? [];
assert.ok(listRowContainers.length >= 5, "List/detail business pages should render reusable list row containers.");
for (const row of listRowContainers) {
  assert.ok(
    !row.includes("onClick"),
    "List row containers must stay structural only; use row buttons for selection and detail navigation.",
  );
}

const listRowMainButtons = appSource.match(/<button className="list-row-main" type="button" onClick=/g) ?? [];
assert.ok(
  listRowMainButtons.length >= listRowContainers.length,
  "Each business list row should expose a primary row button for keyboard and touch selection.",
);

assert.ok(
  appSource.includes('const [recordText, setRecordText] = useState("");'),
  "Quick record composer should open as a blank new-record input by default.",
);

const createDetailEntries = appSource.match(/data-testid="(?:customer|opportunity|knowledge)-create-detail"[\s\S]{0,260}?setViewMode\?\.\("create"\)/g) ?? [];
assert.equal(
  createDetailEntries.length,
  3,
  "Customer, opportunity, and knowledge header create buttons should open a create detail view directly.",
);

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
