const DOCUMENT_PROMPTS = Object.freeze({
  payment_proof: [
    "识别这些付款凭证页面，只输出合法 JSON，不输出解释或 Markdown。",
    "顶层仅允许字段 documentKind、amountCents、occurredOn、occurredOnYearExplicit、paidTime、merchant、paymentMethod、transactions、confidence、warnings。",
    "documentKind 只能为 payment_proof 或 invoice；只有画面明确包含正式发票要素（如发票号码、购买方、销售方、税额或价税合计）时才返回 invoice，否则返回 payment_proof。",
    "amountCents 必须是正整数分且使用 JSON 数字；occurredOn 有明确年份时为 YYYY-MM-DD、只有月日时为 MM-DD；paidTime 为 HH:mm。",
    "occurredOnYearExplicit 必须是 JSON 布尔值，只表示年份是否在凭证画面中明确出现；有日期但画面只有月日时返回 false，没有日期时 occurredOn 返回 null 且 occurredOnYearExplicit 返回 false。",
    "paymentMethod 只能为 wechat、alipay、bank_card、cash、other。",
    "transactions 只用于同一附件中清晰存在的多笔独立付款，按页面及画面从上到下顺序返回，最多 20 笔；否则返回空数组。",
    "transactions 每一项只能包含 amountCents、occurredOn、occurredOnYearExplicit、paidTime、merchant、paymentMethod；每项都必须独立返回 occurredOnYearExplicit；amountCents 必须为正整数分，其余字段没有清晰依据时返回 null。",
    "手机或系统状态栏时间绝不是支付时间，必须忽略；paidTime 只能取带有支付、付款、交易、成交或消费语义的时间，没有这类依据时返回 null。",
    "单一付款详情页中的原价、优惠、折扣、合计和实付是同一笔付款，不能拆成多笔 transactions；该页只取最终实付金额。",
    "没有清晰视觉依据的字段返回 null；warnings 只能包含大写下划线代码。",
  ].join("\n"),
  invoice: [
    "识别这些发票页面，只输出合法 JSON，不输出解释或 Markdown。",
    "仅允许字段 invoiceCode、invoiceNumber、issuedOn、sellerName、buyerName、amountExTaxCents、taxCents、totalCents、suggestedCategory。",
    "金额字段为非负整数分；issuedOn 为 YYYY-MM-DD。",
    "suggestedCategory 只能为 breakfast、lunch、dinner、lodging、transport、hospitality、other。",
    "没有清晰视觉依据的字段返回 null。",
  ].join("\n"),
});

export function documentVisionPrompt(documentKind, referenceDate) {
  const base = DOCUMENT_PROMPTS[documentKind];
  if (!base || documentKind !== "payment_proof" || !referenceDate) return base;
  return [
    base,
    `参考日期是 ${referenceDate}（Asia/Shanghai），只交给服务端解析日期，不能作为凭证画面中出现年份的证据。`,
    "年份是否明确只按画面判断；仅有月日时返回 MM-DD 和 occurredOnYearExplicit=false，由服务端根据参考日期确定年份。",
    "凭证有完整年月日时保持原值并返回 occurredOnYearExplicit=true；凭证没有日期时仍返回 null，不能用参考日期代替。",
  ].join("\n");
}
