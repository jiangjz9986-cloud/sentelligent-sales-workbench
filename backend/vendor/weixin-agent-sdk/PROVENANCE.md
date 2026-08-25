Upstream package: weixin-agent-sdk
Upstream version: 0.5.0
License: MIT
Tarball integrity: sha512-Jp9mJc6Q4b3JnRlRjsuwSoJIiR8V4dmkZpiG9jGsZ3h+taFQ955DuNeOLyQSy1O8AgwSf1OlqBgIwnnQHWyb0Q==
Tarball SHA-256: 2a7a50d920aa0dd664d59256841022c738581d465369a1cda7c9ade0446dd784
Retrieved: 2026-08-12
Fork version: 0.5.0-sentelligent.9
Allowed modified files: dist/index.mjs, dist/index.d.mts, package.json, PROVENANCE.md
Purpose: expose bounded inbound delivery and quoted-message metadata, derive opaque delivery identity, remove unsafe production logging/debug commands, enforce host authorization plus bounded inbound media handling, support restart-safe proactive delivery through AES-256-GCM encrypted 23-hour context-token persistence bound to account, recipient, expiry, and host delivery key, return the generated outbound message id for exact quoted-reply routing, prefer the strict `sentelligent:<64hex>` outbound client id when a quoted reference also carries a provider message id, accept the provider's empty/whitespace-only or empty-object HTTP-success acknowledgement while rejecting explicit non-zero or malformed non-empty status fields, support caller-supplied bounded client ids for replay-safe proactive sends, advance the inbound cursor after a durable agent result even when only its outbound reply delivery fails so later messages are not blocked or replayed, and strip only a digest-and-zero-field verified 24-byte Weixin JPEG provider trailer before media persistence and hashing while leaving every mismatch unchanged for downstream fail-closed validation.
