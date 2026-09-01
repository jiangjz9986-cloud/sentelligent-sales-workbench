import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

export const ASR_PRODUCTION_SMOKE_SCHEMA_VERSION = 1;
export const ASR_SMOKE_REPORT_FILE_MODE = 0o600;
export const ASR_SMOKE_MANIFEST_FILE_MODE = 0o600;
export const ASR_SMOKE_QUALITY_FIXTURE_COUNT = 12;
export const ASR_SMOKE_PERFORMANCE_ATTEMPTS = 20;
export const ASR_SMOKE_CANCELLATION_ATTEMPTS = 10;
export const ASR_SMOKE_RELEASE_TIMEOUT_MS = 2_000;
export const ASR_SMOKE_MAX_AUDIO_BYTES = 8_388_608;
export const ASR_SMOKE_OVERSIZE_BYTES = ASR_SMOKE_MAX_AUDIO_BYTES + 1;
export const ASR_SMOKE_QUICK_MAX_DURATION_MS = 120_000;
export const ASR_SMOKE_ASSISTANT_MAX_DURATION_MS = 60_000;
export const ASR_SMOKE_THRESHOLDS = Object.freeze({
  qualityFixtureCount: ASR_SMOKE_QUALITY_FIXTURE_COUNT,
  qualityValidResponses: ASR_SMOKE_QUALITY_FIXTURE_COUNT,
  qualityEmptyResponses: 0,
  medianCerMax: 0.15,
  p95CerMax: 0.30,
  performanceAttempts: ASR_SMOKE_PERFORMANCE_ATTEMPTS,
  performanceSuccessRateMin: 1,
  performanceP95MsMax: 20_000,
  performanceMaxMsMax: 45_000,
  cancellationAttempts: ASR_SMOKE_CANCELLATION_ATTEMPTS,
  cancellationUploadAttempts: 5,
  cancellationProviderAttempts: 5,
  cancellationReleaseMsMax: ASR_SMOKE_RELEASE_TIMEOUT_MS,
});

export const ASR_SMOKE_CHECK_IDS = Object.freeze([
  "fixture.protection",
  "auth.primary",
  "status.before",
  "quality.cer",
  "performance.latency",
  "performance.metrics-delta",
  "cancellation.upload",
  "cancellation.provider",
  "boundaries.pre-provider-rejection",
  "runtime.final-empty",
  "status.after",
  "evidence.no-audio-or-transcript",
]);

export const ASR_MANUAL_ACCEPTANCE_IDS = Object.freeze([
  "quick-record.processing-copy-only",
  "quick-record.no-write-before-human-confirm",
  "assistant.draft-before-send",
  "account-b.owner-isolation",
  "persistence.no-audio-anywhere",
  "browser.media-recorder-fallback",
  "settings.metadata-only-key-lifecycle",
  "device.desktop-and-iphone",
]);

const ALLOWED_MEDIA_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/wav",
]);
const ASR_BOUNDARY_CONTRACTS = Object.freeze({
  oversize: Object.freeze({ status: 413, code: "AUDIO_TOO_LARGE" }),
  quickTooLong: Object.freeze({
    status: 422,
    code: "AUDIO_TOO_LONG",
    purpose: "quick_record",
    durationMs: ASR_SMOKE_QUICK_MAX_DURATION_MS + 1,
  }),
  assistantTooLong: Object.freeze({
    status: 422,
    code: "AUDIO_TOO_LONG",
    purpose: "assistant_chat",
    durationMs: ASR_SMOKE_ASSISTANT_MAX_DURATION_MS + 1,
  }),
  mimeMismatch: Object.freeze({ status: 415, code: "AUDIO_SIGNATURE_MISMATCH" }),
});
const SAFE_FIXTURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_ACCOUNT = /^[a-z0-9]{2,32}$/u;
const SESSION_COOKIE_NAME = "sentelligent_session";
const SESSION_COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/u;
const FORBIDDEN_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
// Evidence may include aggregate names such as `referenceChars` and
// `responseChars`; reject only fields that would carry the protected material
// itself (or an exact credential/path field), not those bounded counters.
const FORBIDDEN_REPORT_KEYS = /^(?:audio|transcript|reference|password|cookie|csrf|secret|api[_-]?key|path)$/iu;
const FORBIDDEN_PATH_SEGMENTS = new Set([
  ".git",
  "backup",
  "backups",
  "dist",
  "node_modules",
  "release",
  "releases",
]);
const MAX_JSON_RESPONSE_BYTES = 512 * 1_024;
const MAX_REPORT_BYTES = 4 * 1_024 * 1_024;

function fail(message, code = "ASR_SMOKE_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, label, maxLength = 512) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || FORBIDDEN_CONTROL_CHARACTERS.test(value)
  ) {
    throw new TypeError(`${label} must be a bounded string`);
  }
  return value;
}

function boundedPositiveInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new TypeError(`${label} must be a bounded positive integer`);
  }
  return value;
}

function normalizedAbsolutePath(value, label) {
  const candidate = boundedString(value, label, 4_096);
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate) {
    throw new TypeError(`${label} must be a normalized absolute path`);
  }
  return candidate;
}

function pathWithin(candidate, root) {
  const delta = relative(root, candidate);
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

function modeBits(stat) {
  return Number(stat?.mode ?? 0) & 0o777;
}

function safeId(value, label = "fixture id") {
  if (typeof value !== "string" || !SAFE_FIXTURE_ID.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function canonicalMediaType(value) {
  if (typeof value !== "string") throw new TypeError("fixture mediaType is required");
  const normalized = value.trim().toLowerCase();
  if (!ALLOWED_MEDIA_TYPES.has(normalized)) {
    throw new TypeError("fixture mediaType is unsupported");
  }
  return normalized;
}

function normalizeReference(value) {
  const reference = boundedString(value, "fixture reference", 10_000).normalize("NFC").trim();
  if (!reference) throw new TypeError("fixture reference must not be empty");
  return reference;
}

function normalizeQualityFixture(value, index) {
  if (!isObject(value)) throw new TypeError(`quality fixture ${index + 1} must be an object`);
  const durationMs = boundedPositiveInteger(value.durationMs, "fixture durationMs", 120_000);
  if (durationMs < 5_000 || durationMs > 20_000) {
    throw new TypeError("quality fixture duration must be between 5 and 20 seconds");
  }
  const speaker = safeId(value.speaker ?? value.voice ?? "", "fixture speaker");
  return Object.freeze({
    id: safeId(value.id),
    file: normalizedAbsolutePath(value.file ?? value.path, "fixture file"),
    mediaType: canonicalMediaType(value.mediaType),
    durationMs,
    speaker,
    reference: normalizeReference(value.reference),
  });
}

function normalizeBoundaryFixture(value, label, {
  defaultPurpose = "quick_record",
  defaultMediaType,
  defaultDurationMs,
} = {}) {
  if (!isObject(value)) throw new TypeError(`${label} fixture must be an object`);
  const purpose = value.purpose ?? defaultPurpose;
  if (!new Set(["quick_record", "assistant_chat"]).has(purpose)) {
    throw new TypeError(`${label} purpose is invalid`);
  }
  return Object.freeze({
    id: safeId(value.id ?? label),
    file: normalizedAbsolutePath(value.file ?? value.path, `${label} file`),
    mediaType: canonicalMediaType(value.mediaType ?? defaultMediaType),
    durationMs: boundedPositiveInteger(
      value.durationMs ?? defaultDurationMs,
      `${label} durationMs`,
      10 * 60 * 1_000,
    ),
    purpose,
    expectedStatus: boundedPositiveInteger(value.expectedStatus, `${label} expectedStatus`, 599),
    expectedCode: safeId(value.expectedCode, `${label} expectedCode`),
  });
}

function enforceBoundaryContract(name, fixture, contract) {
  if (fixture.expectedStatus !== contract.status || fixture.expectedCode !== contract.code) {
    throw new TypeError(`${name} boundary must expect HTTP ${contract.status}/${contract.code}`);
  }
  if (contract.purpose && fixture.purpose !== contract.purpose) {
    throw new TypeError(`${name} boundary purpose is fixed to ${contract.purpose}`);
  }
  if (contract.durationMs !== undefined && fixture.durationMs !== contract.durationMs) {
    throw new TypeError(`${name} boundary duration must be exactly ${contract.durationMs}ms`);
  }
  return fixture;
}

/**
 * Parse the protected out-of-repository fixture manifest.
 *
 * The reference text remains in memory only.  Callers must use
 * `sanitizeFixtureEvidence` before constructing a report.
 */
export function parseAsrFixtureManifest(value) {
  if (!isObject(value)) throw new TypeError("ASR fixture manifest must be an object");
  if (value.schemaVersion !== ASR_PRODUCTION_SMOKE_SCHEMA_VERSION) {
    throw new TypeError("ASR fixture manifest schemaVersion is unsupported");
  }
  if (!Array.isArray(value.quality) || value.quality.length !== ASR_SMOKE_QUALITY_FIXTURE_COUNT) {
    throw new TypeError(`ASR fixture manifest must contain exactly ${ASR_SMOKE_QUALITY_FIXTURE_COUNT} quality fixtures`);
  }
  const quality = value.quality.map(normalizeQualityFixture);
  if (new Set(quality.map(({ id }) => id)).size !== quality.length) {
    throw new TypeError("ASR quality fixture ids must be unique");
  }
  const speakers = new Set(quality.map(({ speaker }) => speaker));
  if (speakers.size < 2 && value.equivalentSyntheticVoices !== true) {
    throw new TypeError("ASR quality fixtures require at least two speakers or explicit equivalent synthetic voices");
  }

  const performanceFixtureId = safeId(value.performanceFixtureId, "performanceFixtureId");
  const performanceFixture = quality.find(({ id }) => id === performanceFixtureId);
  if (!performanceFixture || performanceFixture.durationMs !== 10_000) {
    throw new TypeError("performanceFixtureId must identify an exact 10-second quality fixture");
  }
  const cancellationFixtureId = safeId(
    value.cancellationFixtureId ?? performanceFixtureId,
    "cancellationFixtureId",
  );
  const cancellationFixture = quality.find(({ id }) => id === cancellationFixtureId);
  if (!cancellationFixture) throw new TypeError("cancellationFixtureId must identify a quality fixture");

  if (!isObject(value.boundaries)) throw new TypeError("ASR boundary fixtures are required");
  const boundaries = Object.freeze({
    oversize: enforceBoundaryContract("oversize", normalizeBoundaryFixture(value.boundaries.oversize, "oversize", {
      defaultDurationMs: 10_000,
      defaultMediaType: "audio/wav",
    }), ASR_BOUNDARY_CONTRACTS.oversize),
    quickTooLong: enforceBoundaryContract("quick-too-long", normalizeBoundaryFixture(value.boundaries.quickTooLong, "quick-too-long", {
      defaultDurationMs: ASR_SMOKE_QUICK_MAX_DURATION_MS + 1,
      defaultMediaType: performanceFixture.mediaType,
    }), ASR_BOUNDARY_CONTRACTS.quickTooLong),
    assistantTooLong: enforceBoundaryContract("assistant-too-long", normalizeBoundaryFixture(value.boundaries.assistantTooLong, "assistant-too-long", {
      defaultPurpose: "assistant_chat",
      defaultDurationMs: ASR_SMOKE_ASSISTANT_MAX_DURATION_MS + 1,
      defaultMediaType: performanceFixture.mediaType,
    }), ASR_BOUNDARY_CONTRACTS.assistantTooLong),
    mimeMismatch: enforceBoundaryContract("mime-mismatch", normalizeBoundaryFixture(value.boundaries.mimeMismatch, "mime-mismatch", {
      defaultDurationMs: performanceFixture.durationMs,
      defaultMediaType: performanceFixture.mediaType === "audio/wav" ? "audio/ogg" : "audio/wav",
    }), ASR_BOUNDARY_CONTRACTS.mimeMismatch),
  });

  return Object.freeze({
    schemaVersion: value.schemaVersion,
    quality: Object.freeze(quality),
    performanceFixture,
    cancellationFixture,
    boundaries,
    speakers: speakers.size,
    equivalentSyntheticVoices: value.equivalentSyntheticVoices === true,
    manualAcceptance: normalizeManualAcceptance(value.manualAcceptance),
  });
}

function normalizeManualAcceptance(value) {
  const checks = ASR_MANUAL_ACCEPTANCE_IDS.map((id) => Object.freeze({
    id,
    // Real browser/device acceptance is intentionally outside this runner.
    // Ignore manifest claims here so fixture input cannot turn a server-only
    // smoke into a release-ready result.
    status: "pending",
  }));
  return Object.freeze({
    status: checks.every(({ status }) => status === "passed") ? "passed" : "pending",
    checks: Object.freeze(checks),
  });
}

function defaultForbiddenRoots({ cwd = process.cwd() } = {}) {
  const roots = [cwd];
  const configured = [
    process.env.SENT_ZX_REPO_ROOT,
    process.env.SENT_ZX_RELEASE_ROOT,
    process.env.SENT_ZX_BACKUP_ROOT,
  ].filter(Boolean);
  for (const value of configured) {
    try {
      roots.push(normalizedAbsolutePath(value, "forbidden fixture root"));
    } catch {
      // A malformed optional root makes it unusable, not an authorization to
      // accept a fixture under it.
    }
  }
  return roots;
}

function pathHasForbiddenSegment(filePath) {
  return filePath.split(sep).some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment.toLowerCase()));
}

/** Validate one fixture without following symlinks or exposing its path. */
export function inspectProtectedFixture(filePath, {
  expectedBytes,
  forbiddenRoots = defaultForbiddenRoots(),
  currentUid = process.getuid?.(),
  lstat = lstatSync,
  realpath = realpathSync.native,
  readFile = readFileSync,
} = {}) {
  const candidate = normalizedAbsolutePath(filePath, "fixture file");
  const lexical = lstat(candidate);
  const canonical = realpath(candidate);
  if (canonical !== candidate || lexical.isSymbolicLink() || !lexical.isFile()) {
    throw fail("ASR fixture must be a canonical non-symlink regular file", "ASR_FIXTURE_UNSAFE");
  }
  if (modeBits(lexical) !== ASR_SMOKE_MANIFEST_FILE_MODE) {
    throw fail("ASR fixture mode must be exactly 0600", "ASR_FIXTURE_UNSAFE");
  }
  if (Number.isSafeInteger(currentUid) && lexical.uid !== currentUid) {
    throw fail("ASR fixture must be owned by the smoke service user", "ASR_FIXTURE_UNSAFE");
  }
  if (pathHasForbiddenSegment(candidate)) {
    throw fail("ASR fixture must stay outside Git, release, backup and static roots", "ASR_FIXTURE_UNSAFE");
  }
  for (const rootValue of forbiddenRoots) {
    let root;
    try {
      root = realpath(normalizedAbsolutePath(rootValue, "forbidden fixture root"));
    } catch {
      continue;
    }
    if (pathWithin(candidate, root)) {
      throw fail("ASR fixture must stay outside the project and evidence roots", "ASR_FIXTURE_UNSAFE");
    }
  }
  const bytes = readFile(candidate);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw fail("ASR fixture reader returned invalid bytes", "ASR_FIXTURE_INVALID");
  }
  if (bytes.byteLength <= 0) throw fail("ASR fixture must not be empty", "ASR_FIXTURE_INVALID");
  if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
    throw fail("ASR boundary fixture byte length is incorrect", "ASR_FIXTURE_INVALID");
  }
  return Object.freeze({
    bytes: Buffer.from(bytes),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

export function loadProtectedAsrFixtureManifest(manifestPath, options = {}) {
  const manifestInspection = inspectProtectedFixture(manifestPath, options);
  let parsed;
  try {
    parsed = JSON.parse(manifestInspection.bytes.toString("utf8"));
  } catch {
    throw fail("ASR fixture manifest must be valid UTF-8 JSON", "ASR_FIXTURE_INVALID");
  }
  return Object.freeze({
    manifest: parseAsrFixtureManifest(parsed),
    manifestSha256: manifestInspection.sha256,
    manifestBytes: manifestInspection.byteLength,
  });
}

function codePoints(value) {
  return [...String(value ?? "").normalize("NFC")];
}

/** Unicode-code-point Levenshtein CER. */
export function characterErrorRate(referenceValue, transcriptValue) {
  const reference = codePoints(referenceValue);
  const transcript = codePoints(transcriptValue);
  if (reference.length === 0) return transcript.length === 0 ? 0 : 1;
  let previous = Array.from({ length: transcript.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= transcript.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (reference[row - 1] === transcript[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[transcript.length] / reference.length;
}

function percentile(values, ratio) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rounded(value, digits = 6) {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(digits))
    : null;
}

export function parseAsrSmokeOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new TypeError("ASR smoke origin must be supplied explicitly as a bounded HTTPS origin");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("ASR smoke origin must be a valid HTTPS origin");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.origin !== value
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new TypeError("ASR smoke origin must be a bare HTTPS origin");
  }
  return parsed.origin;
}

export function parseAsrSmokeCliArguments(argv, {
  environment = process.env,
} = {}) {
  if (!Array.isArray(argv)) throw new TypeError("CLI arguments must be an array");
  const values = {};
  for (const item of argv) {
    const argument = String(item);
    if (/^--(?:password|cookie|csrf|secret)(?:=|$)/iu.test(argument)) {
      throw new TypeError("Authentication material must be supplied only through JSON stdin");
    }
    const match = /^--(origin|manifest|report|account)=(.+)$/u.exec(argument);
    if (!match) throw new TypeError(`Unsupported ASR production smoke argument: ${argument}`);
    if (values[match[1]] !== undefined) {
      throw new TypeError(`ASR smoke argument --${match[1]} may be specified only once`);
    }
    values[match[1]] = match[2];
  }
  // A production target is never inferred from a default.  Operators may
  // provide it as an explicit flag or as an explicitly selected environment
  // value so package scripts do not need to put a URL in source control.
  const environmentOrigin = environment?.SENT_ZX_ASR_SMOKE_ORIGIN
    ?? environment?.ASR_SMOKE_ORIGIN;
  if (!values.origin && typeof environmentOrigin === "string" && environmentOrigin) {
    values.origin = environmentOrigin;
  }
  if (!values.origin || !values.manifest || !values.report) {
    throw new TypeError("--origin (or SENT_ZX_ASR_SMOKE_ORIGIN/ASR_SMOKE_ORIGIN), --manifest and --report are required");
  }
  const account = values.account ?? null;
  if (account !== null && !SAFE_ACCOUNT.test(account)) {
    throw new TypeError("ASR smoke account is invalid");
  }
  return Object.freeze({
    origin: parseAsrSmokeOrigin(values.origin),
    manifestPath: normalizedAbsolutePath(values.manifest, "manifest path"),
    reportPath: normalizedAbsolutePath(values.report, "report path"),
    account,
  });
}

export function parseAsrSmokeSecretsStdin(input, { defaultAccount = null } = {}) {
  if (typeof input !== "string" || !input.trim()) {
    throw new TypeError("JSON stdin containing ASR smoke account passwords is required");
  }
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    throw new TypeError("ASR smoke stdin must be valid JSON");
  }
  if (!isObject(value)) throw new TypeError("ASR smoke stdin JSON must be an object");
  let accounts;
  if (Object.keys(value).length === 1 && typeof value.password === "string") {
    if (!SAFE_ACCOUNT.test(defaultAccount ?? "")) {
      throw new TypeError("--account is required when stdin contains the password shorthand");
    }
    accounts = [{ account: defaultAccount, password: value.password }];
  } else if (Object.keys(value).length === 1 && Array.isArray(value.accounts)) {
    accounts = value.accounts;
  } else {
    throw new TypeError("ASR smoke stdin may contain only password or accounts");
  }
  if (accounts.length === 0 || accounts.length > 8) {
    throw new TypeError("ASR smoke requires between one and eight accounts");
  }
  const normalized = accounts.map((entry) => {
    if (!isObject(entry) || !SAFE_ACCOUNT.test(entry.account)) {
      throw new TypeError("ASR smoke account is invalid");
    }
    if (typeof entry.password !== "string" || entry.password.length === 0 || entry.password.length > 1_000) {
      throw new TypeError("ASR smoke password is invalid");
    }
    return Object.freeze({ account: entry.account, password: entry.password });
  });
  if (new Set(normalized.map(({ account }) => account)).size !== normalized.length) {
    throw new TypeError("ASR smoke accounts must be unique");
  }
  return Object.freeze(normalized);
}

function parseSessionCookie(setCookie) {
  const first = String(setCookie ?? "").split(";", 1)[0];
  const separator = first.indexOf("=");
  if (separator <= 0) return null;
  const name = first.slice(0, separator).trim();
  const value = first.slice(separator + 1).trim();
  if (name !== SESSION_COOKIE_NAME || !SESSION_COOKIE_VALUE.test(value)) return null;
  return Object.freeze({ header: `${name}=${value}`, value });
}

async function boundedJsonResponse(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_RESPONSE_BYTES) {
    throw fail("ASR smoke HTTP response exceeded the JSON limit", "ASR_SMOKE_BAD_RESPONSE");
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw fail("ASR smoke HTTP response was not valid JSON", "ASR_SMOKE_BAD_RESPONSE");
  }
}

function responseErrorCode(body) {
  const value = body?.error?.code;
  return typeof value === "string" && /^[A-Z0-9_]{2,64}$/u.test(value) ? value : "UNKNOWN";
}

async function loginAsrSmokeAccount({ origin, account, password, fetchImpl }) {
  const response = await fetchImpl(`${origin}/api/auth/login`, {
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({ account, password }),
  });
  const body = await boundedJsonResponse(response);
  if (response.status !== 200) {
    throw fail(`ASR smoke login failed with HTTP ${response.status}/${responseErrorCode(body)}`, "ASR_SMOKE_AUTH_FAILED");
  }
  const cookie = parseSessionCookie(response.headers.get("set-cookie"));
  const csrfToken = body?.csrfToken;
  if (!cookie || typeof csrfToken !== "string" || !csrfToken || csrfToken.length > 512) {
    throw fail("ASR smoke login response omitted the protected session contract", "ASR_SMOKE_AUTH_FAILED");
  }
  return Object.freeze({ account, cookieHeader: cookie.header, cookieValue: cookie.value, csrfToken });
}

async function logoutAsrSmokeAccount({ origin, session, fetchImpl }) {
  const response = await fetchImpl(`${origin}/api/auth/logout`, {
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/json",
      Cookie: session.cookieHeader,
      Origin: origin,
      "X-CSRF-Token": session.csrfToken,
    },
  });
  if (response.status !== 204) {
    const body = await boundedJsonResponse(response);
    throw fail(`ASR smoke logout failed with HTTP ${response.status}/${responseErrorCode(body)}`, "ASR_SMOKE_AUTH_FAILED");
  }
}

function sanitizeStatusSnapshot(value) {
  const source = value?.item ?? value;
  if (!isObject(source)) throw fail("ASR admin status response is invalid", "ASR_SMOKE_BAD_RESPONSE");
  const counters = (candidate, label) => {
    if (!isObject(candidate)) throw fail(`ASR admin status ${label} counters are invalid`, "ASR_SMOKE_BAD_RESPONSE");
    const result = {};
    for (const [key, item] of Object.entries(candidate)) {
      if (
        !/^[A-Za-z0-9._|:-]{1,160}$/u.test(key)
        || !Number.isSafeInteger(item)
        || item < 0
      ) {
        throw fail(`ASR admin status ${label} counters are invalid`, "ASR_SMOKE_BAD_RESPONSE");
      }
      result[key] = item;
    }
    return result;
  };
  const integer = (candidate) => Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
  const nonNegativeNumber = (candidate, label) => {
    if (candidate === null) return null;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
      throw fail(`ASR admin status ${label} is invalid`, "ASR_SMOKE_BAD_RESPONSE");
    }
    return candidate;
  };
  const p95 = source.p95;
  const window = source.window;
  const readiness = source.readiness;
  if (!isObject(p95) || !isObject(window) || !isObject(readiness)) {
    throw fail("ASR admin status omitted readiness, window or p95", "ASR_SMOKE_BAD_RESPONSE");
  }
  if (
    typeof window.startedAt !== "string"
    || window.startedAt.length > 40
    || Number.isNaN(Date.parse(window.startedAt))
    || new Date(window.startedAt).toISOString() !== window.startedAt
  ) {
    throw fail("ASR admin status metrics window is invalid", "ASR_SMOKE_BAD_RESPONSE");
  }
  const capacity = integer(window.capacity);
  const sampleCount = integer(window.sampleCount);
  if (capacity === null || capacity <= 0 || sampleCount === null || sampleCount > capacity) {
    throw fail("ASR admin status metrics window bounds are invalid", "ASR_SMOKE_BAD_RESPONSE");
  }
  if (typeof readiness.ready !== "boolean") {
    throw fail("ASR admin status readiness is invalid", "ASR_SMOKE_BAD_RESPONSE");
  }
  const readinessCode = typeof readiness.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(readiness.code)
    ? readiness.code
    : null;
  if (!readinessCode) throw fail("ASR admin status readiness code is invalid", "ASR_SMOKE_BAD_RESPONSE");
  if (!Object.hasOwn(p95, "totalMs") || !Object.hasOwn(p95, "providerMs")) {
    throw fail("ASR admin status p95 fields are missing", "ASR_SMOKE_BAD_RESPONSE");
  }
  const snapshot = {
    mode: source.mode === "live" || source.mode === "disabled" ? source.mode : "unknown",
    provider: source.provider === "openai-compatible" ? source.provider : "unknown",
    credentialConfigured: source.credentialConfigured === true,
    readiness: {
      ready: readiness.ready,
      code: readinessCode,
    },
    window: {
      startedAt: window.startedAt,
      capacity,
      sampleCount,
    },
    requests: counters(source.requests, "requests"),
    providerCalls: counters(source.providerCalls, "providerCalls"),
    outcomes: counters(source.outcomes, "outcomes"),
    cleanupFailures: integer(source.cleanupFailures),
    inflight: integer(source.inflight),
    activeUploads: integer(source.activeUploads),
    tempBytes: integer(source.tempBytes),
    staleTempDirectories: integer(source.staleTempDirectories),
    p95: {
      totalMs: nonNegativeNumber(p95.totalMs, "p95.totalMs"),
      providerMs: nonNegativeNumber(p95.providerMs, "p95.providerMs"),
    },
  };
  if (
    snapshot.cleanupFailures === null
    || snapshot.inflight === null
    || snapshot.activeUploads === null
    || snapshot.tempBytes === null
    || snapshot.staleTempDirectories === null
  ) {
    throw fail("ASR admin status response omitted required aggregate fields", "ASR_SMOKE_BAD_RESPONSE");
  }
  return Object.freeze(snapshot);
}

async function readAsrStatus({ origin, session, fetchImpl }) {
  const response = await fetchImpl(`${origin}/api/admin/asr/status`, {
    method: "GET",
    redirect: "error",
    headers: {
      Accept: "application/json",
      Cookie: session.cookieHeader,
      Origin: origin,
    },
  });
  const body = await boundedJsonResponse(response);
  if (response.status !== 200) {
    throw fail(`ASR admin status failed with HTTP ${response.status}/${responseErrorCode(body)}`, "ASR_SMOKE_STATUS_FAILED");
  }
  if (!String(response.headers.get("cache-control") ?? "").toLowerCase().includes("no-store")) {
    throw fail("ASR admin status response must be no-store", "ASR_SMOKE_STATUS_FAILED");
  }
  return sanitizeStatusSnapshot(body);
}

function counterTotal(value) {
  return Object.values(isObject(value) ? value : {}).reduce((total, item) => (
    Number.isSafeInteger(item) && item >= 0 ? total + item : total
  ), 0);
}

function statusDelta(before, after) {
  if (before.window.startedAt !== after.window.startedAt) {
    throw fail("ASR process metrics window restarted during smoke", "ASR_SMOKE_WINDOW_CHANGED");
  }
  const delta = (left, right, label) => {
    const value = right - left;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw fail(`ASR ${label} counter moved backwards`, "ASR_SMOKE_WINDOW_CHANGED");
    }
    return value;
  };
  return Object.freeze({
    requests: delta(counterTotal(before.requests), counterTotal(after.requests), "requests"),
    providerCalls: delta(counterTotal(before.providerCalls), counterTotal(after.providerCalls), "providerCalls"),
    cleanupFailures: delta(before.cleanupFailures, after.cleanupFailures, "cleanup failures"),
  });
}

function idempotencyKey(runId, phase, index) {
  const normalized = `${phase}`.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 32);
  return `asr-smoke:${runId}:${normalized}:${index}`.slice(0, 127);
}

async function transcribe({
  origin,
  session,
  fixture,
  fixtureBytes,
  purpose = "quick_record",
  mediaType = fixture.mediaType,
  durationMs = fixture.durationMs,
  key,
  fetchImpl,
  signal,
  body = fixtureBytes,
  duplex,
}) {
  const headers = {
    Accept: "application/json",
    Cookie: session.cookieHeader,
    "Content-Type": mediaType,
    "Idempotency-Key": key,
    Origin: origin,
    "X-ASR-Language": "zh-CN",
    "X-Audio-Duration-Ms": String(durationMs),
    "X-CSRF-Token": session.csrfToken,
  };
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    headers["Content-Length"] = String(body.byteLength);
  }
  const options = {
    method: "POST",
    redirect: "error",
    headers,
    body,
    signal,
  };
  if (duplex) options.duplex = duplex;
  const response = await fetchImpl(`${origin}/api/asr/transcriptions?purpose=${purpose}`, options);
  const responseBody = await boundedJsonResponse(response);
  return Object.freeze({ response, body: responseBody });
}

function extractTranscript(result) {
  const transcript = result?.body?.item?.transcript;
  if (typeof transcript !== "string") {
    throw fail("ASR success response omitted a transcript", "ASR_SMOKE_BAD_RESPONSE");
  }
  const normalized = transcript.normalize("NFC").trim();
  if (!normalized) {
    throw fail("ASR success response contained an empty transcript", "ASR_TRANSCRIPT_EMPTY");
  }
  if (FORBIDDEN_CONTROL_CHARACTERS.test(normalized)) {
    throw fail("ASR success response contained an invalid transcript", "ASR_SMOKE_BAD_RESPONSE");
  }
  return normalized;
}

function sanitizeFixtureEvidence(fixture, inspected, transcript, cer) {
  return Object.freeze({
    id: fixture.id,
    sha256: inspected.sha256,
    bytes: inspected.byteLength,
    durationMs: fixture.durationMs,
    referenceChars: codePoints(fixture.reference).length,
    responseChars: codePoints(transcript).length,
    cer: rounded(cer),
    status: "passed",
  });
}

function safeErrorMessage(error, sensitive = []) {
  let message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  for (const value of sensitive) {
    if (typeof value === "string" && value) message = message.replaceAll(value, "[redacted]");
  }
  return message.replace(/[\r\n]+/gu, " ").slice(0, 400);
}

function makeCheck(id, status, details = {}) {
  if (!ASR_SMOKE_CHECK_IDS.includes(id)) throw new TypeError(`unknown ASR smoke check ${id}`);
  if (!new Set(["passed", "failed", "blocked"]).has(status)) {
    throw new TypeError("ASR smoke check status is invalid");
  }
  return Object.freeze({ id, status, ...details });
}

export function inspectRuntimeDirectoryDefault(runtimeDirectory = "/run/sentelligent-asr") {
  const root = normalizedAbsolutePath(runtimeDirectory, "ASR runtime directory");
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || modeBits(stat) !== 0o700) {
      return Object.freeze({ empty: false, count: null, status: "unsafe" });
    }
    const entries = readdirSync(root, { withFileTypes: true });
    // Counting entries is deliberately enough to fail the cleanup gate, but
    // inspect every directory entry without following it so an unexpected
    // symlink/device cannot be mistaken for a clean runtime directory.
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        return Object.freeze({ empty: false, count: entries.length, status: "unsafe-entry" });
      }
    }
    return Object.freeze({ empty: entries.length === 0, count: entries.length, status: "inspected" });
  } catch (error) {
    return Object.freeze({
      empty: false,
      count: null,
      status: error?.code === "ENOENT" ? "missing" : "unreadable",
    });
  }
}

function createSlowBody(bytes, {
  chunkBytes = 16 * 1_024,
  delayMs = 50,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
} = {}) {
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      await sleep(delayMs);
      const next = Math.min(bytes.byteLength, offset + chunkBytes);
      controller.enqueue(bytes.subarray(offset, next));
      offset = next;
    },
  });
}

async function waitForRuntimeRelease({
  readStatus,
  inspectRuntimeDirectory,
  monotonicNow,
  sleep,
  timeoutMs = ASR_SMOKE_RELEASE_TIMEOUT_MS,
}) {
  const started = monotonicNow();
  while (monotonicNow() - started <= timeoutMs) {
    const status = await readStatus();
    const runtime = await inspectRuntimeDirectory();
    if (
      status.inflight === 0
      && status.activeUploads === 0
      && status.tempBytes === 0
      && status.staleTempDirectories === 0
      && runtime?.empty === true
      && runtime?.count === 0
    ) {
      return Object.freeze({ released: true, elapsedMs: Math.max(0, monotonicNow() - started) });
    }
    await sleep(50);
  }
  return Object.freeze({ released: false, elapsedMs: Math.max(0, monotonicNow() - started) });
}

function requestSummary(checks) {
  return Object.freeze({
    total: checks.length,
    passed: checks.filter(({ status }) => status === "passed").length,
    failed: checks.filter(({ status }) => status === "failed").length,
    blocked: checks.filter(({ status }) => status === "blocked").length,
  });
}

function reportSensitiveValues({ accounts, sessions, manifest, inspectedByFile }) {
  const values = [];
  for (const account of accounts) values.push(account.password);
  for (const session of sessions) values.push(session.cookieValue, session.csrfToken);
  for (const fixture of manifest.quality) values.push(fixture.file, fixture.reference);
  for (const fixture of Object.values(manifest.boundaries)) values.push(fixture.file);
  for (const file of inspectedByFile.keys()) values.push(file);
  return values.filter((value) => typeof value === "string" && value);
}

function assertReportSanitized(report, sensitiveValues) {
  const serialized = JSON.stringify(report);
  for (const value of sensitiveValues) {
    if (serialized.includes(value)) {
      throw fail("ASR smoke report contains protected fixture or authentication material", "ASR_SMOKE_REPORT_UNSAFE");
    }
  }
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_REPORT_KEYS.test(key)) {
        throw fail(`ASR smoke report contains forbidden field ${key}`, "ASR_SMOKE_REPORT_UNSAFE");
      }
      visit(item);
    }
  };
  visit(report);
  if (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES) {
    throw fail("ASR smoke report exceeded its size bound", "ASR_SMOKE_REPORT_UNSAFE");
  }
  return true;
}

export function atomicWriteAsrSmokeReport(reportPath, report) {
  const targetPath = normalizedAbsolutePath(reportPath, "ASR smoke report path");
  assertReportSanitized(report, []);
  if (existsSync(targetPath)) throw fail("ASR smoke report already exists", "ASR_SMOKE_REPORT_EXISTS");
  mkdirSync(dirname(targetPath), { recursive: true });
  const temporaryPath = resolve(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", ASR_SMOKE_REPORT_FILE_MODE);
    writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, ASR_SMOKE_REPORT_FILE_MODE);
    try {
      linkSync(temporaryPath, targetPath);
    } catch (error) {
      if (error?.code === "EEXIST") throw fail("ASR smoke report already exists", "ASR_SMOKE_REPORT_EXISTS");
      throw error;
    }
    chmodSync(targetPath, ASR_SMOKE_REPORT_FILE_MODE);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
  return targetPath;
}

/**
 * Run the automated server-side ASR production smoke.
 *
 * This runner intentionally does not claim the manual browser/device checks in
 * §12.3.  Their fixed ids are preserved in `manualAcceptance`, and
 * `releaseReady` remains false until every one is explicitly evidenced.
 */
export async function runAsrProductionSmoke({
  origin,
  reportPath,
  accounts,
  manifest,
  manifestSha256,
  manifestBytes,
  fetchImpl = globalThis.fetch,
  inspectFixture = inspectProtectedFixture,
  inspectRuntimeDirectory = () => inspectRuntimeDirectoryDefault(),
  now = () => new Date(),
  monotonicNow = () => globalThis.performance.now(),
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  runId = randomUUID(),
  performanceAttempts = ASR_SMOKE_PERFORMANCE_ATTEMPTS,
  cancellationAttempts = ASR_SMOKE_CANCELLATION_ATTEMPTS,
  uploadCancelDelayMs = 50,
  providerCancelDelayMs = 250,
} = {}) {
  const exactOrigin = parseAsrSmokeOrigin(origin);
  if (!isObject(manifest) || manifest.schemaVersion !== ASR_PRODUCTION_SMOKE_SCHEMA_VERSION) {
    throw new TypeError("a parsed ASR fixture manifest is required");
  }
  if (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > 8) {
    throw new TypeError("ASR smoke requires between one and eight accounts");
  }
  for (const entry of accounts) {
    if (!isObject(entry) || !SAFE_ACCOUNT.test(entry.account)) {
      throw new TypeError("ASR smoke account is invalid");
    }
    if (typeof entry.password !== "string" || entry.password.length === 0 || entry.password.length > 1_000) {
      throw new TypeError("ASR smoke password is invalid");
    }
  }
  if (new Set(accounts.map(({ account }) => account)).size !== accounts.length) {
    throw new TypeError("ASR smoke accounts must be unique");
  }
  if (!/^[0-9a-f]{64}$/iu.test(String(manifestSha256 ?? ""))) {
    throw new TypeError("ASR smoke manifestSha256 must be a SHA-256 hex digest");
  }
  if (!Number.isSafeInteger(manifestBytes) || manifestBytes <= 0 || manifestBytes > MAX_REPORT_BYTES) {
    throw new TypeError("ASR smoke manifestBytes must be a bounded positive integer");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("ASR smoke fetch implementation is required");
  if (typeof inspectFixture !== "function" || typeof inspectRuntimeDirectory !== "function") {
    throw new TypeError("ASR smoke fixture and runtime inspectors are required");
  }
  if (typeof now !== "function" || typeof monotonicNow !== "function" || typeof sleep !== "function") {
    throw new TypeError("ASR smoke clock dependencies are required");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId)) {
    throw new TypeError("ASR smoke runId must be a UUID");
  }
  if (performanceAttempts !== ASR_SMOKE_PERFORMANCE_ATTEMPTS) {
    throw new TypeError(`ASR production smoke requires exactly ${ASR_SMOKE_PERFORMANCE_ATTEMPTS} performance attempts`);
  }
  if (cancellationAttempts !== ASR_SMOKE_CANCELLATION_ATTEMPTS) {
    throw new TypeError(`ASR production smoke requires exactly ${ASR_SMOKE_CANCELLATION_ATTEMPTS} cancellation attempts`);
  }
  const startedAtValue = now();
  if (!(startedAtValue instanceof Date) || Number.isNaN(startedAtValue.valueOf())) {
    throw new TypeError("ASR smoke clock must return a valid Date");
  }
  if (typeof reportPath !== "string" || existsSync(reportPath)) {
    throw fail("ASR smoke report path is missing or already exists", "ASR_SMOKE_REPORT_EXISTS");
  }

  const checks = [];
  const sessions = [];
  const inspectedByFile = new Map();
  const sensitive = accounts.map(({ password }) => password);
  let quality = { status: "failed", items: [] };
  let performanceEvidence = { status: "failed" };
  let cancellationEvidence = { status: "failed" };
  let boundaryEvidence = { status: "failed" };
  let statusBefore = null;
  let statusAfter = null;
  let finalRuntime = null;
  let authError = null;

  const inspectOnce = (fixture, expectedBytes) => {
    if (!inspectedByFile.has(fixture.file)) {
      inspectedByFile.set(fixture.file, inspectFixture(fixture.file, { expectedBytes }));
    }
    const result = inspectedByFile.get(fixture.file);
    if (expectedBytes !== undefined && result.byteLength !== expectedBytes) {
      throw fail("ASR boundary fixture byte length is incorrect", "ASR_FIXTURE_INVALID");
    }
    return result;
  };

  const readRuntime = async () => {
    const value = await inspectRuntimeDirectory();
    if (!isObject(value)
      || typeof value.empty !== "boolean"
      || !Number.isSafeInteger(value.count)
      || value.count < 0
      || value.status !== "inspected"
      || (value.empty && value.count !== 0)
      || (!value.empty && value.count === 0)) {
      throw fail("ASR runtime directory inspection did not prove a safe 0700 empty directory", "ASR_RUNTIME_UNSAFE");
    }
    return value;
  };

  try {
    for (const fixture of manifest.quality) inspectOnce(fixture);
    inspectOnce(manifest.boundaries.oversize, ASR_SMOKE_OVERSIZE_BYTES);
    for (const fixture of [
      manifest.boundaries.quickTooLong,
      manifest.boundaries.assistantTooLong,
      manifest.boundaries.mimeMismatch,
    ]) inspectOnce(fixture);
    checks.push(makeCheck("fixture.protection", "passed", {
      manifestSha256,
      manifestBytes,
      qualityCount: manifest.quality.length,
      speakers: manifest.speakers,
    }));
  } catch (error) {
    checks.push(makeCheck("fixture.protection", "failed", {
      error: safeErrorMessage(error, sensitive),
    }));
    throw error;
  }

  try {
    for (const entry of accounts) {
      const session = await loginAsrSmokeAccount({
        origin: exactOrigin,
        account: entry.account,
        password: entry.password,
        fetchImpl,
      });
      sessions.push(session);
      sensitive.push(session.cookieValue, session.csrfToken);
    }
    checks.push(makeCheck("auth.primary", "passed", { sessionCount: sessions.length }));
  } catch (error) {
    authError = safeErrorMessage(error, sensitive);
    checks.push(makeCheck("auth.primary", "failed", { error: authError }));
  }

  const primarySession = sessions[0];
  const sessionFor = (index) => sessions[index % sessions.length];
  const readStatus = () => readAsrStatus({
    origin: exactOrigin,
    session: primarySession,
    fetchImpl,
  });

  if (primarySession) {
    try {
      statusBefore = await readStatus();
      const ready = statusBefore.mode === "live"
        && statusBefore.provider === "openai-compatible"
        && statusBefore.credentialConfigured
        && statusBefore.readiness.ready
        && statusBefore.inflight === 0
        && statusBefore.activeUploads === 0
        && statusBefore.tempBytes === 0
        && statusBefore.staleTempDirectories === 0;
      checks.push(makeCheck("status.before", ready ? "passed" : "failed", {
        mode: statusBefore.mode,
        provider: statusBefore.provider,
        ready: statusBefore.readiness.ready,
        code: statusBefore.readiness.code,
      }));
    } catch (error) {
      checks.push(makeCheck("status.before", "failed", { error: safeErrorMessage(error, sensitive) }));
    }
  } else {
    checks.push(makeCheck("status.before", "blocked", { error: authError ?? "authentication unavailable" }));
  }

  if (primarySession && statusBefore) {
    const qualityItems = [];
    const cerValues = [];
    let emptyResponses = 0;
    let failedResponses = 0;
    for (let index = 0; index < manifest.quality.length; index += 1) {
      const fixture = manifest.quality[index];
      const inspected = inspectOnce(fixture);
      try {
        const result = await transcribe({
          origin: exactOrigin,
          session: sessionFor(index),
          fixture,
          fixtureBytes: inspected.bytes,
          key: idempotencyKey(runId, "quality", index),
          fetchImpl,
        });
        if (result.response.status !== 200) {
          throw fail(`ASR quality fixture returned HTTP ${result.response.status}/${responseErrorCode(result.body)}`);
        }
        const transcript = extractTranscript(result);
        sensitive.push(transcript);
        const cer = characterErrorRate(fixture.reference, transcript);
        cerValues.push(cer);
        qualityItems.push(sanitizeFixtureEvidence(fixture, inspected, transcript, cer));
      } catch (error) {
        failedResponses += 1;
        if (error?.code === "ASR_TRANSCRIPT_EMPTY") emptyResponses += 1;
        qualityItems.push(Object.freeze({
          id: fixture.id,
          sha256: inspected.sha256,
          bytes: inspected.byteLength,
          durationMs: fixture.durationMs,
          referenceChars: codePoints(fixture.reference).length,
          responseChars: 0,
          cer: null,
          status: "failed",
          error: safeErrorMessage(error, [...sensitive, fixture.file, fixture.reference]),
        }));
      }
    }
    const medianCer = median(cerValues);
    const p95Cer = percentile(cerValues, 0.95);
    const passed = failedResponses === 0
      && emptyResponses === 0
      && qualityItems.length === ASR_SMOKE_QUALITY_FIXTURE_COUNT
      && medianCer <= ASR_SMOKE_THRESHOLDS.medianCerMax
      && p95Cer <= ASR_SMOKE_THRESHOLDS.p95CerMax;
    quality = Object.freeze({
      status: passed ? "passed" : "failed",
      validResponses: qualityItems.length - failedResponses,
      emptyResponses,
      medianCer: rounded(medianCer),
      p95Cer: rounded(p95Cer),
      items: Object.freeze(qualityItems),
    });
    checks.push(makeCheck("quality.cer", quality.status, {
      validResponses: quality.validResponses,
      emptyResponses,
      medianCer: quality.medianCer,
      p95Cer: quality.p95Cer,
    }));
  } else {
    checks.push(makeCheck("quality.cer", "blocked", { error: "ASR readiness unavailable" }));
  }

  if (primarySession && statusBefore) {
    try {
      const fixture = manifest.performanceFixture;
      const inspected = inspectOnce(fixture);
      const performanceBefore = await readStatus();
      const latencies = [];
      let successes = 0;
      for (let index = 0; index < ASR_SMOKE_PERFORMANCE_ATTEMPTS; index += 1) {
        const started = monotonicNow();
        const result = await transcribe({
          origin: exactOrigin,
          session: sessionFor(index + manifest.quality.length),
          fixture,
          fixtureBytes: inspected.bytes,
          key: idempotencyKey(runId, "performance", index),
          fetchImpl,
        });
        const elapsedMs = Math.max(0, monotonicNow() - started);
        latencies.push(elapsedMs);
        if (result.response.status === 200) {
          const transcript = extractTranscript(result);
          sensitive.push(transcript);
          successes += 1;
        }
      }
      const performanceAfter = await readStatus();
      const delta = statusDelta(performanceBefore, performanceAfter);
      const latencyP95Ms = percentile(latencies, 0.95);
      const latencyMaxMs = Math.max(...latencies);
      const finalGaugesClear = performanceAfter.inflight === 0
        && performanceAfter.activeUploads === 0
        && performanceAfter.tempBytes === 0
        && performanceAfter.staleTempDirectories === 0;
      const cleanupVerified = successes === ASR_SMOKE_PERFORMANCE_ATTEMPTS
        && delta.cleanupFailures === 0
        && finalGaugesClear
        ? successes
        : 0;
      const latencyPassed = successes === ASR_SMOKE_PERFORMANCE_ATTEMPTS
        && latencyP95Ms <= ASR_SMOKE_THRESHOLDS.performanceP95MsMax
        && latencyMaxMs <= ASR_SMOKE_THRESHOLDS.performanceMaxMsMax;
      const metricsPassed = delta.requests === ASR_SMOKE_PERFORMANCE_ATTEMPTS
        && delta.providerCalls === ASR_SMOKE_PERFORMANCE_ATTEMPTS
        && cleanupVerified === ASR_SMOKE_PERFORMANCE_ATTEMPTS
        && delta.cleanupFailures === 0
        && performanceAfter.staleTempDirectories === 0
        && finalGaugesClear;
      performanceEvidence = Object.freeze({
        status: latencyPassed && metricsPassed ? "passed" : "failed",
        fixture: {
          id: fixture.id,
          sha256: inspected.sha256,
          bytes: inspected.byteLength,
          durationMs: fixture.durationMs,
        },
        attempts: ASR_SMOKE_PERFORMANCE_ATTEMPTS,
        successes,
        successRate: successes / ASR_SMOKE_PERFORMANCE_ATTEMPTS,
        latencyP95Ms: rounded(latencyP95Ms, 3),
        latencyMaxMs: rounded(latencyMaxMs, 3),
        metricsDelta: {
          requests: delta.requests,
          providerCalls: delta.providerCalls,
          cleanupVerified,
          cleanupFailures: delta.cleanupFailures,
          stale: performanceAfter.staleTempDirectories,
        },
        finalGauges: {
          inflight: performanceAfter.inflight,
          activeUploads: performanceAfter.activeUploads,
          tempBytes: performanceAfter.tempBytes,
        },
      });
      checks.push(makeCheck("performance.latency", latencyPassed ? "passed" : "failed", {
        attempts: performanceEvidence.attempts,
        successes,
        latencyP95Ms: performanceEvidence.latencyP95Ms,
        latencyMaxMs: performanceEvidence.latencyMaxMs,
      }));
      checks.push(makeCheck("performance.metrics-delta", metricsPassed ? "passed" : "failed", {
        ...performanceEvidence.metricsDelta,
        ...performanceEvidence.finalGauges,
      }));
    } catch (error) {
      const safe = safeErrorMessage(error, sensitive);
      performanceEvidence = Object.freeze({ status: "failed", error: safe });
      checks.push(makeCheck("performance.latency", "failed", { error: safe }));
      checks.push(makeCheck("performance.metrics-delta", "failed", { error: safe }));
    }
  } else {
    checks.push(makeCheck("performance.latency", "blocked", { error: "ASR readiness unavailable" }));
    checks.push(makeCheck("performance.metrics-delta", "blocked", { error: "ASR readiness unavailable" }));
  }

  if (primarySession && statusBefore) {
    const fixture = manifest.cancellationFixture;
    const inspected = inspectOnce(fixture);
    const items = [];
    for (let index = 0; index < ASR_SMOKE_CANCELLATION_ATTEMPTS; index += 1) {
      const phase = index < 5 ? "upload" : "provider";
      const controller = new AbortController();
      const body = phase === "upload"
        ? createSlowBody(inspected.bytes, { sleep })
        : inspected.bytes;
      const abortDelay = phase === "upload" ? uploadCancelDelayMs : providerCancelDelayMs;
      const timer = setTimeout(() => {
        controller.abort(new DOMException(`ASR ${phase} cancellation smoke`, "AbortError"));
      }, abortDelay);
      let aborted = false;
      try {
        await transcribe({
          origin: exactOrigin,
          session: sessionFor(index + 100),
          fixture,
          fixtureBytes: inspected.bytes,
          key: idempotencyKey(runId, `cancel-${phase}`, index),
          fetchImpl,
          signal: controller.signal,
          body,
          duplex: phase === "upload" ? "half" : undefined,
        });
      } catch (error) {
        aborted = controller.signal.aborted || error?.name === "AbortError";
      } finally {
        clearTimeout(timer);
      }
      let released;
      try {
        released = await waitForRuntimeRelease({
          readStatus,
          inspectRuntimeDirectory: readRuntime,
          monotonicNow,
          sleep,
        });
      } catch (error) {
        released = Object.freeze({ released: false, elapsedMs: null, error: safeErrorMessage(error, sensitive) });
      }
      items.push(Object.freeze({
        phase,
        attempt: phase === "upload" ? index + 1 : index - 4,
        aborted,
        released: released.released,
        releasedWithinMs: rounded(released.elapsedMs, 3),
        error: released.error,
        status: aborted && released.released && released.elapsedMs <= ASR_SMOKE_RELEASE_TIMEOUT_MS
          ? "passed"
          : "failed",
      }));
    }
    const uploadItems = items.filter(({ phase }) => phase === "upload");
    const providerItems = items.filter(({ phase }) => phase === "provider");
    const uploadPassed = uploadItems.length === 5 && uploadItems.every(({ status }) => status === "passed");
    const providerPassed = providerItems.length === 5 && providerItems.every(({ status }) => status === "passed");
    cancellationEvidence = Object.freeze({
      status: uploadPassed && providerPassed ? "passed" : "failed",
      attempts: items.length,
      releasedWithinTwoSeconds: items.filter(({ status }) => status === "passed").length,
      items: Object.freeze(items),
    });
    checks.push(makeCheck("cancellation.upload", uploadPassed ? "passed" : "failed", {
      attempts: uploadItems.length,
      releasedWithinTwoSeconds: uploadItems.filter(({ status }) => status === "passed").length,
    }));
    checks.push(makeCheck("cancellation.provider", providerPassed ? "passed" : "failed", {
      attempts: providerItems.length,
      releasedWithinTwoSeconds: providerItems.filter(({ status }) => status === "passed").length,
    }));
  } else {
    checks.push(makeCheck("cancellation.upload", "blocked", { error: "ASR readiness unavailable" }));
    checks.push(makeCheck("cancellation.provider", "blocked", { error: "ASR readiness unavailable" }));
  }

  if (primarySession && statusBefore) {
    try {
      const boundaryBefore = await readStatus();
      const items = [];
      const ordered = [
        ["oversize", manifest.boundaries.oversize],
        ["quick-too-long", manifest.boundaries.quickTooLong],
        ["assistant-too-long", manifest.boundaries.assistantTooLong],
        ["mime-mismatch", manifest.boundaries.mimeMismatch],
      ];
      for (let index = 0; index < ordered.length; index += 1) {
        const [name, fixture] = ordered[index];
        const inspected = inspectOnce(fixture, name === "oversize" ? ASR_SMOKE_OVERSIZE_BYTES : undefined);
        const result = await transcribe({
          origin: exactOrigin,
          session: sessionFor(index + 200),
          fixture,
          fixtureBytes: inspected.bytes,
          purpose: fixture.purpose,
          mediaType: fixture.mediaType,
          durationMs: fixture.durationMs,
          key: idempotencyKey(runId, `boundary-${name}`, index),
          fetchImpl,
        });
        const code = responseErrorCode(result.body);
        items.push(Object.freeze({
          id: fixture.id,
          sha256: inspected.sha256,
          bytes: inspected.byteLength,
          durationMs: fixture.durationMs,
          purpose: fixture.purpose,
          httpStatus: result.response.status,
          errorCode: code,
          status: result.response.status === fixture.expectedStatus && code === fixture.expectedCode
            ? "passed"
            : "failed",
        }));
      }
      const boundaryAfter = await readStatus();
      const delta = statusDelta(boundaryBefore, boundaryAfter);
      const passed = items.every(({ status }) => status === "passed") && delta.providerCalls === 0;
      boundaryEvidence = Object.freeze({
        status: passed ? "passed" : "failed",
        providerCallsDelta: delta.providerCalls,
        items: Object.freeze(items),
      });
      checks.push(makeCheck("boundaries.pre-provider-rejection", boundaryEvidence.status, {
        fixtureCount: items.length,
        passed: items.filter(({ status }) => status === "passed").length,
        providerCallsDelta: delta.providerCalls,
      }));
    } catch (error) {
      const safe = safeErrorMessage(error, sensitive);
      boundaryEvidence = Object.freeze({ status: "failed", error: safe });
      checks.push(makeCheck("boundaries.pre-provider-rejection", "failed", { error: safe }));
    }
  } else {
    checks.push(makeCheck("boundaries.pre-provider-rejection", "blocked", { error: "ASR readiness unavailable" }));
  }

  try {
    finalRuntime = await readRuntime();
    const passed = finalRuntime?.empty === true && finalRuntime?.count === 0;
    checks.push(makeCheck("runtime.final-empty", passed ? "passed" : "failed", {
      empty: finalRuntime?.empty === true,
      count: Number.isSafeInteger(finalRuntime?.count) ? finalRuntime.count : null,
      inspectionStatus: typeof finalRuntime?.status === "string" ? finalRuntime.status.slice(0, 64) : "unknown",
    }));
  } catch (error) {
    checks.push(makeCheck("runtime.final-empty", "failed", { error: safeErrorMessage(error, sensitive) }));
  }

  if (primarySession) {
    try {
      statusAfter = await readStatus();
      const passed = statusAfter.inflight === 0
        && statusAfter.activeUploads === 0
        && statusAfter.tempBytes === 0
        && statusAfter.staleTempDirectories === 0
        && statusAfter.cleanupFailures === statusBefore?.cleanupFailures
        && statusAfter.readiness.ready;
      checks.push(makeCheck("status.after", passed ? "passed" : "failed", {
        ready: statusAfter.readiness.ready,
        code: statusAfter.readiness.code,
        cleanupFailures: statusAfter.cleanupFailures,
        inflight: statusAfter.inflight,
        activeUploads: statusAfter.activeUploads,
        tempBytes: statusAfter.tempBytes,
        stale: statusAfter.staleTempDirectories,
      }));
    } catch (error) {
      checks.push(makeCheck("status.after", "failed", { error: safeErrorMessage(error, sensitive) }));
    }
  } else {
    checks.push(makeCheck("status.after", "blocked", { error: "authentication unavailable" }));
  }

  const finishedAtValue = now();
  if (!(finishedAtValue instanceof Date) || Number.isNaN(finishedAtValue.valueOf())) {
    throw new TypeError("ASR smoke clock must return a valid Date");
  }
  const provisionalChecks = [...checks];
  provisionalChecks.push(makeCheck("evidence.no-audio-or-transcript", "passed", {
    manifestSha256,
    recordedFields: "sha256,bytes,durationMs,character-counts,CER,metrics,result",
  }));
  const summary = requestSummary(provisionalChecks);
  const report = {
    schemaVersion: ASR_PRODUCTION_SMOKE_SCHEMA_VERSION,
    runner: "sentelligent-asr-production-smoke",
    runId,
    target: { origin: exactOrigin },
    startedAt: startedAtValue.toISOString(),
    finishedAt: finishedAtValue.toISOString(),
    status: summary.failed === 0 && summary.blocked === 0 ? "passed" : "failed",
    releaseReady: summary.failed === 0
      && summary.blocked === 0
      && manifest.manualAcceptance.status === "passed",
    summary,
    thresholds: ASR_SMOKE_THRESHOLDS,
    checks: provisionalChecks,
    fixtureManifest: {
      sha256: manifestSha256,
      bytes: manifestBytes,
      qualityCount: manifest.quality.length,
      speakers: manifest.speakers,
      equivalentSyntheticVoices: manifest.equivalentSyntheticVoices,
    },
    quality,
    performance: performanceEvidence,
    cancellation: cancellationEvidence,
    boundaries: boundaryEvidence,
    runtime: {
      empty: finalRuntime?.empty === true,
      count: Number.isSafeInteger(finalRuntime?.count) ? finalRuntime.count : null,
      status: typeof finalRuntime?.status === "string" ? finalRuntime.status.slice(0, 64) : "unknown",
    },
    metrics: {
      before: statusBefore,
      after: statusAfter,
    },
    manualAcceptance: manifest.manualAcceptance,
  };

  const sensitiveValues = reportSensitiveValues({ accounts, sessions, manifest, inspectedByFile });
  sensitiveValues.push(...sensitive);
  try {
    assertReportSanitized(report, sensitiveValues);
  } catch (error) {
    provisionalChecks[provisionalChecks.length - 1] = makeCheck(
      "evidence.no-audio-or-transcript",
      "failed",
      { error: safeErrorMessage(error, sensitiveValues) },
    );
    throw error;
  } finally {
    for (const session of sessions) {
      try {
        await logoutAsrSmokeAccount({ origin: exactOrigin, session, fetchImpl });
      } catch {
        // Logout cannot change the already captured functional result.  The
        // session material remains absent from the report and expires under
        // the server's existing policy.
      }
    }
  }
  atomicWriteAsrSmokeReport(reportPath, report);
  return Object.freeze(report);
}

async function runCli() {
  let secrets = [];
  try {
    const options = parseAsrSmokeCliArguments(process.argv.slice(2));
    secrets = parseAsrSmokeSecretsStdin(readFileSync(0, "utf8"), {
      defaultAccount: options.account,
    });
    const loaded = loadProtectedAsrFixtureManifest(options.manifestPath);
    const report = await runAsrProductionSmoke({
      origin: options.origin,
      reportPath: options.reportPath,
      accounts: secrets,
      manifest: loaded.manifest,
      manifestSha256: loaded.manifestSha256,
      manifestBytes: loaded.manifestBytes,
    });
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      releaseReady: report.releaseReady,
      runId: report.runId,
      summary: report.summary,
      reportPath: resolve(options.reportPath),
    })}\n`);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (error) {
    const passwords = secrets.map(({ password }) => password);
    process.stderr.write(`ASR production smoke failed: ${safeErrorMessage(error, passwords)}\n`);
    process.exitCode = 1;
  }
}

const directEntry = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (directEntry) await runCli();
