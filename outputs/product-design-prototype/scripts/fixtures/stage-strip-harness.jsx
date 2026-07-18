import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { StageStrip } from "../../src/components/primitives.jsx";

const fixture = new URLSearchParams(window.location.search).get("fixture");
const fixtures = {
  missing: [{ stage: "线索", count: 2 }],
  "real-amount": [{ stage: "线索", count: 2, amount: "真实金额 680 万" }],
};

flushSync(() => {
  createRoot(document.getElementById("root")).render(
    <StageStrip stageCounts={fixtures[fixture] ?? []} />,
  );
});

const snapshot = Array.from(document.querySelectorAll(".stage-card")).map((card) => ({
  stage: card.querySelector("span")?.textContent ?? "",
  count: card.querySelector("strong")?.textContent ?? "",
  amount: card.querySelector("small")?.textContent ?? null,
}));

document.body.dataset.stageStripSnapshot = encodeURIComponent(JSON.stringify(snapshot));
