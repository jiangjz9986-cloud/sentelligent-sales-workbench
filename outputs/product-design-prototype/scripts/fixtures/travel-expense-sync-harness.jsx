import { createRoot } from "react-dom/client";

import { TravelExpensePage } from "../../src/features/travelExpense/TravelExpensePage.jsx";
import "../../src/styles/global.css";

const mode = new URLSearchParams(window.location.search).get("mode");
window.__travelExpenseWorkbenchReads = 0;

function conflict(requestId) {
  return Object.assign(new Error("synthetic read conflict"), {
    status: 409,
    code: "SHORTCUT_LEDGER_RECEIPT_INCOMPLETE",
    requestId,
  });
}

const apiClient = {
  isEnabled: true,
  async getTravelExpenseWorkbench({ weekStart }) {
    window.__travelExpenseWorkbenchReads += 1;
    if (mode === "persistent-conflict") throw conflict("fixture-final-conflict");
    return {
      weekStart,
      expenses: [],
      advances: [],
      bookkeepingReviews: [],
      regionProfile: null,
      recentLedgerReceipts: [],
    };
  },
  async listTravelExpenseDocumentInbox() { return []; },
  async listInvoiceMatches() { return []; },
  async listNoInvoiceConfirmations() { return []; },
  async getWeekInvoiceCoverage() { return null; },
};

createRoot(document.querySelector("#root")).render(
  <TravelExpensePage apiClient={apiClient} backendStatus="connected" />,
);
