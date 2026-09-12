# Verified Provider Baseline

Verified 2026-09-12, Asia/Shanghai. This is supplier configuration and published
pricing evidence; it is not live quality or invoice reconciliation acceptance.

## Current Model Contract (2026-09-12)

- The current DeepSeek API documentation requires the model name
  `deepseek-flash`, which maps to DeepSeek-V4.1-Flash.
- `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are retired model names
  kept only for compatibility forwarding. New configuration must not use them.
- All text, JSON, tool-call, and image-understanding requests in this project
  use the same `deepseek-flash` model. Image and PDF pages remain subject to the
  existing bounded media pipeline; there is no separate invented per-page fee.
- The official source is the DeepSeek pricing page linked below. Pricing is
  recorded as an immutable CNY calendar in the AI Platform ledger.

## Prior Production Account Snapshot (2026-09-10)

- Production release remained v0.12.3 / `3209a073486e22370307a6f46021ac9cf2ec71d1`.
- Read-only `GET https://api.deepseek.com/models` returned HTTP 200 and listed
  the then-visible legacy model names. This snapshot predates the current
  `deepseek-flash` contract and is retained only as historical evidence.
- Read-only `GET /user/balance` returned HTTP 200, available=true, currency CNY.
  No balance amount or credential is recorded here.
- The request used the existing active encrypted secure setting, without
  changing it or making a paid completion request.
- The execution-agent selection `gpt-5.6-luna/max` does not change this business
  supplier account. Platform policy selects the real deployed model explicitly.
- No existing ASR credential or active live ASR configuration has been established.
  Do not enable an invented ASR provider or claim live ASR quality from fixtures.

## Published Rates

Source retrieved:
https://api-docs.deepseek.com/zh-cn/quick_start/pricing/

For `deepseek-flash` / DeepSeek-V4.1-Flash, CNY per million tokens:

| Unit | Off-peak | Peak |
| --- | ---: | ---: |
| Uncached input | 1 | 2 |
| Cached input | 0.02 | 0.04 |
| Output | 4 | 8 |

Peak hours are Monday-Friday 09:00-12:00 and 14:00-18:00 Asia/Shanghai.
All other times use off-peak rates. Images count as input tokens; they do not
receive an additional invented per-page fee.

The platform's per-1,000-token micro-CNY rates are therefore:

| Unit | Off-peak | Peak |
| --- | ---: | ---: |
| Uncached input | 1000 | 2000 |
| Cached input | 20 | 40 |
| Output | 4000 | 8000 |

Budget reserves use the peak ceiling. The immutable calendar attached to a price
version chooses the tier using the attempt start instant. Attempts retain the
calendar version, tier and timestamp. Calculated cost remains distinct from
supplier invoice settlement; network delay across a tier boundary must be
reconciled with the supplier request ID.

Credential values are excluded from this document, policy JSON, browser state,
Git and ordinary logs. Source and model names must be rechecked before cutover.
