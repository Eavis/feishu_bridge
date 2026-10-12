/**
 * Type definitions for the Feishu-Claude Bridge v2.
 *
 * Consolidated from Claude-to-IM host.ts + types.ts — stripped of
 * multi-platform abstractions (ChannelType, OutboundMessage, AdapterStatus, etc.).
 */

// ── AppContext ───────────────────────────────────────────────

import type { Config } from './config.js';

export interface AppContext {
  config: Config;
  store: import('./store.js').JsonFileStore;
  /**
   * Returns the provider for the requested backend, instantiating it lazily.
   * Throws ProviderUnavailableError if the backend's CLI is missing or fails
   * preflight — the conversation engine catches this and surfaces it to the user.
   */
  providerFactory: import('./provider-factory.js').ProviderFactory;
  permissions: import('./permissions.js').PendingPermissions;
  feishu: import('./feishu.js').FeishuClient;
  outbox?: import('./outbox-server.js').OutboxServer;
  scheduler?: import('./scheduler.js').Scheduler;
}

// ── Messages ───────────────────────────────────────────────────

/** Inbound message from Feishu. */
export interface InboundMessage {
  messageId: string;
  chatId: string;
  userId: string;
  text: string;
  timestamp: number;
  /** If this is a callback query (inline button press), the callback data */
  callbackData?: string;
  /** For callback queries: the message ID of the original message */
  callbackMessageId?: string;
  /** File attachments (images, documents) */
  attachments?: FileAttachment[];
  /** If user used Feishu's reply/quote UI, the parsed text of the quoted message. */
  quotedContent?: string;
  /** Sender display name of the quoted message (for "X 说：" attribution). */
  quotedSenderName?: string;
}

/** File attachment from Feishu (images, documents). */
export interface FileAttachment {
  id: string;
  name: string;
  type: string; // MIME type
  size: number;
  data: string; // base64 encoded content
  filePath?: string;
}

// ── Bindings ───────────────────────────────────────────────────

/** Links a Feishu chat to a bridge session. */
export interface ChannelBinding {
  id: string;
  chatId: string;
  /** Bridge session ID */
  codepilotSessionId: string;
  /** SDK session ID for resume (cached from last conversation) — scoped to the currently active `agent`. When the agent switches via /agent, the previous backend's session is parked in `agentSessions` and the new backend's prior session (if any) is restored here. */
  sdkSessionId: string;
  /** Per-backend snapshot of session IDs so /agent switches don't clobber each other's continuity. Lazily populated on first switch. */
  agentSessions?: Partial<Record<import('./provider-factory.js').AgentKind, string>>;
  /** Per-backend model overrides, parked and restored together with sessions. */
  agentModels?: Partial<Record<import('./provider-factory.js').AgentKind, string>>;
  /** Working directory for this binding */
  workingDirectory: string;
  /** Model override for this binding */
  model: string;
  /** Chat mode */
  mode: 'code' | 'plan' | 'ask';
  /** Which backend agent processes messages for this chat. Optional for back-compat with bindings persisted before this field existed; treated as config.defaultAgent when missing. */
  agent?: import('./provider-factory.js').AgentKind;
  /** Whether this binding is currently active */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── SSE Event Types ──────────────────────────────────────────

/** Server-Sent Event from the LLM stream. */
export interface SSEEvent {
  type: SSEEventType;
  data: string;
}

export type SSEEventType =
  | 'text'
  | 'text_preview'
  | 'tool_use'
  | 'tool_result'
  | 'tool_output'
  | 'tool_timeout'
  | 'status'
  | 'result'
  | 'error'
  | 'permission_request'
  | 'mode_changed'
  | 'task_update'
  | 'retry_notice'
  | 'keep_alive'
  | 'done';

// ── Session & Message ────────────────────────────────────────

/** Minimal session object. */
export interface BridgeSession {
  id: string;
  working_directory: string;
  model: string;
  system_prompt?: string;
  provider_id?: string;
}

/** Minimal message object. */
export interface BridgeMessage {
  role: string;
  content: string;
}

/** Content block in an LLM response message. */
export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'code'; language: string; code: string };

/** Token usage statistics from an LLM response. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}

// ── CLI Session Discovery ────────────────────────────────────

/** Metadata for a local CLI session discovered on disk. */
export interface CliSessionInfo {
  /** UUID matching the .jsonl file name / session-state dir — used as sdkSessionId for resume */
  sdkSessionId: string;
  /** Project name (last segment of cwd) */
  project: string;
  /** Working directory from the session */
  cwd: string;
  /** First user message (truncated for display) */
  firstPrompt: string;
  /** Human-readable slug */
  slug: string;
  /** File mtime in milliseconds */
  timestamp: number;
  /** True if the session has no "last-prompt" line (may still be running) */
  isOpen: boolean;
  /** Git branch, if available */
  gitBranch?: string;
  /** Which backend owns this session — defaults to 'claude' for legacy records. */
  backend?: import('./provider-factory.js').AgentKind;
  /** Compact, deterministic digest extracted from the local transcript. */
  digest?: SessionDigest;
  /** Deep link back to the owning Eureka task when one exists. */
  deepLink?: string;
}

/** Quick positioning summary shown in Feishu for local agent sessions. */
export interface SessionDigest {
  /** The user's first substantive request. */
  requested: string;
  /** The user's newest follow-up/change request, when different from requested. */
  latestRequest?: string;
  /** Latest delivered result, or latest visible progress while still running. */
  accomplished: string;
}

/** A Eureka or Codex task that can be inspected from the mobile Feishu client. */
export interface ActivitySessionInfo {
  id: string;
  source: 'eureka' | 'codex';
  name: string;
  status: 'running' | 'waiting' | 'completed' | 'unknown';
  updatedAt: number;
  createdAt?: number;
  cwd: string;
  engine: string;
  model: string;
  digest: SessionDigest;
  deepLink?: string;
  workspaceId?: string;
  sdkSessionId?: string;
}

// ── Tool Call Info ─────────────────────────────────────────────

/** Tool call tracking for streaming card progress display. */
export interface ToolCallInfo {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
  /** Optional short hint shown next to the tool name (e.g. Bash `description`, file path for Read/Edit). */
  hint?: string;
}

// ── Permission ───────────────────────────────────────────────

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
  /** Preserve the IM "Allow Session" choice for providers that support it. */
  allowAlways?: boolean;
}

// ── Permission Link ──────────────────────────────────────────

/** Input for inserting a permission link. */
export interface PermissionLinkInput {
  permissionRequestId: string;
  chatId: string;
  messageId: string;
  toolName: string;
  suggestions: string;
}

/** Stored permission link record. */
export interface PermissionLinkRecord {
  permissionRequestId: string;
  chatId: string;
  messageId: string;
  resolved: boolean;
  suggestions: string;
}

// ── Audit ───────────────────────────────────────────────────

/** Audit log entry input. */
export interface AuditLogInput {
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
}

// ── Upsert Binding Input ─────────────────────────────────────

/** Input for upserting a channel binding. */
export interface UpsertChannelBindingInput {
  chatId: string;
  codepilotSessionId: string;
  sdkSessionId?: string;
  workingDirectory: string;
  model: string;
  mode?: string;
}

// ── Conversation Result ──────────────────────────────────────

export interface ConversationResult {
  responseText: string;
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  permissionRequests: PermissionRequestInfo[];
  sdkSessionId: string | null;
}

// ── Stream Chat Params ───────────────────────────────────────

export interface StreamChatParams {
  prompt: string;
  sessionId: string;
  sdkSessionId?: string;
  model?: string;
  systemPrompt?: string;
  workingDirectory?: string;
  abortController?: AbortController;
  permissionMode?: string;
  files?: FileAttachment[];
  /** Extra MCP servers to register with the Claude subprocess for this turn. */
  extraMcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /**
   * When true with `sdkSessionId`, SDK forks a new branch from the given
   * session instead of continuing it. Used by /fork-chat to spawn a
   * sibling conversation that inherits context but never mutates the original.
   */
  forkSession?: boolean;
}
