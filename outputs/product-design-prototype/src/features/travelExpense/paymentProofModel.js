function paymentIdsFor(expense) {
  return Array.isArray(expense?.payments)
    ? expense.payments.map((payment) => payment?.id).filter(Boolean)
    : [];
}

export function createPaymentProofSelection() {
  return [];
}

export function togglePaymentProofPayment(selection, paymentId, expense) {
  const validPaymentIds = paymentIdsFor(expense);
  if (!validPaymentIds.includes(paymentId)) {
    throw new TypeError("付款记录不存在");
  }

  const selected = new Set(Array.isArray(selection) ? selection : []);
  if (selected.has(paymentId)) selected.delete(paymentId);
  else selected.add(paymentId);

  return validPaymentIds.filter((id) => selected.has(id));
}

export function validatePaymentProofSelection(selection, expense) {
  const validPaymentIds = paymentIdsFor(expense);
  const requested = new Set(Array.isArray(selection) ? selection.filter(Boolean) : []);

  if (!requested.size) {
    throw new TypeError("至少选择一笔付款");
  }
  if ([...requested].some((id) => !validPaymentIds.includes(id))) {
    throw new TypeError("付款记录不存在");
  }

  return validPaymentIds.filter((id) => requested.has(id));
}
