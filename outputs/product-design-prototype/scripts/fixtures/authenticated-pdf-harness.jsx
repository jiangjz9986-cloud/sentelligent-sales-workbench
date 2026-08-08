import { createRoot } from "react-dom/client";

import { InvoicePrintPreview } from "../../src/features/travelExpense/InvoicePrintPreview.jsx";

const invoice = {
  id: "qa-authenticated-invoice",
  fileName: "qa-authenticated-invoice.pdf",
  mediaType: "application/pdf",
  invoiceNumber: "QA-0001",
  issuedOn: "2026-08-05",
  totalCents: 10000,
};

createRoot(document.querySelector("#root")).render(
  <InvoicePrintPreview
    invoices={[invoice]}
    week={{ start: "2026-08-03", end: "2026-08-09" }}
    owner="QA"
    getInvoiceContentUrl={() => "/qa-authenticated-invoice.pdf"}
    getInvoiceContentResponse={(_invoiceId, { signal } = {}) => fetch("/qa-authenticated-invoice.pdf", {
      method: "GET",
      credentials: "include",
      redirect: "error",
      headers: { Accept: "application/pdf" },
      signal,
    })}
    onClose={() => {}}
  />,
);
