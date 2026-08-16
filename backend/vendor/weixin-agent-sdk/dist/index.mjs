import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto, { createCipheriv, createDecipheriv, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs$1 from "node:fs/promises";
//#region src/storage/state-dir.ts
/** Resolve the OpenClaw state directory (mirrors core logic in src/infra). */
function resolveStateDir() {
	return process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
}
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
/** Normalize an account ID to a filesystem-safe string. */
function normalizeAccountId(raw) {
	return raw.trim().toLowerCase().replace(/[@.]/g, "-");
}
/**
* Pattern-based reverse of normalizeWeixinAccountId for known weixin ID suffixes.
* Used only as a compatibility fallback when loading accounts / sync bufs stored
* under the old raw ID.
* e.g. "b0f5860fdecb-im-bot" → "b0f5860fdecb@im.bot"
*/
function deriveRawAccountId(normalizedId) {
	if (normalizedId.endsWith("-im-bot")) return `${normalizedId.slice(0, -7)}@im.bot`;
	if (normalizedId.endsWith("-im-wechat")) return `${normalizedId.slice(0, -10)}@im.wechat`;
}
function resolveWeixinStateDir() {
	return path.join(resolveStateDir(), "openclaw-weixin");
}
function resolveAccountIndexPath() {
	return path.join(resolveWeixinStateDir(), "accounts.json");
}
/** Returns all accountIds registered via QR login. */
function listIndexedWeixinAccountIds() {
	const filePath = resolveAccountIndexPath();
	try {
		if (!fs.existsSync(filePath)) return [];
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((id) => typeof id === "string" && id.trim() !== "");
	} catch {
		return [];
	}
}
/** Register accountId as the sole account in the persistent index. */
function registerWeixinAccountId(accountId) {
	const dir = resolveWeixinStateDir();
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify([accountId], null, 2), "utf-8");
}
function resolveAccountsDir$1() {
	return path.join(resolveWeixinStateDir(), "accounts");
}
function resolveAccountPath(accountId) {
	return path.join(resolveAccountsDir$1(), `${accountId}.json`);
}
/**
* Legacy single-file token: `credentials/openclaw-weixin/credentials.json` (pre per-account files).
*/
function loadLegacyToken() {
	const legacyPath = path.join(resolveStateDir(), "credentials", "openclaw-weixin", "credentials.json");
	try {
		if (!fs.existsSync(legacyPath)) return void 0;
		const raw = fs.readFileSync(legacyPath, "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed.token === "string" ? parsed.token : void 0;
	} catch {
		return;
	}
}
function readAccountFile(filePath) {
	try {
		if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {}
	return null;
}
/** Load account data by ID, with compatibility fallbacks. */
function loadWeixinAccount(accountId) {
	const primary = readAccountFile(resolveAccountPath(accountId));
	if (primary) return primary;
	const rawId = deriveRawAccountId(accountId);
	if (rawId) {
		const compat = readAccountFile(resolveAccountPath(rawId));
		if (compat) return compat;
	}
	const token = loadLegacyToken();
	if (token) return { token };
	return null;
}
/**
* Persist account data after QR login (merges into existing file).
* - token: overwritten when provided.
* - baseUrl: stored when non-empty; resolveWeixinAccount falls back to DEFAULT_BASE_URL.
* - userId: set when `update.userId` is provided; omitted from file when cleared to empty.
*/
function saveWeixinAccount(accountId, update) {
	const dir = resolveAccountsDir$1();
	fs.mkdirSync(dir, { recursive: true });
	const existing = loadWeixinAccount(accountId) ?? {};
	const token = update.token?.trim() || existing.token;
	const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
	const userId = update.userId !== void 0 ? update.userId.trim() || void 0 : existing.userId?.trim() || void 0;
	const data = {
		...token ? {
			token,
			savedAt: (/* @__PURE__ */ new Date()).toISOString()
		} : {},
		...baseUrl ? { baseUrl } : {},
		...userId ? { userId } : {}
	};
	const filePath = resolveAccountPath(accountId);
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
	try {
		fs.chmodSync(filePath, 384);
	} catch {}
}
/** Remove account data file. */
function clearWeixinAccount(accountId) {
	try {
		fs.unlinkSync(resolveAccountPath(accountId));
	} catch {}
}
/** Remove all account data files and clear the account index. */
function clearAllWeixinAccounts() {
	const ids = listIndexedWeixinAccountIds();
	for (const id of ids) clearWeixinAccount(id);
	try {
		fs.writeFileSync(resolveAccountIndexPath(), "[]", "utf-8");
	} catch {}
}
/**
* Resolve the openclaw.json config file path.
* Checks OPENCLAW_CONFIG env var, then state dir.
*/
function resolveConfigPath() {
	const envPath = process.env.OPENCLAW_CONFIG?.trim();
	if (envPath) return envPath;
	return path.join(resolveStateDir(), "openclaw.json");
}
/**
* Read `routeTag` from openclaw.json (for callers without an `OpenClawConfig` object).
* Checks per-account `channels.<id>.accounts[accountId].routeTag` first, then section-level
* `channels.<id>.routeTag`. Matches `feat_weixin_extension` behavior; channel key is `"openclaw-weixin"`.
*/
function loadConfigRouteTag(accountId) {
	try {
		const configPath = resolveConfigPath();
		if (!fs.existsSync(configPath)) return void 0;
		const raw = fs.readFileSync(configPath, "utf-8");
		const section = JSON.parse(raw).channels?.["openclaw-weixin"];
		if (!section) return void 0;
		if (accountId) {
			const tag = section.accounts?.[accountId]?.routeTag;
			if (typeof tag === "number") return String(tag);
			if (typeof tag === "string" && tag.trim()) return tag.trim();
		}
		if (typeof section.routeTag === "number") return String(section.routeTag);
		return typeof section.routeTag === "string" && section.routeTag.trim() ? section.routeTag.trim() : void 0;
	} catch {
		return;
	}
}
/** List accountIds from the index file (written at QR login). */
function listWeixinAccountIds() {
	return listIndexedWeixinAccountIds();
}
/** Resolve a weixin account by ID, reading stored credentials. */
function resolveWeixinAccount(accountId) {
	const raw = accountId?.trim();
	if (!raw) throw new Error("weixin: accountId is required (no default account)");
	const id = normalizeAccountId(raw);
	const accountData = loadWeixinAccount(id);
	const token = accountData?.token?.trim() || void 0;
	return {
		accountId: id,
		baseUrl: accountData?.baseUrl?.trim() || "https://ilinkai.weixin.qq.com",
		cdnBaseUrl: CDN_BASE_URL,
		token,
		enabled: true,
		configured: Boolean(token)
	};
}
//#endregion
//#region src/util/logger.ts
/**
* Plugin logger — writes JSON lines to the main openclaw log file:
*   <tmpdir>/openclaw/openclaw-YYYY-MM-DD.log
* Same file and format used by all other channels.
*/
const MAIN_LOG_DIR = path.join(os.tmpdir(), "openclaw");
const SUBSYSTEM = "gateway/channels/openclaw-weixin";
const RUNTIME = "node";
const RUNTIME_VERSION = process.versions.node;
const HOSTNAME = os.hostname() || "unknown";
const PARENT_NAMES = ["openclaw"];
/** tslog-compatible level IDs (higher = more severe). */
const LEVEL_IDS = {
	TRACE: 1,
	DEBUG: 2,
	INFO: 3,
	WARN: 4,
	ERROR: 5,
	FATAL: 6
};
const DEFAULT_LOG_LEVEL = "INFO";
function resolveMinLevel() {
	const env = process.env.OPENCLAW_LOG_LEVEL?.toUpperCase();
	if (env && env in LEVEL_IDS) return LEVEL_IDS[env];
	return LEVEL_IDS[DEFAULT_LOG_LEVEL];
}
let minLevelId = resolveMinLevel();
/** Shift a Date into local time so toISOString() renders local clock digits. */
function toLocalISO(now) {
	const offsetMs = -now.getTimezoneOffset() * 6e4;
	const sign = offsetMs >= 0 ? "+" : "-";
	const abs = Math.abs(now.getTimezoneOffset());
	const offStr = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
	return new Date(now.getTime() + offsetMs).toISOString().replace("Z", offStr);
}
function localDateKey(now) {
	return toLocalISO(now).slice(0, 10);
}
function resolveMainLogPath() {
	const dateKey = localDateKey(/* @__PURE__ */ new Date());
	return path.join(MAIN_LOG_DIR, `openclaw-${dateKey}.log`);
}
let logDirEnsured = false;
function buildLoggerName(accountId) {
	return accountId ? `${SUBSYSTEM}/${accountId}` : SUBSYSTEM;
}
function writeLog(level, message, accountId) {
	if ((LEVEL_IDS[level] ?? LEVEL_IDS.INFO) < minLevelId) return;
	const now = /* @__PURE__ */ new Date();
	const loggerName = buildLoggerName(accountId);
	const prefixedMessage = accountId ? `[${accountId}] ${message}` : message;
	const entry = JSON.stringify({
		"0": loggerName,
		"1": prefixedMessage,
		_meta: {
			runtime: RUNTIME,
			runtimeVersion: RUNTIME_VERSION,
			hostname: HOSTNAME,
			name: loggerName,
			parentNames: PARENT_NAMES,
			date: now.toISOString(),
			logLevelId: LEVEL_IDS[level] ?? LEVEL_IDS.INFO,
			logLevelName: level
		},
		time: toLocalISO(now)
	});
	try {
		if (!logDirEnsured) {
			fs.mkdirSync(MAIN_LOG_DIR, { recursive: true });
			logDirEnsured = true;
		}
		fs.appendFileSync(resolveMainLogPath(), `${entry}\n`, "utf-8");
	} catch {}
}
/** Creates a logger instance, optionally bound to a specific account. */
function createLogger(accountId) {
	return {
		info(message) {
			writeLog("INFO", message, accountId);
		},
		debug(message) {
			writeLog("DEBUG", message, accountId);
		},
		warn(message) {
			writeLog("WARN", message, accountId);
		},
		error(message) {
			writeLog("ERROR", message, accountId);
		},
		withAccount(id) {
			return createLogger(id);
		},
		getLogFilePath() {
			return resolveMainLogPath();
		},
		close() {}
	};
}
const logger = createLogger();
//#endregion
//#region src/util/redact.ts
const DEFAULT_BODY_MAX_LEN = 200;
const DEFAULT_TOKEN_PREFIX_LEN = 6;
/**
* Truncate a string, appending a length indicator when trimmed.
* Returns `""` for empty/undefined input.
*/
function truncate(s, max) {
	if (!s) return "";
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…(len=${s.length})`;
}
/**
* Redact a token/secret: show only the first few chars + total length.
* Returns `"(none)"` when absent.
*/
function redactToken(token, prefixLen = DEFAULT_TOKEN_PREFIX_LEN) {
	if (!token) return "(none)";
	if (token.length <= prefixLen) return `****(len=${token.length})`;
	return `${token.slice(0, prefixLen)}…(len=${token.length})`;
}
/**
* Truncate a JSON body string to `maxLen` chars for safe logging.
* Appends original length so the reader knows how much was dropped.
*/
function redactBody(body, maxLen = DEFAULT_BODY_MAX_LEN) {
	if (!body) return "(empty)";
	if (body.length <= maxLen) return body;
	return `${body.slice(0, maxLen)}…(truncated, totalLen=${body.length})`;
}
/**
* Strip query string (which often contains signatures/tokens) from a URL,
* keeping only origin + pathname.
*/
function redactUrl(rawUrl) {
	try {
		const u = new URL(rawUrl);
		const base = `${u.origin}${u.pathname}`;
		return u.search ? `${base}?<redacted>` : base;
	} catch {
		return truncate(rawUrl, 80);
	}
}
//#endregion
//#region src/api/api.ts
function readChannelVersion() {
	try {
		const dir = path.dirname(fileURLToPath(import.meta.url));
		const pkgPath = path.resolve(dir, "..", "..", "package.json");
		return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version ?? "unknown";
	} catch {
		return "unknown";
	}
}
const CHANNEL_VERSION = readChannelVersion();
/** Build the `base_info` payload included in every API request. */
function buildBaseInfo() {
	return { channel_version: CHANNEL_VERSION };
}
/** Default timeout for long-poll getUpdates requests. */
const DEFAULT_LONG_POLL_TIMEOUT_MS$1 = 35e3;
/** Default timeout for regular API requests (sendMessage, getUploadUrl). */
const DEFAULT_API_TIMEOUT_MS = 15e3;
/** Default timeout for lightweight API requests (getConfig, sendTyping). */
const DEFAULT_CONFIG_TIMEOUT_MS = 1e4;
function ensureTrailingSlash(url) {
	return url.endsWith("/") ? url : `${url}/`;
}
/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin() {
	const uint32 = crypto.randomBytes(4).readUInt32BE(0);
	return Buffer.from(String(uint32), "utf-8").toString("base64");
}
/** Build headers shared by both GET and POST requests. */
function buildCommonHeaders() {
	const headers = {};
	const routeTag = loadConfigRouteTag();
	if (routeTag) headers.SKRouteTag = routeTag;
	return headers;
}
function buildHeaders(opts) {
	const headers = {
		"Content-Type": "application/json",
		AuthorizationType: "ilink_bot_token",
		"Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
		"X-WECHAT-UIN": randomWechatUin(),
		...buildCommonHeaders()
	};
	if (opts.token?.trim()) headers.Authorization = `Bearer ${opts.token.trim()}`;
	return headers;
}
/**
* GET fetch wrapper: send a GET request to a Weixin API endpoint with timeout + abort.
* Query parameters should already be encoded in `endpoint`.
* Returns the raw response text on success; throws on HTTP error or timeout.
*/
async function apiGetFetch(params) {
	const base = ensureTrailingSlash(params.baseUrl);
	const url = new URL(params.endpoint, base);
	const hdrs = buildCommonHeaders();
	const startedAt = Date.now();
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), params.timeoutMs);
	try {
		const res = await fetch(url.toString(), {
			method: "GET",
			headers: hdrs,
			signal: controller.signal
		});
		clearTimeout(t);
		const rawText = await res.text();
		logger.debug(`${params.label} category=http status=${res.status} bytes=${Buffer.byteLength(rawText, "utf8")} durationMs=${Date.now() - startedAt}`);
		if (!res.ok) throw new Error(`${params.label} HTTP ${res.status}`);
		return rawText;
	} catch (err) {
		clearTimeout(t);
		throw err;
	}
}
/**
* Common fetch wrapper: POST JSON to a Weixin API endpoint with timeout + abort.
* Returns the raw response text on success; throws on HTTP error or timeout.
*/
async function apiFetch(params) {
	const base = ensureTrailingSlash(params.baseUrl);
	const url = new URL(params.endpoint, base);
	const hdrs = buildHeaders({
		token: params.token,
		body: params.body
	});
	const startedAt = Date.now();
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), params.timeoutMs);
	const onAbort = () => controller.abort();
	params.abortSignal?.addEventListener("abort", onAbort, { once: true });
	try {
		const res = await fetch(url.toString(), {
			method: "POST",
			headers: hdrs,
			body: params.body,
			signal: controller.signal
		});
		clearTimeout(t);
		const rawText = await res.text();
		logger.debug(`${params.label} category=http status=${res.status} bytes=${Buffer.byteLength(rawText, "utf8")} durationMs=${Date.now() - startedAt}`);
		if (!res.ok) throw new Error(`${params.label} HTTP ${res.status}`);
		return rawText;
	} catch (err) {
		clearTimeout(t);
		throw err;
	} finally {
		params.abortSignal?.removeEventListener("abort", onAbort);
	}
}
/**
* Long-poll getUpdates. Server should hold the request until new messages or timeout.
*
* On client-side timeout (no server response within timeoutMs), returns an empty response
* with ret=0 so the caller can simply retry. This is normal for long-poll.
*/
async function getUpdates(params) {
	const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS$1;
	try {
		const rawText = await apiFetch({
			baseUrl: params.baseUrl,
			endpoint: "ilink/bot/getupdates",
			body: JSON.stringify({
				get_updates_buf: params.get_updates_buf ?? "",
				base_info: buildBaseInfo()
			}),
			token: params.token,
			timeoutMs: timeout,
			label: "getUpdates",
			abortSignal: params.abortSignal
		});
		return JSON.parse(rawText);
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			logger.debug(`getUpdates: client-side timeout after ${timeout}ms, returning empty response`);
			return {
				ret: 0,
				msgs: [],
				get_updates_buf: params.get_updates_buf
			};
		}
		throw err;
	}
}
/** Get a pre-signed CDN upload URL for a file. */
async function getUploadUrl(params) {
	const rawText = await apiFetch({
		baseUrl: params.baseUrl,
		endpoint: "ilink/bot/getuploadurl",
		body: JSON.stringify({
			filekey: params.filekey,
			media_type: params.media_type,
			to_user_id: params.to_user_id,
			rawsize: params.rawsize,
			rawfilemd5: params.rawfilemd5,
			filesize: params.filesize,
			thumb_rawsize: params.thumb_rawsize,
			thumb_rawfilemd5: params.thumb_rawfilemd5,
			thumb_filesize: params.thumb_filesize,
			no_need_thumb: params.no_need_thumb,
			aeskey: params.aeskey,
			base_info: buildBaseInfo()
		}),
		token: params.token,
		timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
		label: "getUploadUrl"
	});
	return JSON.parse(rawText);
}
/** Send a single message downstream. */
async function sendMessage(params) {
	await apiFetch({
		baseUrl: params.baseUrl,
		endpoint: "ilink/bot/sendmessage",
		body: JSON.stringify({
			...params.body,
			base_info: buildBaseInfo()
		}),
		token: params.token,
		timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
		label: "sendMessage"
	});
}
/** Fetch bot config (includes typing_ticket) for a given user. */
async function getConfig(params) {
	const rawText = await apiFetch({
		baseUrl: params.baseUrl,
		endpoint: "ilink/bot/getconfig",
		body: JSON.stringify({
			ilink_user_id: params.ilinkUserId,
			context_token: params.contextToken,
			base_info: buildBaseInfo()
		}),
		token: params.token,
		timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
		label: "getConfig"
	});
	return JSON.parse(rawText);
}
/** Send a typing indicator to a user. */
async function sendTyping(params) {
	await apiFetch({
		baseUrl: params.baseUrl,
		endpoint: "ilink/bot/sendtyping",
		body: JSON.stringify({
			...params.body,
			base_info: buildBaseInfo()
		}),
		token: params.token,
		timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
		label: "sendTyping"
	});
}
//#endregion
//#region src/auth/login-qr.ts
const ACTIVE_LOGIN_TTL_MS = 5 * 6e4;
/** Client-side timeout for the get_bot_qrcode request. */
const GET_QRCODE_TIMEOUT_MS = 5e3;
/** Client-side timeout for the long-poll get_qrcode_status request. */
const QR_LONG_POLL_TIMEOUT_MS = 35e3;
/** Fixed API base URL for all QR code requests. */
const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const activeLogins = /* @__PURE__ */ new Map();
function isLoginFresh(login) {
	return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}
/** Remove all expired entries from the activeLogins map to prevent memory leaks. */
function purgeExpiredLogins() {
	for (const [id, login] of activeLogins) if (!isLoginFresh(login)) activeLogins.delete(id);
}
async function fetchQRCode(apiBaseUrl, botType) {
	logger.info("fetchQRCode category=login status=started durationMs=0");
	const rawText = await apiGetFetch({
		baseUrl: apiBaseUrl,
		endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
		timeoutMs: GET_QRCODE_TIMEOUT_MS,
		label: "fetchQRCode"
	});
	return JSON.parse(rawText);
}
async function pollQRStatus(apiBaseUrl, qrcode) {
	logger.debug("pollQRStatus category=login status=polling durationMs=0");
	try {
		const rawText = await apiGetFetch({
			baseUrl: apiBaseUrl,
			endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
			timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
			label: "pollQRStatus"
		});
		return JSON.parse(rawText);
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			logger.debug(`pollQRStatus: client-side timeout after ${QR_LONG_POLL_TIMEOUT_MS}ms, returning wait`);
			return { status: "wait" };
		}
		logger.warn("pollQRStatus category=login status=retry durationMs=0");
		return { status: "wait" };
	}
}
async function startWeixinLoginWithQr(opts) {
	const sessionKey = opts.accountId || randomUUID();
	purgeExpiredLogins();
	const existing = activeLogins.get(sessionKey);
	if (!opts.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) return {
		qrcodeUrl: existing.qrcodeUrl,
		message: "二维码已就绪，请使用微信扫描。",
		sessionKey
	};
	try {
		const botType = opts.botType || "3";
		logger.info("startWeixinLogin category=login status=started durationMs=0");
		const qrResponse = await fetchQRCode(FIXED_BASE_URL, botType);
		logger.info(`startWeixinLogin category=login bytes=${Buffer.byteLength(qrResponse.qrcode_img_content ?? "", "utf8")} status=qr-received durationMs=0`);
		const login = {
			sessionKey,
			id: randomUUID(),
			qrcode: qrResponse.qrcode,
			qrcodeUrl: qrResponse.qrcode_img_content,
			startedAt: Date.now()
		};
		activeLogins.set(sessionKey, login);
		return {
			qrcodeUrl: qrResponse.qrcode_img_content,
			message: "使用微信扫描以下二维码，以完成连接。",
			sessionKey
		};
	} catch (err) {
		logger.error("startWeixinLogin category=login status=failed durationMs=0");
		return {
			message: `Failed to start login: ${String(err)}`,
			sessionKey
		};
	}
}
const MAX_QR_REFRESH_COUNT = 3;
async function waitForWeixinLogin(opts) {
	let activeLogin = activeLogins.get(opts.sessionKey);
	if (!activeLogin) {
		logger.warn("waitForWeixinLogin category=login status=missing-session durationMs=0");
		return {
			connected: false,
			message: "当前没有进行中的登录，请先发起登录。"
		};
	}
	if (!isLoginFresh(activeLogin)) {
		logger.warn("waitForWeixinLogin category=login status=expired durationMs=0");
		activeLogins.delete(opts.sessionKey);
		return {
			connected: false,
			message: "二维码已过期，请重新生成。"
		};
	}
	const timeoutMs = Math.max(opts.timeoutMs ?? 48e4, 1e3);
	const deadline = Date.now() + timeoutMs;
	let scannedPrinted = false;
	let qrRefreshCount = 1;
	activeLogin.currentApiBaseUrl = FIXED_BASE_URL;
	logger.info("Starting to poll QR code status...");
	while (Date.now() < deadline) {
		try {
			const statusResponse = await pollQRStatus(activeLogin.currentApiBaseUrl ?? FIXED_BASE_URL, activeLogin.qrcode);
			logger.debug(`pollQRStatus: status=${statusResponse.status} hasBotToken=${Boolean(statusResponse.bot_token)} hasBotId=${Boolean(statusResponse.ilink_bot_id)}`);
			activeLogin.status = statusResponse.status;
			switch (statusResponse.status) {
				case "wait":
					if (opts.verbose) process.stdout.write(".");
					break;
				case "scaned":
					if (!scannedPrinted) {
						process.stdout.write("\n👀 已扫码，在微信继续操作...\n");
						scannedPrinted = true;
					}
					break;
				case "expired":
					qrRefreshCount++;
					if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
						logger.warn("waitForWeixinLogin category=login status=expired-limit durationMs=0");
						activeLogins.delete(opts.sessionKey);
						return {
							connected: false,
							message: "登录超时：二维码多次过期，请重新开始登录流程。"
						};
					}
					process.stdout.write(`\n⏳ 二维码已过期，正在刷新...(${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
					logger.info(`waitForWeixinLogin: QR expired, refreshing (${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})`);
					try {
						const qrResponse = await fetchQRCode(FIXED_BASE_URL, opts.botType || "3");
						activeLogin.qrcode = qrResponse.qrcode;
						activeLogin.qrcodeUrl = qrResponse.qrcode_img_content;
						activeLogin.startedAt = Date.now();
						scannedPrinted = false;
						logger.info(`waitForWeixinLogin category=login bytes=${Buffer.byteLength(qrResponse.qrcode_img_content ?? "", "utf8")} status=qr-refreshed durationMs=0`);
						process.stdout.write(`🔄 新二维码已生成，请重新扫描\n\n`);
						try {
							(await import("qrcode-terminal")).default.generate(qrResponse.qrcode_img_content, { small: true });
							process.stdout.write(`如果二维码未能成功展示，请用浏览器打开以下链接扫码：\n`);
							process.stdout.write(`${qrResponse.qrcode_img_content}\n`);
						} catch {
							process.stdout.write(`二维码未加载成功，请用浏览器打开以下链接扫码：\n`);
							process.stdout.write(`${qrResponse.qrcode_img_content}\n`);
						}
					} catch (refreshErr) {
						logger.error("waitForWeixinLogin category=login status=refresh-failed durationMs=0");
						activeLogins.delete(opts.sessionKey);
						return {
							connected: false,
							message: `刷新二维码失败: ${String(refreshErr)}`
						};
					}
					break;
				case "scaned_but_redirect": {
					const redirectHost = statusResponse.redirect_host;
					if (redirectHost) {
						activeLogin.currentApiBaseUrl = `https://${redirectHost}`;
						logger.info("waitForWeixinLogin category=login status=redirected durationMs=0");
					} else logger.warn(`waitForWeixinLogin: received scaned_but_redirect but redirect_host is missing, continuing with current host`);
					break;
				}
				case "confirmed":
					if (!statusResponse.ilink_bot_id) {
						activeLogins.delete(opts.sessionKey);
						logger.error("Login confirmed but ilink_bot_id missing from response");
						return {
							connected: false,
							message: "登录失败：服务器未返回 ilink_bot_id。"
						};
					}
					activeLogin.botToken = statusResponse.bot_token;
					activeLogins.delete(opts.sessionKey);
					logger.info("waitForWeixinLogin category=login status=confirmed durationMs=0");
					return {
						connected: true,
						botToken: statusResponse.bot_token,
						accountId: statusResponse.ilink_bot_id,
						baseUrl: statusResponse.baseurl,
						userId: statusResponse.ilink_user_id,
						message: "✅ 与微信连接成功！"
					};
			}
		} catch (err) {
			logger.error("waitForWeixinLogin category=login status=poll-failed durationMs=0");
			activeLogins.delete(opts.sessionKey);
			return {
				connected: false,
				message: `Login failed: ${String(err)}`
			};
		}
		await new Promise((r) => setTimeout(r, 1e3));
	}
	logger.warn(`waitForWeixinLogin category=login status=timeout durationMs=${timeoutMs}`);
	activeLogins.delete(opts.sessionKey);
	return {
		connected: false,
		message: "登录超时，请重试。"
	};
}
//#endregion
//#region src/cdn/aes-ecb.ts
/**
* Shared AES-128-ECB crypto utilities for CDN upload and download.
*/
/** Encrypt buffer with AES-128-ECB (PKCS7 padding is default). */
function encryptAesEcb(plaintext, key) {
	const cipher = createCipheriv("aes-128-ecb", key, null);
	return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
/** Decrypt buffer with AES-128-ECB (PKCS7 padding). */
function decryptAesEcb(ciphertext, key) {
	const decipher = createDecipheriv("aes-128-ecb", key, null);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
/** Compute AES-128-ECB ciphertext size (PKCS7 padding to 16-byte boundary). */
function aesEcbPaddedSize(plaintextSize) {
	return Math.ceil((plaintextSize + 1) / 16) * 16;
}
//#endregion
//#region src/cdn/cdn-url.ts
/**
* Unified CDN URL construction for Weixin CDN upload/download.
*/
/** Build a CDN download URL from encrypt_query_param. */
function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl) {
	return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}
/** Build a CDN upload URL from upload_param and filekey. */
function buildCdnUploadUrl(params) {
	return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}
//#endregion
//#region src/cdn/cdn-upload.ts
/** Maximum retry attempts for CDN upload. */
const UPLOAD_MAX_RETRIES = 3;
/**
* Upload one buffer to the Weixin CDN with AES-128-ECB encryption.
* Returns the download encrypted_query_param from the CDN response.
* Retries up to UPLOAD_MAX_RETRIES times on server errors; client errors (4xx) abort immediately.
*/
async function uploadBufferToCdn(params) {
	const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, label, aeskey } = params;
	const ciphertext = encryptAesEcb(buf, aeskey);
	const trimmedFull = uploadFullUrl?.trim();
	let cdnUrl;
	if (trimmedFull) cdnUrl = trimmedFull;
	else if (uploadParam) cdnUrl = buildCdnUploadUrl({
		cdnBaseUrl,
		uploadParam,
		filekey
	});
	else throw new Error(`${label}: CDN upload URL missing (need upload_full_url or upload_param)`);
	logger.debug(`${label} category=cdn-upload bytes=${ciphertext.length} status=started durationMs=0`);
	let downloadParam;
	let lastError;
	for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) try {
		const res = await fetch(cdnUrl, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: new Uint8Array(ciphertext)
		});
		if (res.status >= 400 && res.status < 500) {
			logger.error(`${label} category=cdn-upload status=${res.status} durationMs=0`);
			throw new Error(`CDN upload client error ${res.status}`);
		}
		if (res.status !== 200) {
			logger.error(`${label} category=cdn-upload status=${res.status} durationMs=0`);
			throw new Error(`CDN upload server error ${res.status}`);
		}
		downloadParam = res.headers.get("x-encrypted-param") ?? void 0;
		if (!downloadParam) {
			logger.error(`${label}: CDN response missing x-encrypted-param header attempt=${attempt}`);
			throw new Error("CDN upload response missing x-encrypted-param header");
		}
		logger.debug(`${label} category=cdn-upload bytes=${ciphertext.length} status=200 durationMs=0`);
		break;
	} catch (err) {
		lastError = err;
		if (err instanceof Error && err.message.includes("client error")) throw err;
		if (attempt < UPLOAD_MAX_RETRIES) logger.error(`${label} category=cdn-upload status=retry durationMs=0`);
		else logger.error(`${label} category=cdn-upload status=failed durationMs=0`);
	}
	if (!downloadParam) throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
	return { downloadParam };
}
//#endregion
//#region src/media/mime.ts
const EXTENSION_TO_MIME = {
	".pdf": "application/pdf",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".txt": "text/plain",
	".csv": "text/csv",
	".zip": "application/zip",
	".tar": "application/x-tar",
	".gz": "application/gzip",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp"
};
const MIME_TO_EXTENSION = {
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/bmp": ".bmp",
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"video/webm": ".webm",
	"video/x-matroska": ".mkv",
	"video/x-msvideo": ".avi",
	"audio/mpeg": ".mp3",
	"audio/ogg": ".ogg",
	"audio/wav": ".wav",
	"application/pdf": ".pdf",
	"application/zip": ".zip",
	"application/x-tar": ".tar",
	"application/gzip": ".gz",
	"text/plain": ".txt",
	"text/csv": ".csv"
};
/** Get MIME type from filename extension. Returns "application/octet-stream" for unknown extensions. */
function getMimeFromFilename(filename) {
	return EXTENSION_TO_MIME[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}
/** Get file extension from MIME type. Returns ".bin" for unknown types. */
function getExtensionFromMime(mimeType) {
	return MIME_TO_EXTENSION[mimeType.split(";")[0].trim().toLowerCase()] ?? ".bin";
}
/** Get file extension from Content-Type header or URL path. Returns ".bin" for unknown. */
function getExtensionFromContentTypeOrUrl(contentType, url) {
	if (contentType) {
		const ext = getExtensionFromMime(contentType);
		if (ext !== ".bin") return ext;
	}
	const ext = path.extname(new URL(url).pathname).toLowerCase();
	return new Set(Object.keys(EXTENSION_TO_MIME)).has(ext) ? ext : ".bin";
}
//#endregion
//#region src/util/random.ts
/**
* Generate a prefixed unique ID using timestamp + crypto random bytes.
* Format: `{prefix}:{timestamp}-{8-char hex}`
*/
function generateId(prefix) {
	return `${prefix}:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}
/**
* Generate a temporary file name with random suffix.
* Format: `{prefix}-{timestamp}-{8-char hex}{ext}`
*/
function tempFileName(prefix, ext) {
	return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
}
//#endregion
//#region src/api/types.ts
/** proto: UploadMediaType */
const UploadMediaType = {
	IMAGE: 1,
	VIDEO: 2,
	FILE: 3,
	VOICE: 4
};
const MessageType = {
	NONE: 0,
	USER: 1,
	BOT: 2
};
const MessageItemType = {
	NONE: 0,
	TEXT: 1,
	IMAGE: 2,
	VOICE: 3,
	FILE: 4,
	VIDEO: 5
};
const MessageState = {
	NEW: 0,
	GENERATING: 1,
	FINISH: 2
};
/** Typing status: 1 = typing (default), 2 = cancel typing. */
const TypingStatus = {
	TYPING: 1,
	CANCEL: 2
};
//#endregion
//#region src/cdn/upload.ts
/**
* Download a remote media URL (image, video, file) to a local temp file in destDir.
* Returns the local file path; extension is inferred from Content-Type / URL.
*/
async function downloadRemoteImageToTemp(url, destDir) {
	const startedAt = Date.now();
	const res = await fetch(url);
	if (!res.ok) {
		logger.error(`downloadRemoteImageToTemp category=http status=${res.status} durationMs=${Date.now() - startedAt}`);
		throw new Error(`remote media download failed: HTTP ${res.status}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	logger.debug(`downloadRemoteImageToTemp category=http bytes=${buf.length} status=${res.status} durationMs=${Date.now() - startedAt}`);
	await fs$1.mkdir(destDir, { recursive: true });
	const ext = getExtensionFromContentTypeOrUrl(res.headers.get("content-type"), url);
	const name = tempFileName("weixin-remote", ext);
	const filePath = path.join(destDir, name);
	await fs$1.writeFile(filePath, buf);
	return filePath;
}
/**
* Common upload pipeline: read file → hash → gen aeskey → getUploadUrl → uploadBufferToCdn → return info.
*/
async function uploadMediaToCdn(params) {
	const { filePath, toUserId, opts, cdnBaseUrl, mediaType, label } = params;
	const plaintext = await fs$1.readFile(filePath);
	const rawsize = plaintext.length;
	const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
	const filesize = aesEcbPaddedSize(rawsize);
	const filekey = crypto.randomBytes(16).toString("hex");
	const aeskey = crypto.randomBytes(16);
	logger.debug(`${label} category=media-upload bytes=${rawsize} status=prepared durationMs=0`);
	const uploadUrlResp = await getUploadUrl({
		...opts,
		filekey,
		media_type: mediaType,
		to_user_id: toUserId,
		rawsize,
		rawfilemd5,
		filesize,
		no_need_thumb: true,
		aeskey: aeskey.toString("hex")
	});
	const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
	const uploadParam = uploadUrlResp.upload_param;
	if (!uploadFullUrl && !uploadParam) {
		logger.error(`${label} category=media-upload status=missing-url durationMs=0`);
		throw new Error(`${label}: getUploadUrl returned no upload URL`);
	}
	const { downloadParam: downloadEncryptedQueryParam } = await uploadBufferToCdn({
		buf: plaintext,
		uploadFullUrl: uploadFullUrl || void 0,
		uploadParam: uploadParam ?? void 0,
		filekey,
		cdnBaseUrl,
		aeskey,
		label
	});
	return {
		filekey,
		downloadEncryptedQueryParam,
		aeskey: aeskey.toString("hex"),
		fileSize: rawsize,
		fileSizeCiphertext: filesize
	};
}
/** Upload a local image file to the Weixin CDN with AES-128-ECB encryption. */
async function uploadFileToWeixin(params) {
	return uploadMediaToCdn({
		...params,
		mediaType: UploadMediaType.IMAGE,
		label: "uploadFileToWeixin"
	});
}
/** Upload a local video file to the Weixin CDN. */
async function uploadVideoToWeixin(params) {
	return uploadMediaToCdn({
		...params,
		mediaType: UploadMediaType.VIDEO,
		label: "uploadVideoToWeixin"
	});
}
/**
* Upload a local file attachment (non-image, non-video) to the Weixin CDN.
* Uses media_type=FILE; no thumbnail required.
*/
async function uploadFileAttachmentToWeixin(params) {
	return uploadMediaToCdn({
		...params,
		mediaType: UploadMediaType.FILE,
		label: "uploadFileAttachmentToWeixin"
	});
}
//#endregion
//#region src/messaging/inbound.ts
/**
* contextToken is issued per-message by the Weixin getupdates API and must
* be echoed verbatim in every outbound send. It is not persisted: the monitor
* loop populates this map on each inbound message, and the outbound adapter
* reads it back when the agent sends a reply.
*/
const contextTokenStore = /* @__PURE__ */ new Map();
function contextTokenKey(accountId, userId) {
	return `${accountId}:${userId}`;
}
/** Store a context token for a given account+user pair. */
function setContextToken(accountId, userId, token) {
	const k = contextTokenKey(accountId, userId);
	contextTokenStore.set(k, token);
}
/** Retrieve the cached context token for a given account+user pair. */
function getContextToken(accountId, userId) {
	const k = contextTokenKey(accountId, userId);
	const val = contextTokenStore.get(k);
	logger.debug(`getContextToken category=context status=${val !== void 0 ? "found" : "missing"} durationMs=0`);
	return val;
}
/** Returns true if the message item is a media type (image, video, file, or voice). */
function isMediaItem(item) {
	return item.type === MessageItemType.IMAGE || item.type === MessageItemType.VIDEO || item.type === MessageItemType.FILE || item.type === MessageItemType.VOICE;
}
function bodyFromItemList(itemList) {
	if (!itemList?.length) return "";
	for (const item of itemList) {
		if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
			const text = String(item.text_item.text);
			const ref = item.ref_msg;
			if (!ref) return text;
			if (ref.message_item && isMediaItem(ref.message_item)) return text;
			const parts = [];
			if (ref.title) parts.push(ref.title);
			if (ref.message_item) {
				const refBody = bodyFromItemList([ref.message_item]);
				if (refBody) parts.push(refBody);
			}
			if (!parts.length) return text;
			return `[引用: ${parts.join(" | ")}]\n${text}`;
		}
		if (item.type === MessageItemType.VOICE && item.voice_item?.text) return item.voice_item.text;
	}
	return "";
}

// Bounded, pure inbound projection.  This deliberately accepts only the
// delivery fields the host needs; provider tokens and CDN metadata never cross
// the adapter boundary.
const DELIVERY_ID_DOMAIN = "sentelligent/weixin-delivery-id/v1";
const MAX_INBOUND_IDENTIFIER_LENGTH = 500;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/u;
function requireInboundIdentifier(value, name) {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_INBOUND_IDENTIFIER_LENGTH || CONTROL_CHARACTER_RE.test(value)) throw new TypeError(`invalid ${name}`);
	return value;
}
function validateRawUpdate(full) {
	if (full === null || typeof full !== "object" || Array.isArray(full)) throw new TypeError("invalid raw update");
	requireInboundIdentifier(full.from_user_id, "sender id");
	if (!Number.isSafeInteger(full.create_time_ms) || full.create_time_ms <= 0) throw new TypeError("invalid delivery timestamp");
	if (!Array.isArray(full.item_list) || full.item_list.length === 0) throw new TypeError("invalid item list");
	for (const name of ["message_id", "msg_id", "client_id"]) {
		const value = full[name];
		if (value !== void 0 && value !== null && value !== "") requireInboundIdentifier(value, "upstream message id");
	}
}
function oneCanonicalUpstreamId(full) {
	const candidates = [full.message_id, full.msg_id, full.client_id].filter((value) => value !== void 0 && value !== null && value !== "");
	if (candidates.length === 0) return null;
	if (new Set(candidates).size !== 1) throw new TypeError("ambiguous upstream message id");
	return candidates[0];
}
function hasUnrecognizedGroupSignal(full) {
	return ["group_id", "room_id", "chat_type", "is_group"].some((name) => Object.hasOwn(full, name));
}
function chatIdentityFromUpdate(full, chatMetadata) {
	const senderId = requireInboundIdentifier(full.from_user_id, "sender id");
	if (hasUnrecognizedGroupSignal(full)) throw new TypeError("unrecognized group metadata");
	if (chatMetadata === null || chatMetadata === void 0) return { senderId, conversationId: senderId, chatType: "direct" };
	if (typeof chatMetadata !== "object" || Array.isArray(chatMetadata)) throw new TypeError("invalid chat metadata");
	if (Object.keys(chatMetadata).some((name) => name !== "chatType" && name !== "groupId")) throw new TypeError("invalid chat metadata");
	const { chatType, groupId } = chatMetadata;
	if (chatType === "direct") {
		if (groupId !== void 0) throw new TypeError("contradictory direct/group metadata");
		return { senderId, conversationId: senderId, chatType: "direct" };
	}
	if (chatType !== "group") throw new TypeError("invalid chat metadata");
	const normalizedGroupId = requireInboundIdentifier(groupId, "group id");
	return { senderId, conversationId: normalizedGroupId, chatType: "group", groupId: normalizedGroupId };
}
function normalizedFileName(fileName) {
	if (typeof fileName !== "string" || CONTROL_CHARACTER_RE.test(fileName)) return null;
	const base = fileName.split(/[\\/]/u).filter(Boolean).at(-1);
	if (!base || base === "." || base === "..") return null;
	return base.normalize("NFC");
}
function canonicalMessageMaterial(itemList, media) {
	const itemTypes = itemList.map((item) => item?.type);
	if (itemTypes.some((type) => !Number.isSafeInteger(type))) throw new TypeError("invalid message item type");
	const material = { itemTypes, text: bodyFromItemList(itemList) };
	if (media !== null && media !== void 0) {
		if (typeof media !== "object" || !/^[0-9a-f]{64}$/u.test(media.sha256 ?? "")) throw new TypeError("invalid media sha256");
		material.mediaSha256 = media.sha256;
		material.fileName = normalizedFileName(media.fileName);
	}
	return { text: material.text, canonicalJson: JSON.stringify(material) };
}
function encodeDeliveryIdParts(parts) {
	return Buffer.concat(parts.map((part) => {
		const value = Buffer.from(part, "utf8");
		const length = Buffer.alloc(4);
		length.writeUInt32BE(value.byteLength);
		return Buffer.concat([length, value]);
	}));
}
function deliveryIdFromUpdate({ senderId, upstreamId, deliveryTimestampMs, material }, deliveryKey) {
	if (!(deliveryKey instanceof Uint8Array) || deliveryKey.byteLength !== 32) throw new TypeError("deliveryKey must be 32 bytes");
	const parts = upstreamId === null ? [DELIVERY_ID_DOMAIN, senderId, String(deliveryTimestampMs), material] : [DELIVERY_ID_DOMAIN, senderId, upstreamId];
	return `weixin:delivery:v1:${crypto.createHmac("sha256", deliveryKey).update(encodeDeliveryIdParts(parts)).digest("hex")}`;
}
function normalizeInboundUpdate(full, { deliveryKey, media = null, chatMetadata = null } = {}) {
	validateRawUpdate(full);
	const identity = chatIdentityFromUpdate(full, chatMetadata);
	const material = canonicalMessageMaterial(full.item_list, media);
	return Object.freeze({
		conversationId: identity.conversationId,
		text: material.text,
		...media?.requestMedia ? { media: media.requestMedia } : {},
		senderId: identity.senderId,
		messageId: deliveryIdFromUpdate({ senderId: identity.senderId, upstreamId: oneCanonicalUpstreamId(full), deliveryTimestampMs: full.create_time_ms, material: material.canonicalJson }, deliveryKey),
		chatType: identity.chatType,
		...identity.groupId ? { groupId: identity.groupId } : {},
		deliveryTimestampMs: full.create_time_ms
	});
}
//#endregion
//#region src/messaging/send.ts
function generateClientId() {
	return generateId("openclaw-weixin");
}
/**
* Convert markdown-formatted model reply to plain text for Weixin delivery.
* Preserves newlines; strips markdown syntax.
*/
function markdownToPlainText(text) {
	let result = text;
	result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => code.trim());
	result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
	result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	result = result.replace(/^\|[\s:|-]+\|$/gm, "");
	result = result.replace(/^\|(.+)\|$/gm, (_, inner) => inner.split("|").map((cell) => cell.trim()).join("  "));
	result = result.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/_(.+?)_/g, "$1").replace(/~~(.+?)~~/g, "$1").replace(/`(.+?)`/g, "$1");
	return result;
}
/** Build a SendMessageReq containing a single text message. */
function buildTextMessageReq(params) {
	const { to, text, contextToken, clientId } = params;
	const item_list = text ? [{
		type: MessageItemType.TEXT,
		text_item: { text }
	}] : [];
	return { msg: {
		from_user_id: "",
		to_user_id: to,
		client_id: clientId,
		message_type: MessageType.BOT,
		message_state: MessageState.FINISH,
		item_list: item_list.length ? item_list : void 0,
		context_token: contextToken ?? void 0
	} };
}
/** Build a SendMessageReq from a text payload. */
function buildSendMessageReq(params) {
	const { to, contextToken, text, clientId } = params;
	return buildTextMessageReq({
		to,
		text,
		contextToken,
		clientId
	});
}
/**
* Send a plain text message downstream.
* contextToken is required for all reply sends; missing it breaks conversation association.
*/
async function sendMessageWeixin(params) {
	const { to, text, opts } = params;
	if (!opts.contextToken) {
		logger.error("sendMessageWeixin category=send status=missing-context durationMs=0");
		throw new Error("sendMessageWeixin: contextToken is required");
	}
	const clientId = generateClientId();
	const req = buildSendMessageReq({
		to,
		contextToken: opts.contextToken,
		text,
		clientId
	});
	try {
		await sendMessage({
			baseUrl: opts.baseUrl,
			token: opts.token,
			timeoutMs: opts.timeoutMs,
			body: req
		});
	} catch (err) {
		logger.error("sendMessageWeixin category=send status=failed durationMs=0");
		throw err;
	}
	return { messageId: clientId };
}
/**
* Send one or more MessageItems (optionally preceded by a text caption) downstream.
* Each item is sent as its own request so that item_list always has exactly one entry.
*/
async function sendMediaItems(params) {
	const { to, text, mediaItem, opts, label } = params;
	const items = [];
	if (text) items.push({
		type: MessageItemType.TEXT,
		text_item: { text }
	});
	items.push(mediaItem);
	let lastClientId = "";
	for (const item of items) {
		lastClientId = generateClientId();
		const req = { msg: {
			from_user_id: "",
			to_user_id: to,
			client_id: lastClientId,
			message_type: MessageType.BOT,
			message_state: MessageState.FINISH,
			item_list: [item],
			context_token: opts.contextToken ?? void 0
		} };
		try {
			await sendMessage({
				baseUrl: opts.baseUrl,
				token: opts.token,
				timeoutMs: opts.timeoutMs,
				body: req
			});
		} catch (err) {
			logger.error(`${label} category=send status=failed durationMs=0`);
			throw err;
		}
	}
	logger.debug(`${label} category=send status=succeeded durationMs=0`);
	return { messageId: lastClientId };
}
/**
* Send an image message downstream using a previously uploaded file.
* Optionally include a text caption as a separate TEXT item before the image.
*
* ImageItem fields:
*   - media.encrypt_query_param: CDN download param
*   - media.aes_key: AES key, base64-encoded
*   - mid_size: original ciphertext file size
*/
async function sendImageMessageWeixin(params) {
	const { to, text, uploaded, opts } = params;
	if (!opts.contextToken) {
		logger.error("sendImageMessageWeixin category=send status=missing-context durationMs=0");
		throw new Error("sendImageMessageWeixin: contextToken is required");
	}
	logger.debug(`sendImageMessageWeixin category=send bytes=${uploaded.fileSize} status=prepared durationMs=0`);
	return sendMediaItems({
		to,
		text,
		mediaItem: {
			type: MessageItemType.IMAGE,
			image_item: {
				media: {
					encrypt_query_param: uploaded.downloadEncryptedQueryParam,
					aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
					encrypt_type: 1
				},
				mid_size: uploaded.fileSizeCiphertext
			}
		},
		opts,
		label: "sendImageMessageWeixin"
	});
}
/**
* Send a video message downstream using a previously uploaded file.
* VideoItem: media (CDN ref), video_size (ciphertext bytes).
* Includes an optional text caption sent as a separate TEXT item first.
*/
async function sendVideoMessageWeixin(params) {
	const { to, text, uploaded, opts } = params;
	if (!opts.contextToken) {
		logger.error("sendVideoMessageWeixin category=send status=missing-context durationMs=0");
		throw new Error("sendVideoMessageWeixin: contextToken is required");
	}
	return sendMediaItems({
		to,
		text,
		mediaItem: {
			type: MessageItemType.VIDEO,
			video_item: {
				media: {
					encrypt_query_param: uploaded.downloadEncryptedQueryParam,
					aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
					encrypt_type: 1
				},
				video_size: uploaded.fileSizeCiphertext
			}
		},
		opts,
		label: "sendVideoMessageWeixin"
	});
}
/**
* Send a file attachment downstream using a previously uploaded file.
* FileItem: media (CDN ref), file_name, len (plaintext bytes as string).
* Includes an optional text caption sent as a separate TEXT item first.
*/
async function sendFileMessageWeixin(params) {
	const { to, text, fileName, uploaded, opts } = params;
	if (!opts.contextToken) {
		logger.error("sendFileMessageWeixin category=send status=missing-context durationMs=0");
		throw new Error("sendFileMessageWeixin: contextToken is required");
	}
	return sendMediaItems({
		to,
		text,
		mediaItem: {
			type: MessageItemType.FILE,
			file_item: {
				media: {
					encrypt_query_param: uploaded.downloadEncryptedQueryParam,
					aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
					encrypt_type: 1
				},
				file_name: fileName,
				len: String(uploaded.fileSize)
			}
		},
		opts,
		label: "sendFileMessageWeixin"
	});
}
//#endregion
//#region src/messaging/send-media.ts
/**
* Upload a local file and send it as a weixin message, routing by MIME type:
*   video/*  → uploadVideoToWeixin        + sendVideoMessageWeixin
*   image/*  → uploadFileToWeixin         + sendImageMessageWeixin
*   else     → uploadFileAttachmentToWeixin + sendFileMessageWeixin
*
* Used by both the auto-reply deliver path (monitor.ts) and the outbound
* sendMedia path (channel.ts) so they stay in sync.
*/
async function sendWeixinMediaFile(params) {
	const { filePath, to, text, opts, cdnBaseUrl } = params;
	const mime = getMimeFromFilename(filePath);
	const uploadOpts = {
		baseUrl: opts.baseUrl,
		token: opts.token
	};
	if (mime.startsWith("video/")) {
		logger.info("[weixin] sendWeixinMediaFile category=media type=video status=uploading durationMs=0");
		const uploaded = await uploadVideoToWeixin({
			filePath,
			toUserId: to,
			opts: uploadOpts,
			cdnBaseUrl
		});
		logger.info(`[weixin] sendWeixinMediaFile category=media type=video bytes=${uploaded.fileSize} status=uploaded durationMs=0`);
		return sendVideoMessageWeixin({
			to,
			text,
			uploaded,
			opts
		});
	}
	if (mime.startsWith("image/")) {
		logger.info("[weixin] sendWeixinMediaFile category=media type=image status=uploading durationMs=0");
		const uploaded = await uploadFileToWeixin({
			filePath,
			toUserId: to,
			opts: uploadOpts,
			cdnBaseUrl
		});
		logger.info(`[weixin] sendWeixinMediaFile category=media type=image bytes=${uploaded.fileSize} status=uploaded durationMs=0`);
		return sendImageMessageWeixin({
			to,
			text,
			uploaded,
			opts
		});
	}
	const fileName = path.basename(filePath);
	logger.info("[weixin] sendWeixinMediaFile category=media type=file status=uploading durationMs=0");
	const uploaded = await uploadFileAttachmentToWeixin({
		filePath,
		fileName,
		toUserId: to,
		opts: uploadOpts,
		cdnBaseUrl
	});
	logger.info(`[weixin] sendWeixinMediaFile category=media type=file bytes=${uploaded.fileSize} status=uploaded durationMs=0`);
	return sendFileMessageWeixin({
		to,
		text,
		fileName,
		uploaded,
		opts
	});
}
//#endregion
//#region src/api/config-cache.ts
const CONFIG_CACHE_TTL_MS = 1440 * 60 * 1e3;
const CONFIG_CACHE_INITIAL_RETRY_MS = 2e3;
const CONFIG_CACHE_MAX_RETRY_MS = 3600 * 1e3;
/**
* Per-user getConfig cache with periodic random refresh (within 24h) and
* exponential-backoff retry (up to 1h) on failure.
*/
var WeixinConfigManager = class {
	cache = /* @__PURE__ */ new Map();
	constructor(apiOpts, log) {
		this.apiOpts = apiOpts;
		this.log = log;
	}
	async getForUser(userId, contextToken) {
		const now = Date.now();
		const entry = this.cache.get(userId);
		if (!entry || now >= entry.nextFetchAt) {
			let fetchOk = false;
			try {
				const resp = await getConfig({
					baseUrl: this.apiOpts.baseUrl,
					token: this.apiOpts.token,
					ilinkUserId: userId,
					contextToken
				});
				if (resp.ret === 0) {
					this.cache.set(userId, {
						config: { typingTicket: resp.typing_ticket ?? "" },
						everSucceeded: true,
						nextFetchAt: now + Math.random() * CONFIG_CACHE_TTL_MS,
						retryDelayMs: CONFIG_CACHE_INITIAL_RETRY_MS
					});
					this.log(`[weixin] category=config status=${entry?.everSucceeded ? "refreshed" : "cached"} durationMs=${Date.now() - now}`);
					fetchOk = true;
				}
			} catch (err) {
				this.log(`[weixin] category=config status=failed durationMs=${Date.now() - now}`);
			}
			if (!fetchOk) {
				const prevDelay = entry?.retryDelayMs ?? CONFIG_CACHE_INITIAL_RETRY_MS;
				const nextDelay = Math.min(prevDelay * 2, CONFIG_CACHE_MAX_RETRY_MS);
				if (entry) {
					entry.nextFetchAt = now + nextDelay;
					entry.retryDelayMs = nextDelay;
				} else this.cache.set(userId, {
					config: { typingTicket: "" },
					everSucceeded: false,
					nextFetchAt: now + CONFIG_CACHE_INITIAL_RETRY_MS,
					retryDelayMs: CONFIG_CACHE_INITIAL_RETRY_MS
				});
			}
		}
		return this.cache.get(userId)?.config ?? { typingTicket: "" };
	}
};
//#endregion
//#region src/api/session-guard.ts
const SESSION_PAUSE_DURATION_MS = 3600 * 1e3;
const pauseUntilMap = /* @__PURE__ */ new Map();
/** Pause all inbound/outbound API calls for `accountId` for one hour. */
function pauseSession(accountId) {
	const until = Date.now() + SESSION_PAUSE_DURATION_MS;
	pauseUntilMap.set(accountId, until);
	logger.info(`session-guard category=session status=paused durationMs=${SESSION_PAUSE_DURATION_MS}`);
}
/** Milliseconds remaining until the pause expires (0 when not paused). */
function getRemainingPauseMs(accountId) {
	const until = pauseUntilMap.get(accountId);
	if (until === void 0) return 0;
	const remaining = until - Date.now();
	if (remaining <= 0) {
		pauseUntilMap.delete(accountId);
		return 0;
	}
	return remaining;
}
//#endregion
//#region src/cdn/pic-decrypt.ts
/**
* Download raw bytes from the CDN (no decryption).
*/
async function fetchCdnBytes(url, label) {
	let res;
	try {
		res = await fetch(url);
	} catch (err) {
		logger.error(`${label} category=cdn-download status=network-error durationMs=0`);
		throw err;
	}
	logger.debug(`${label}: response status=${res.status} ok=${res.ok}`);
	if (!res.ok) {
		logger.error(`${label} category=cdn-download status=${res.status} durationMs=0`);
		throw new Error(`${label}: CDN download HTTP ${res.status}`);
	}
	return Buffer.from(await res.arrayBuffer());
}
/**
* Parse CDNMedia.aes_key into a raw 16-byte AES key.
*
* Two encodings are seen in the wild:
*   - base64(raw 16 bytes)          → images (aes_key from media field)
*   - base64(hex string of 16 bytes) → file / voice / video
*
* In the second case, base64-decoding yields 32 ASCII hex chars which must
* then be parsed as hex to recover the actual 16-byte key.
*/
function parseAesKey(aesKeyBase64, label) {
	const decoded = Buffer.from(aesKeyBase64, "base64");
	if (decoded.length === 16) return decoded;
	if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) return Buffer.from(decoded.toString("ascii"), "hex");
	logger.error(`${label} category=media-key bytes=${decoded.length} status=invalid durationMs=0`);
	throw new Error(`${label}: invalid media key`);
}
/**
* Download and AES-128-ECB decrypt a CDN media file. Returns plaintext Buffer.
* aesKeyBase64: CDNMedia.aes_key JSON field (see parseAesKey for supported formats).
*/
async function downloadAndDecryptBuffer(encryptedQueryParam, aesKeyBase64, cdnBaseUrl, label, fullUrl) {
	const key = parseAesKey(aesKeyBase64, label);
	const url = fullUrl || buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
	const encrypted = await fetchCdnBytes(url, label);
	logger.debug(`${label}: downloaded ${encrypted.byteLength} bytes, decrypting`);
	const decrypted = decryptAesEcb(encrypted, key);
	logger.debug(`${label}: decrypted ${decrypted.length} bytes`);
	return decrypted;
}
/**
* Download plain (unencrypted) bytes from the CDN. Returns the raw Buffer.
*/
async function downloadPlainCdnBuffer(encryptedQueryParam, cdnBaseUrl, label, fullUrl) {
	const url = fullUrl || buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
	return fetchCdnBytes(url, label);
}
//#endregion
//#region src/media/silk-transcode.ts
/** Default sample rate for Weixin voice messages. */
const SILK_SAMPLE_RATE = 24e3;
/**
* Wrap raw pcm_s16le bytes in a WAV container.
* Mono channel, 16-bit signed little-endian.
*/
function pcmBytesToWav(pcm, sampleRate) {
	const pcmBytes = pcm.byteLength;
	const totalSize = 44 + pcmBytes;
	const buf = Buffer.allocUnsafe(totalSize);
	let offset = 0;
	buf.write("RIFF", offset);
	offset += 4;
	buf.writeUInt32LE(totalSize - 8, offset);
	offset += 4;
	buf.write("WAVE", offset);
	offset += 4;
	buf.write("fmt ", offset);
	offset += 4;
	buf.writeUInt32LE(16, offset);
	offset += 4;
	buf.writeUInt16LE(1, offset);
	offset += 2;
	buf.writeUInt16LE(1, offset);
	offset += 2;
	buf.writeUInt32LE(sampleRate, offset);
	offset += 4;
	buf.writeUInt32LE(sampleRate * 2, offset);
	offset += 4;
	buf.writeUInt16LE(2, offset);
	offset += 2;
	buf.writeUInt16LE(16, offset);
	offset += 2;
	buf.write("data", offset);
	offset += 4;
	buf.writeUInt32LE(pcmBytes, offset);
	offset += 4;
	Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, offset);
	return buf;
}
/**
* Try to transcode a SILK audio buffer to WAV using silk-wasm.
* silk-wasm's decode() returns { data: Uint8Array (pcm_s16le), duration: number }.
*
* Returns a WAV Buffer on success, or null if silk-wasm is unavailable or decoding fails.
* Callers should fall back to passing the raw SILK file when null is returned.
*/
async function silkToWav(silkBuf) {
	try {
		const { decode } = await import("silk-wasm");
		logger.debug(`silkToWav: decoding ${silkBuf.length} bytes of SILK`);
		const result = await decode(silkBuf, SILK_SAMPLE_RATE);
		logger.debug(`silkToWav: decoded duration=${result.duration}ms pcmBytes=${result.data.byteLength}`);
		const wav = pcmBytesToWav(result.data, SILK_SAMPLE_RATE);
		logger.debug(`silkToWav: WAV size=${wav.length}`);
		return wav;
	} catch (err) {
		logger.warn("silkToWav category=media type=audio status=fallback durationMs=0");
		return null;
	}
}
//#endregion
//#region src/media/media-download.ts
const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
/**
* Download and decrypt media from a single MessageItem.
* Returns the populated WeixinInboundMediaOpts fields; empty object on unsupported type or failure.
*/
async function downloadMediaFromItem(item, deps) {
	const { cdnBaseUrl, saveMedia, log, errLog, label } = deps;
	const result = {};
	if (item.type === MessageItemType.IMAGE) {
		const img = item.image_item;
		if (!img?.media?.encrypt_query_param && !img?.media?.full_url) return result;
		const aesKeyBase64 = img.aeskey ? Buffer.from(img.aeskey, "hex").toString("base64") : img.media.aes_key;
		logger.debug(`${label} category=media type=image status=downloading durationMs=0`);
		try {
			const saved = await saveMedia(aesKeyBase64 ? await downloadAndDecryptBuffer(img.media.encrypt_query_param ?? "", aesKeyBase64, cdnBaseUrl, `${label} image`, img.media.full_url) : await downloadPlainCdnBuffer(img.media.encrypt_query_param ?? "", cdnBaseUrl, `${label} image-plain`, img.media.full_url), void 0, "inbound", WEIXIN_MEDIA_MAX_BYTES);
			result.decryptedPicPath = saved.path;
			result.sha256 = saved.sha256;
			result.fileName = saved.fileName;
			logger.debug(`${label} category=media type=image status=saved durationMs=0`);
		} catch (err) {
			logger.error(`${label} category=media type=image status=failed durationMs=0`);
			errLog(`weixin category=media type=image status=failed durationMs=0`);
		}
	} else if (item.type === MessageItemType.VOICE) {
		const voice = item.voice_item;
		if (!voice?.media?.encrypt_query_param && !voice?.media?.full_url || !voice?.media?.aes_key) return result;
		try {
			const silkBuf = await downloadAndDecryptBuffer(voice.media.encrypt_query_param ?? "", voice.media.aes_key, cdnBaseUrl, `${label} voice`, voice.media.full_url);
			const decryptedSha256 = crypto.createHash("sha256").update(silkBuf).digest("hex");
			logger.debug(`${label} category=media type=audio bytes=${silkBuf.length} status=decrypted durationMs=0`);
			const wavBuf = await silkToWav(silkBuf);
			if (wavBuf) {
				const saved = await saveMedia(wavBuf, "audio/wav", "inbound", WEIXIN_MEDIA_MAX_BYTES);
				result.decryptedVoicePath = saved.path;
				result.voiceMediaType = "audio/wav";
				result.sha256 = decryptedSha256;
				result.fileName = saved.fileName;
				logger.debug(`${label} category=media type=audio status=saved durationMs=0`);
			} else {
				const saved = await saveMedia(silkBuf, "audio/silk", "inbound", WEIXIN_MEDIA_MAX_BYTES);
				result.decryptedVoicePath = saved.path;
				result.voiceMediaType = "audio/silk";
				result.sha256 = decryptedSha256;
				result.fileName = saved.fileName;
				logger.debug(`${label} category=media type=audio status=saved-fallback durationMs=0`);
			}
		} catch (err) {
			logger.error(`${label} category=media type=audio status=failed durationMs=0`);
			errLog("weixin category=media type=audio status=failed durationMs=0");
		}
	} else if (item.type === MessageItemType.FILE) {
		const fileItem = item.file_item;
		if (!fileItem?.media?.encrypt_query_param && !fileItem?.media?.full_url || !fileItem?.media?.aes_key) return result;
		try {
			const buf = await downloadAndDecryptBuffer(fileItem.media.encrypt_query_param ?? "", fileItem.media.aes_key, cdnBaseUrl, `${label} file`, fileItem.media.full_url);
			const mime = getMimeFromFilename(fileItem.file_name ?? "file.bin");
			const saved = await saveMedia(buf, mime, "inbound", WEIXIN_MEDIA_MAX_BYTES, fileItem.file_name ?? void 0);
			result.decryptedFilePath = saved.path;
			result.fileMediaType = mime;
			result.sha256 = saved.sha256;
			result.fileName = saved.fileName;
			logger.debug(`${label} category=media type=file status=saved durationMs=0`);
		} catch (err) {
			logger.error(`${label} category=media type=file status=failed durationMs=0`);
			errLog("weixin category=media type=file status=failed durationMs=0");
		}
	} else if (item.type === MessageItemType.VIDEO) {
		const videoItem = item.video_item;
		if (!videoItem?.media?.encrypt_query_param && !videoItem?.media?.full_url || !videoItem?.media?.aes_key) return result;
		try {
			const saved = await saveMedia(await downloadAndDecryptBuffer(videoItem.media.encrypt_query_param ?? "", videoItem.media.aes_key, cdnBaseUrl, `${label} video`, videoItem.media.full_url), "video/mp4", "inbound", WEIXIN_MEDIA_MAX_BYTES);
			result.decryptedVideoPath = saved.path;
			result.sha256 = saved.sha256;
			result.fileName = saved.fileName;
			logger.debug(`${label} category=media type=video status=saved durationMs=0`);
		} catch (err) {
			logger.error(`${label} category=media type=video status=failed durationMs=0`);
			errLog("weixin category=media type=video status=failed durationMs=0");
		}
	}
	return result;
}
//#endregion
//#region src/messaging/error-notice.ts
/**
* Send a plain-text error notice back to the user.
* Fire-and-forget: errors are logged but never thrown, so callers stay unaffected.
* No-op when contextToken is absent (we have no conversation reference to reply into).
*/
async function sendWeixinErrorNotice(params) {
	if (!params.contextToken) {
		logger.warn("sendWeixinErrorNotice category=missing-context");
		return;
	}
	try {
		await sendMessageWeixin({
			to: params.to,
			text: params.message,
			opts: {
				baseUrl: params.baseUrl,
				token: params.token,
				contextToken: params.contextToken
			}
		});
		logger.debug("sendWeixinErrorNotice category=sent");
	} catch (err) {
		params.errLog("[weixin] category=error-notice-failed");
	}
}
//#endregion
//#region src/messaging/slash-commands.ts
/** 发送回复消息 */
async function sendReply(ctx, text) {
	const opts = {
		baseUrl: ctx.baseUrl,
		token: ctx.token,
		contextToken: ctx.contextToken
	};
	await sendMessageWeixin({
		to: ctx.to,
		text,
		opts
	});
}
/**
* 尝试处理斜杠指令
*
* @returns handled=true 表示该消息已作为指令处理，不需要继续走 AI 管道
*/
async function handleSlashCommand(content, ctx) {
	const trimmed = content.trim();
	if (!trimmed.startsWith("/")) return { handled: false };
	const spaceIdx = trimmed.indexOf(" ");
	const command = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
	try {
		switch (command) {
			case "/clear":
				ctx.onClear?.();
				await sendReply(ctx, "✅ 会话已清除，重新开始对话");
				ctx.log("[weixin] category=slash-command status=handled durationMs=0");
				return { handled: true, succeeded: true };
			default: return { handled: false };
		}
	} catch (err) {
		ctx.errLog("[weixin] category=slash-command status=failed durationMs=0");
		try {
			await sendReply(ctx, "❌ 指令执行失败");
		} catch {}
		return { handled: true, succeeded: false };
	}
}
//#endregion
//#region src/messaging/process-message.ts
const MEDIA_TEMP_DIR$1 = path.join(os.tmpdir(), "weixin-agent/media");
/** Save a buffer to a temporary file, returning the file path. */
async function saveMediaBuffer(buffer, contentType, subdir, _maxBytes, originalFilename) {
	const dir = path.join(MEDIA_TEMP_DIR$1, subdir ?? "");
	await fs$1.mkdir(dir, { recursive: true });
	let ext = ".bin";
	if (originalFilename) ext = path.extname(originalFilename) || ".bin";
	else if (contentType) ext = getExtensionFromMime(contentType);
	const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
	const filePath = path.join(dir, name);
	await fs$1.writeFile(filePath, buffer);
	return {
		path: filePath,
		sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
		fileName: originalFilename
	};
}
/** Extract raw text from item_list (for slash command detection). */
function extractTextBody(itemList) {
	if (!itemList?.length) return "";
	for (const item of itemList) if (item.type === MessageItemType.TEXT && item.text_item?.text != null) return String(item.text_item.text);
	return "";
}
/** Find the first downloadable media item from a message. */
function findMediaItem(itemList) {
	if (!itemList?.length) return void 0;
	const hasDownloadableMedia = (m) => m?.encrypt_query_param || m?.full_url;
	const direct = itemList.find((i) => i.type === MessageItemType.IMAGE && hasDownloadableMedia(i.image_item?.media)) ?? itemList.find((i) => i.type === MessageItemType.VIDEO && hasDownloadableMedia(i.video_item?.media)) ?? itemList.find((i) => i.type === MessageItemType.FILE && hasDownloadableMedia(i.file_item?.media)) ?? itemList.find((i) => i.type === MessageItemType.VOICE && hasDownloadableMedia(i.voice_item?.media) && !i.voice_item?.text);
	if (direct) return direct;
	return itemList.find((i) => i.type === MessageItemType.TEXT && i.ref_msg?.message_item && isMediaItem(i.ref_msg.message_item))?.ref_msg?.message_item ?? void 0;
}
/**
* Process a single inbound message:
*   slash command check → download media → call agent → send reply.
*/
async function processOneMessage(full, deps) {
	const textBody = extractTextBody(full.item_list);
	const contextToken = full.context_token;
	let inboundMedia = null;
	const mediaItem = findMediaItem(full.item_list);
	if (mediaItem) try {
		const downloaded = await downloadMediaFromItem(mediaItem, {
			cdnBaseUrl: deps.cdnBaseUrl,
			saveMedia: saveMediaBuffer,
			log: deps.log,
			errLog: deps.errLog,
			label: "inbound"
		});
		let requestMedia;
		if (downloaded.decryptedPicPath) requestMedia = { type: "image", filePath: downloaded.decryptedPicPath, mimeType: "image/*" };
		else if (downloaded.decryptedVideoPath) requestMedia = { type: "video", filePath: downloaded.decryptedVideoPath, mimeType: "video/mp4" };
		else if (downloaded.decryptedFilePath) requestMedia = {
			type: "file",
			filePath: downloaded.decryptedFilePath,
			mimeType: downloaded.fileMediaType ?? "application/octet-stream",
			...normalizedFileName(downloaded.fileName) ? { fileName: normalizedFileName(downloaded.fileName) } : {}
		};
		else if (downloaded.decryptedVoicePath) requestMedia = { type: "audio", filePath: downloaded.decryptedVoicePath, mimeType: downloaded.voiceMediaType ?? "audio/wav" };
		if (requestMedia && downloaded.sha256) inboundMedia = {
			sha256: downloaded.sha256,
			fileName: downloaded.fileName,
			requestMedia
		};
	} catch (err) {
		deps.errLog("[weixin] category=media status=failed durationMs=0");
	}
	if (mediaItem && !inboundMedia) {
		deps.errLog("[weixin] category=media status=failed durationMs=0");
		return false;
	}
	const classifierInput = Object.freeze({});
	const chatMetadata = deps.classifyChat?.(classifierInput) ?? null;
	const request = normalizeInboundUpdate(full, {
		deliveryKey: deps.deliveryKey,
		media: inboundMedia,
		chatMetadata
	});
	if (contextToken) setContextToken(deps.accountId, request.senderId, contextToken);
	if (textBody.startsWith("/")) {
		const slashResult = await handleSlashCommand(textBody, {
			to: request.conversationId,
			contextToken,
			baseUrl: deps.baseUrl,
			token: deps.token,
			accountId: deps.accountId,
			log: deps.log,
			errLog: deps.errLog,
			onClear: () => deps.agent.clearSession?.(request.conversationId)
		});
		if (slashResult.handled) return slashResult.succeeded === true;
	}
	const to = request.conversationId;
	let typingTimer;
	const startTyping = () => {
		if (!deps.typingTicket) return;
		sendTyping({
			baseUrl: deps.baseUrl,
			token: deps.token,
			body: {
				ilink_user_id: to,
				typing_ticket: deps.typingTicket,
				status: TypingStatus.TYPING
			}
		}).catch(() => {});
	};
	if (deps.typingTicket) {
		startTyping();
		typingTimer = setInterval(startTyping, 1e4);
	}
	try {
		const response = await deps.agent.chat(request);
		if (response.media) {
			let filePath;
			const mediaUrl = response.media.url;
			if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) filePath = await downloadRemoteImageToTemp(mediaUrl, path.join(MEDIA_TEMP_DIR$1, "outbound"));
			else filePath = path.isAbsolute(mediaUrl) ? mediaUrl : path.resolve(mediaUrl);
			await sendWeixinMediaFile({
				filePath,
				to,
				text: response.text ? markdownToPlainText(response.text) : "",
				opts: {
					baseUrl: deps.baseUrl,
					token: deps.token,
					contextToken
				},
				cdnBaseUrl: deps.cdnBaseUrl
			});
		} else if (response.text) await sendMessageWeixin({
			to,
			text: markdownToPlainText(response.text),
			opts: {
				baseUrl: deps.baseUrl,
				token: deps.token,
				contextToken
			}
		});
	} catch (err) {
		deps.errLog("[weixin] category=message status=failed durationMs=0");
		sendWeixinErrorNotice({
			to,
			contextToken,
			message: "⚠️ 处理消息失败",
			baseUrl: deps.baseUrl,
			token: deps.token,
			errLog: deps.errLog
		});
		return false;
	} finally {
		if (typingTimer) clearInterval(typingTimer);
		if (deps.typingTicket) sendTyping({
			baseUrl: deps.baseUrl,
			token: deps.token,
			body: {
				ilink_user_id: to,
				typing_ticket: deps.typingTicket,
				status: TypingStatus.CANCEL
			}
		}).catch(() => {});
	}
	return true;
}
//#endregion
//#region src/storage/sync-buf.ts
function resolveAccountsDir() {
	return path.join(resolveStateDir(), "openclaw-weixin", "accounts");
}
/**
* Path to the persistent get_updates_buf file for an account.
* Stored alongside account data: ~/.openclaw/openclaw-weixin/accounts/{accountId}.sync.json
*/
function getSyncBufFilePath(accountId) {
	return path.join(resolveAccountsDir(), `${accountId}.sync.json`);
}
/** Legacy single-account syncbuf (pre multi-account): `.openclaw-weixin-sync/default.json`. */
function getLegacySyncBufDefaultJsonPath() {
	return path.join(resolveStateDir(), "agents", "default", "sessions", ".openclaw-weixin-sync", "default.json");
}
function readSyncBufFile(filePath) {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const data = JSON.parse(raw);
		if (typeof data.get_updates_buf === "string") return data.get_updates_buf;
	} catch {}
}
/**
* Load persisted get_updates_buf.
* Falls back in order:
*   1. Primary path (normalized accountId, new installs)
*   2. Compat path (raw accountId derived from pattern, old installs)
*   3. Legacy single-account path (very old installs without multi-account support)
*/
function loadGetUpdatesBuf(filePath) {
	const value = readSyncBufFile(filePath);
	if (value !== void 0) return value;
	const rawId = deriveRawAccountId(path.basename(filePath, ".sync.json"));
	if (rawId) {
		const compatValue = readSyncBufFile(path.join(resolveAccountsDir(), `${rawId}.sync.json`));
		if (compatValue !== void 0) return compatValue;
	}
	return readSyncBufFile(getLegacySyncBufDefaultJsonPath());
}
/**
* Persist get_updates_buf. Creates parent dir if needed.
*/
function saveGetUpdatesBuf(filePath, getUpdatesBuf) {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: getUpdatesBuf }, null, 0), "utf-8");
}
//#endregion
//#region src/monitor/monitor.ts
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35e3;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 3e4;
const RETRY_DELAY_MS = 2e3;
/**
* Long-poll loop: getUpdates → process message → call agent → send reply.
* Runs until aborted.
*/
async function monitorWeixinProvider(opts) {
	const { baseUrl, cdnBaseUrl, token, accountId, agent, abortSignal, longPollTimeoutMs, deliveryKey, classifyChat } = opts;
	const log = opts.log ?? ((msg) => console.log(msg));
	const errLog = (msg) => {
		log(msg);
		logger.error(msg);
	};
	const aLog = logger;
	log("[weixin] category=monitor status=started durationMs=0");
	aLog.info("category=monitor status=started durationMs=0");
	const syncFilePath = getSyncBufFilePath(accountId);
	const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
	let getUpdatesBuf = previousGetUpdatesBuf ?? "";
	if (previousGetUpdatesBuf) log(`[weixin] category=cursor bytes=${Buffer.byteLength(getUpdatesBuf, "utf8")} status=resumed durationMs=0`);
	else log("[weixin] category=cursor bytes=0 status=fresh durationMs=0");
	const configManager = new WeixinConfigManager({
		baseUrl,
		token
	}, log);
	let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
	let consecutiveFailures = 0;
	while (!abortSignal?.aborted) try {
		const resp = await getUpdates({
			baseUrl,
			token,
			get_updates_buf: getUpdatesBuf,
			timeoutMs: nextTimeoutMs,
			abortSignal
		});
		if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) nextTimeoutMs = resp.longpolling_timeout_ms;
		if (resp.ret !== void 0 && resp.ret !== 0 || resp.errcode !== void 0 && resp.errcode !== 0) {
			if (resp.errcode === -14 || resp.ret === -14) {
				pauseSession(accountId);
				const pauseMs = getRemainingPauseMs(accountId);
				errLog("[weixin] category=session status=expired durationMs=0");
				consecutiveFailures = 0;
				await sleep(pauseMs, abortSignal);
				continue;
			}
			consecutiveFailures += 1;
			errLog("[weixin] category=updates status=failed durationMs=0");
			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				errLog("[weixin] category=updates status=backoff durationMs=30000");
				consecutiveFailures = 0;
				await sleep(BACKOFF_DELAY_MS, abortSignal);
			} else await sleep(RETRY_DELAY_MS, abortSignal);
			continue;
		}
		consecutiveFailures = 0;
		const nextGetUpdatesBuf = resp.get_updates_buf != null && resp.get_updates_buf !== ""
			? resp.get_updates_buf
			: getUpdatesBuf;
		const list = resp.msgs ?? [];
		for (const full of list) {
			const itemTypes = full.item_list?.map((i) => Number.isSafeInteger(i.type) ? i.type : "invalid").join(",") ?? "none";
			log(`[weixin] category=inbound types=${itemTypes} status=received durationMs=0`);
			const fromUserId = full.from_user_id ?? "";
			const processed = await processOneMessage(full, {
				accountId,
				agent,
				baseUrl,
				cdnBaseUrl,
				token,
				deliveryKey,
				classifyChat,
				typingTicket: (await configManager.getForUser(fromUserId, full.context_token)).typingTicket,
				log,
				errLog
			});
			if (processed !== true) throw new Error("inbound batch processing failed");
		}
		if (nextGetUpdatesBuf !== getUpdatesBuf) {
			saveGetUpdatesBuf(syncFilePath, nextGetUpdatesBuf);
			getUpdatesBuf = nextGetUpdatesBuf;
		}
	} catch (err) {
		if (abortSignal?.aborted) {
			aLog.info("category=monitor status=aborted durationMs=0");
			return;
		}
		consecutiveFailures += 1;
		errLog("[weixin] category=updates status=error durationMs=0");
		if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			consecutiveFailures = 0;
			await sleep(BACKOFF_DELAY_MS, abortSignal);
		} else await sleep(RETRY_DELAY_MS, abortSignal);
	}
	aLog.info("category=monitor status=ended durationMs=0");
}
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			reject(/* @__PURE__ */ new Error("aborted"));
		}, { once: true });
	});
}
//#endregion
//#region src/bot.ts
const MEDIA_TEMP_DIR = path.join(os.tmpdir(), "weixin-agent/media");
/**
* Interactive QR-code login. Prints the QR code to the terminal and waits
* for the user to scan it with WeChat.
*
* Returns the normalized account ID on success.
*/
async function login(opts) {
	const log = opts?.log ?? console.log;
	const apiBaseUrl = opts?.baseUrl ?? "https://ilinkai.weixin.qq.com";
	log("正在启动微信扫码登录...");
	const startResult = await startWeixinLoginWithQr({
		apiBaseUrl,
		botType: "3"
	});
	if (!startResult.qrcodeUrl) throw new Error(startResult.message);
	log("\n使用微信扫描以下二维码，以完成连接：\n");
	try {
		const qrcodeterminal = await import("qrcode-terminal");
		await new Promise((resolve) => {
			qrcodeterminal.default.generate(startResult.qrcodeUrl, { small: true }, (qr) => {
				console.log(qr);
				resolve();
			});
		});
	} catch {
		log(`二维码链接: ${startResult.qrcodeUrl}`);
	}
	log("\n等待扫码...\n");
	const waitResult = await waitForWeixinLogin({
		sessionKey: startResult.sessionKey,
		apiBaseUrl,
		timeoutMs: 48e4,
		botType: "3"
	});
	if (!waitResult.connected || !waitResult.botToken || !waitResult.accountId) throw new Error(waitResult.message);
	const normalizedId = normalizeAccountId(waitResult.accountId);
	saveWeixinAccount(normalizedId, {
		token: waitResult.botToken,
		baseUrl: waitResult.baseUrl,
		userId: waitResult.userId
	});
	registerWeixinAccountId(normalizedId);
	log("\n✅ 与微信连接成功！");
	return normalizedId;
}
/**
* Remove all stored WeChat account credentials.
*/
function logout(opts) {
	const log = opts?.log ?? console.log;
	if (listWeixinAccountIds().length === 0) {
		log("当前没有已登录的账号");
		return;
	}
	clearAllWeixinAccounts();
	log("✅ 已退出登录");
}
/**
* Check whether at least one WeChat account is logged in and configured.
*/
function isLoggedIn() {
	const ids = listWeixinAccountIds();
	if (ids.length === 0) return false;
	return resolveWeixinAccount(ids[0]).configured;
}
/**
* A running bot instance — provides proactive messaging capability.
*
* - `sendMessage(text)` — send a text message to the logged-in user.
* - `sendMessage(response)` — send a ChatResponse (text and/or media).
*/
var Bot = class {
	_accountId;
	_baseUrl;
	_cdnBaseUrl;
	_token;
	_userId;
	_monitorPromise;
	/** @internal */
	constructor(params) {
		this._accountId = params.accountId;
		this._baseUrl = params.baseUrl;
		this._cdnBaseUrl = params.cdnBaseUrl;
		this._token = params.token;
		this._userId = params.userId;
		this._monitorPromise = params.monitorPromise;
		this._monitorPromise.catch(() => {});
	}
	/**
	* Wait until the background WeChat monitor stops.
	*
	* This is useful for CLI programs that should keep running until the bot is
	* aborted, and for surfacing unrecoverable monitor errors to the caller.
	*/
	async wait() {
		await this._monitorPromise;
	}
	/**
	* Proactively send a message to the logged-in WeChat user.
	*
	* Accepts either a plain string (sent as text) or a full `ChatResponse`
	* object (text and/or media).
	*
	* Requires at least one inbound message to have been received so that a
	* valid `context_token` is cached (tokens are valid for ~24 hours).
	*/
	async sendMessage(message) {
		const response = typeof message === "string" ? { text: message } : message;
		const contextToken = getContextToken(this._accountId, this._userId);
		if (!contextToken) throw new Error("没有找到 context_token，需要在 start() 运行期间至少收到过一条消息");
		const apiOpts = {
			baseUrl: this._baseUrl,
			token: this._token,
			contextToken
		};
		if (response.media) {
			let filePath;
			const mediaUrl = response.media.url;
			if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) filePath = await downloadRemoteImageToTemp(mediaUrl, path.join(MEDIA_TEMP_DIR, "outbound"));
			else filePath = path.isAbsolute(mediaUrl) ? mediaUrl : path.resolve(mediaUrl);
			await sendWeixinMediaFile({
				filePath,
				to: this._userId,
				text: response.text ? markdownToPlainText(response.text) : "",
				opts: apiOpts,
				cdnBaseUrl: this._cdnBaseUrl
			});
			return;
		}
		if (response.text) {
			await sendMessageWeixin({
				to: this._userId,
				text: markdownToPlainText(response.text),
				opts: apiOpts
			});
			return;
		}
		throw new Error("消息必须包含 text 或 media");
	}
};
/**
* Start the bot — long-polls for new messages and dispatches them to the agent.
*
* Returns a `Bot` instance immediately. Use `bot.wait()` when a CLI program
* should block until the background monitor stops.
*/
function start(agent, opts) {
	const log = opts?.log ?? console.log;
	if (!(opts?.deliveryKey instanceof Uint8Array) || opts.deliveryKey.byteLength !== 32) throw new TypeError("deliveryKey must be 32 bytes");
	const deliveryKey = new Uint8Array(opts.deliveryKey);
	let accountId = opts?.accountId;
	if (!accountId) {
		const ids = listWeixinAccountIds();
		if (ids.length === 0) throw new Error("没有已登录的账号，请先运行 login");
		accountId = ids[0];
		if (ids.length > 1) log("[weixin] category=account status=selected durationMs=0");
	}
	const account = resolveWeixinAccount(accountId);
	if (!account.configured) throw new Error(`账号 ${accountId} 未配置 (缺少 token)，请先运行 login`);
	const userId = loadWeixinAccount(account.accountId)?.userId;
	if (!userId) throw new Error(`账号 ${accountId} 没有关联的用户 ID，请重新运行 login`);
	log("[weixin] category=bot status=started durationMs=0");
	const monitorPromise = monitorWeixinProvider({
		baseUrl: account.baseUrl,
		cdnBaseUrl: account.cdnBaseUrl,
		token: account.token,
		accountId: account.accountId,
		agent,
		deliveryKey,
		classifyChat: opts.classifyChat,
		abortSignal: opts?.abortSignal,
		log
	});
	return new Bot({
		accountId: account.accountId,
		baseUrl: account.baseUrl,
		cdnBaseUrl: account.cdnBaseUrl,
		token: account.token,
		userId,
		monitorPromise
	});
}
//#endregion
export { Bot, isLoggedIn, login, logout, normalizeInboundUpdate, start };
