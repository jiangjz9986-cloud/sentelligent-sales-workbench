import { createRoot } from "react-dom/client";

import { PaymentRecordPrintPreview } from "../../src/features/travelExpense/PaymentRecordPrintPreview.jsx";
import "../../src/features/travelExpense/travelExpense.css";

const attachments = [1, 2].map((number) => ({
  id: `qa-payment-pdf-${number}`,
  expenseId: "expense-1",
  paymentIds: ["payment-1"],
  kind: "payment_proof",
  fileName: `qa-payment-proof-${number}.pdf`,
  mediaType: "application/pdf",
  coveredCents: 4850,
}));

const expenses = [{
  id: "expense-1",
  referenceCode: "EXP-20260804-QA000001",
  occurredOn: "2026-08-04",
  category: "dinner",
  purpose: "QA 付款凭证",
  merchant: "QA 商户",
  invoiceStatus: "pending",
  notes: "",
  attachments,
  payments: [{
    id: "payment-1",
    paidAt: "2026-08-04T18:23:00+08:00",
    merchant: "QA 商户",
    amountCents: 4850,
    reimbursementCents: 4850,
    fundingSource: "personal",
    paymentMethod: "wechat",
    accountLast4: "1234",
    differenceReason: "",
  }],
}];

window.__paymentPrintCalls = 0;
window.print = () => {
  window.__paymentPrintCalls += 1;
};

createRoot(document.querySelector("#root")).render(
  <PaymentRecordPrintPreview
    expenses={expenses}
    summary={{
      expenseCount: 1,
      paymentCount: 1,
      paymentProofCount: 2,
      actualPaidCents: 4850,
      reimbursementCents: 4850,
    }}
    week={{ start: "2026-08-03", end: "2026-08-09" }}
    owner="QA"
    itineraryLabel="QA 行程"
    getAttachmentUrl={(attachmentId) => `/${attachmentId}.pdf`}
    getAttachmentContentResponse={(attachmentId, { signal } = {}) => fetch(`/${attachmentId}.pdf`, {
      method: "GET",
      credentials: "include",
      redirect: "error",
      headers: { Accept: "application/pdf" },
      signal,
    })}
    onClose={() => {}}
  />,
);
