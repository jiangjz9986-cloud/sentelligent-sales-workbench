import { createRoot } from "react-dom/client";

import { TravelExpensePage } from "../../src/features/travelExpense/TravelExpensePage.jsx";
import "../../src/styles/global.css";

const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Shanghai",
});

function dateKey(date) {
  return SHANGHAI_DATE_FORMATTER.format(date);
}

const occurredOn = dateKey(new Date());
const expense = {
  id: "expense-delete-test",
  version: 1,
  referenceCode: "EXP-QA-DELETE-001",
  occurredOn,
  category: "lunch",
  purpose: "浏览器验收午餐",
  notes: "本地删除流程 mock",
  invoiceStatus: "pending",
  payments: [{
    id: "payment-delete-test",
    paidAt: `${occurredOn}T04:00:00.000Z`,
    amountCents: 2200,
    reimbursementCents: 2200,
    fundingSource: "personal",
    paymentMethod: "wechat",
  }],
  attachments: [],
};

window.__expenseDeleteAttempts = 0;

const apiClient = {
  isEnabled: true,
  async getTravelExpenseWorkbench() {
    return { expenses: [expense], advances: [], bookkeepingReviews: [], regionProfile: null };
  },
  async listTravelExpenseDocumentInbox() { return []; },
  async listInvoiceMatches() { return []; },
  async listNoInvoiceConfirmations() { return []; },
  async getWeekInvoiceCoverage() {
    return { electronicInvoiceCoverageCents: 0, confirmedCoverageCents: 0, missingInvoiceCents: 2200 };
  },
  async deleteTravelExpense() {
    window.__expenseDeleteAttempts += 1;
    const error = new Error("ticket state blocks delete");
    error.code = "EXPENSE_HAS_ACTIVE_INVOICE_STATE";
    error.status = 409;
    error.details = { dependency: "confirmed_invoice_match" };
    throw error;
  },
  async listInvoices() { return []; },
  async listInvoiceCandidates() { return []; },
};

createRoot(document.querySelector("#root")).render(
  <TravelExpensePage apiClient={apiClient} backendStatus="connected" />,
);
