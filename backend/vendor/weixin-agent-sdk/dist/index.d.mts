//#region src/agent/interface.d.ts
/**
 * Agent interface — any AI backend that can handle a chat message.
 *
 * Implement this interface to connect WeChat to your own AI service.
 * The WeChat bridge calls `chat()` for each inbound message and sends
 * the returned response back to the user.
 */
interface Agent {
  /** Process a single message and return a reply. */
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Clear/reset the session for a given conversation. */
  clearSession?(conversationId: string): void;
}
interface ChatRequest {
  /** Conversation / user identifier. Use this to maintain per-user context. */
  conversationId: string;
  /** Text content of the message. */
  text: string;
  /** Attached media file (image, audio, video, or generic file). */
  media?: {
    type: "image" | "audio" | "video" | "file"; /** Local file path (already downloaded and decrypted). */
    filePath: string; /** MIME type, e.g. "image/jpeg", "audio/wav". */
    mimeType: string; /** Original filename (available for file attachments). */
    fileName?: string;
  };
  /** Sender identifier supplied by the provider. */
  senderId: string;
  /** Opaque, deterministic inbound-delivery identity. */
  messageId: string;
  /** Conversation kind after bounded metadata classification. */
  chatType: "direct" | "group";
  /** Present only for a classified group conversation. */
  groupId?: string;
  /** Provider delivery time in safe epoch milliseconds. */
  deliveryTimestampMs: number;
}
interface ChatResponse {
  /** Reply text (may contain markdown — will be converted to plain text before sending). */
  text?: string;
  /** Reply media file. */
  media?: {
    type: "image" | "video" | "file"; /** Local file path or HTTPS URL. */
    url: string; /** Filename hint (for file attachments). */
    fileName?: string;
  };
}
//#endregion
//#region src/bot.d.ts
type LoginOptions = {
  /** Override the API base URL. */baseUrl?: string; /** Log callback (defaults to console.log). */
  log?: (msg: string) => void;
};
type InboundAuthorizationMetadata = {
  /** Provider sender identifier validated by the bounded inbound projection. */senderId: string;
  /** Conversation kind after bounded metadata classification. */chatType: "direct" | "group";
  /** Present only for a classified group conversation. */groupId?: string;
};
type StartOptions = {
  /** Account ID to use. Auto-selects the first registered account if omitted. */accountId?: string; /** AbortSignal to stop the bot. */
  abortSignal?: AbortSignal; /** Log callback (defaults to console.log). */
  log?: (msg: string) => void;
  /** Required 32-byte key used to derive opaque inbound delivery identifiers. */
  deliveryKey: Uint8Array;
  /** Audited classifier invoked with bounded provider metadata only. */
  classifyChat?: (metadata: Record<string, unknown>) => {
    chatType: "direct" | "group";
    groupId?: string;
  } | null | undefined;
  /** Fail-closed host authorization hook invoked before config lookup or media download. */
  authorizeInbound?: (metadata: Readonly<InboundAuthorizationMetadata>) => boolean | Promise<boolean>;
};
type InboundMedia = {
  sha256: string;
  fileName?: string;
  requestMedia?: ChatRequest["media"];
};
type InboundChatMetadata = {
  chatType: "direct" | "group";
  groupId?: string;
};
/**
 * Interactive QR-code login. Prints the QR code to the terminal and waits
 * for the user to scan it with WeChat.
 *
 * Returns the normalized account ID on success.
 */
declare function login(opts?: LoginOptions): Promise<string>;
/**
 * Remove all stored WeChat account credentials.
 */
declare function logout(opts?: {
  log?: (msg: string) => void;
}): void;
/**
 * Check whether at least one WeChat account is logged in and configured.
 */
declare function isLoggedIn(): boolean;
/**
 * A running bot instance — provides proactive messaging capability.
 *
 * - `sendMessage(text)` — send a text message to the logged-in user.
 * - `sendMessage(response)` — send a ChatResponse (text and/or media).
 */
declare class Bot {
  private readonly _accountId;
  private readonly _baseUrl;
  private readonly _cdnBaseUrl;
  private readonly _token?;
  private readonly _userId;
  private readonly _monitorPromise;
  /** @internal */
  constructor(params: {
    accountId: string;
    baseUrl: string;
    cdnBaseUrl: string;
    token?: string;
    userId: string;
    monitorPromise: Promise<void>;
  });
  /**
   * Wait until the background WeChat monitor stops.
   *
   * This is useful for CLI programs that should keep running until the bot is
   * aborted, and for surfacing unrecoverable monitor errors to the caller.
   */
  wait(): Promise<void>;
  /**
   * Proactively send a message to the logged-in WeChat user.
   *
   * Accepts either a plain string (sent as text) or a full `ChatResponse`
   * object (text and/or media).
   *
   * Requires at least one inbound message to have been received so that a
   * valid `context_token` is cached (tokens are valid for ~24 hours).
   */
  sendMessage(message: string | ChatResponse): Promise<void>;
}
/**
 * Start the bot — long-polls for new messages and dispatches them to the agent.
 *
 * Returns a `Bot` instance immediately. Use `bot.wait()` when a CLI program
 * should block until the background monitor stops.
 */
declare function start(agent: Agent, opts: StartOptions): Bot;
/**
 * Pure, bounded projection from an upstream update to an agent request.
 * This is exported as a test seam; callers must supply a 32-byte delivery key.
 */
declare function normalizeInboundUpdate(full: Record<string, unknown>, opts: {
  deliveryKey: Uint8Array;
  media?: InboundMedia | null;
  chatMetadata?: InboundChatMetadata | null;
}): ChatRequest;
//#endregion
export { type Agent, Bot, type ChatRequest, type ChatResponse, type InboundAuthorizationMetadata, type InboundChatMetadata, type InboundMedia, type LoginOptions, type StartOptions, isLoggedIn, login, logout, normalizeInboundUpdate, start };
