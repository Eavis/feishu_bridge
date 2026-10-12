# ARCHITECTURE.md — Implementation Guide

Read this file before making any code changes. It covers the end-to-end message flow, all source files, critical implementation details, and data layout.

## End-to-End Message Flow

```
Feishu app ──WebSocket──▶ WSClient (monkey-patched for card callbacks)
                              │
                              ▼
                     FeishuClient.handleIncomingEvent()
                         dedup → auth → @mention check
                              │
                              ▼
                     FeishuClient.enqueue(InboundMessage)
                              │
                              ▼
                     bridge.runBridgeLoop()
                         feishu.consumeOne() → handleMessage()
                              │
               ┌──────────────┼───────────────┐
               ▼              ▼                ▼
          Permission     Slash command     Regular message
          shortcut       handleCommand()   conversation.processMessage()
          (1/2/3)             │                   │
               │              │                   ▼
               ▼              │            ClaudeProvider.streamChat()
          permissions.        │                   │
          resolve()           │                   ▼
                              │            Claude Agent SDK query()
                              │                   │
                              │              SSE stream events
                              │                   │
                              │    ┌──────────────┼──────────────┐
                              │    ▼              ▼              ▼
                              │  text_delta   tool_use      permission_request
                              │    │              │              │
                              │    ▼              ▼              ▼
                              │  feishu.      feishu.       permissions.
                              │  onStreamText onToolEvent   forwardPermission
                              │    │              │          Request()
                              │    ▼              ▼              │
                              │  CardKit v2  Card tool      ┌───┘
                              │  element     progress       ▼
                              │  update      display    Permission card
                              │    │              │     in Feishu
                              │    └──────┬───────┘         │
                              │           ▼                 │
                              │    feishu.finalizeCard()     │
                              │    (streaming_mode: false)   │
                              │           │                 │
                              ▼           ▼                 ▼
                         deliver()   Card complete    User taps button
                         (fallback   with footer      or replies 1/2/3
                          if no      (tokens, cost,       │
                          card)      elapsed)             ▼
                                                    Stream resumes
```

### Key flow details

1. **WebSocket events** arrive as `type: "event"` (messages) or `type: "card"` (button callbacks). The SDK only handles `"event"`, so we monkey-patch `WSClient.handleEventData` to rewrite `"card"` → `"event"`.

2. **Numeric shortcuts** (`1`/`2`/`3`) are checked and processed **outside** the session lock in `runBridgeLoop()`. This prevents a deadlock: a running conversation holds the session lock while waiting for permission approval — if the "1" message also waited for the lock, it would never arrive.

3. **Permission blocking**: When Claude calls a tool, `ClaudeProvider.canUseTool()` emits a `permission_request` SSE event, then calls `pendingPerms.waitFor(toolUseID)` which returns a Promise that blocks until the user responds. The entire stream is paused during this time. Timeout: 5 minutes.

4. **Streaming cards**: CardKit v2 card is created at `onMessageStart()`, text updates go through throttled `cardElement.content()` calls (200ms minimum interval), and the final card is assembled with `card.update()` which replaces the entire card body with response text + tool progress + footer.

---

## File-by-File Guide

### `main.ts` (172 lines) — Entry point

Assembles `AppContext` → resolves providers → starts the fixed-port health server and `FeishuClient` → writes PID/status files → runs `bridge.runBridgeLoop()` → handles SIGTERM/SIGINT graceful shutdown (denies all pending permissions, stops WebSocket). Includes an inner WebSocket watchdog and an idle hourly recycle; PM2 restarts the process when it exits.

### `config.ts` (84 lines) — Configuration loader

Reads `./config.env` from the project root (simple `KEY=VALUE` parser). Returns a `Config` object. The `CTI_HOME` constant (defaults to `.bridge/` under the project directory) is used for all runtime data.

### `types.ts` (235 lines) — All type definitions

Central type file. Key types:
- `AppContext` — dependency injection container (config, store, provider, permissions, feishu)
- `InboundMessage` — normalized message from Feishu (text, attachments, callbackData)
- `ChannelBinding` — links a Feishu chat to a bridge session + SDK session
- `SSEEvent` / `SSEEventType` — events from the LLM stream
- `StreamChatParams` — parameters for `ClaudeProvider.streamChat()`
- `ConversationResult` — return value from `conversation.processMessage()`
- `PermissionRequestInfo` / `PermissionResult` — permission flow types
- `CliSessionInfo` — metadata for discovered local CLI sessions

### `feishu.ts` (~1,050 lines) — Feishu client

The largest file. Handles all Feishu communication (includes `getWsReadyState()` for the watchdog):

- **WebSocket lifecycle**: `start()` / `stop()`, bot identity resolution via REST API, pong/handshake timeouts, and lifecycle callbacks
- **Monkey-patch**: Rewrites `type: "card"` → `type: "event"` in `WSClient.handleEventData` so card action callbacks reach the event dispatcher
- **Inbound queue**: `consumeOne()` / `enqueue()` — bridge loop pulls messages one at a time
- **Message parsing**: Text, image, file, audio, video, post (rich text with embedded images)
- **Resource download**: Downloads image/file attachments via `im.messageResource.get`, converts to base64 `FileAttachment`
- **Streaming cards (CardKit v2)**:
  - `createStreamingCard()` — creates card with `streaming_mode: true`, sends as message
  - `updateCardContent()` → `flushCardUpdate()` — throttled element content updates
  - `finalizeCard()` — disables streaming mode via `card.settings()`, then replaces full card via `card.update()`
- **3-layer send degradation**: `send()` → tries card → falls back to post → falls back to plain text
- **Permission cards**: `sendPermissionCard()` — interactive card with Allow/Allow Session/Deny buttons
- **Typing indicator**: Adds/removes emoji reaction on the user's message
- **Authorization**: Checks `feishuAllowedUsers` config (user ID or chat ID allowlist)
- **Dedup**: In-memory `seenMessageIds` map (max 1000 entries)

### `bridge.ts` (593 lines) — Message orchestrator

The main loop and command router:

- **`runBridgeLoop()`**: Infinite loop calling `feishu.consumeOne()`. Routes to `handleMessage()`. Callbacks, slash commands, and numeric shortcuts are processed directly; regular messages go through `processWithSessionLock()`.
- **Session locks**: Promise-chaining serialization per session. Each session's messages queue behind each other.
- **`handleMessage()`**: Handles callback queries (permission buttons), numeric shortcuts (1/2/3), slash commands, and regular messages.
- **Slash commands**: `/help`, `/new`, `/bind`, `/list`, `/resume`, `/tasks`, `/summary`, `/cwd`, `/mode`, `/status`, `/stop`, `/perm`
- **`/list` cache**: Per-chat, 5-minute TTL, so `/resume 3` can reference the same list
- **Tool call tracking**: `Map<string, ToolCallInfo>` built during streaming, passed to `feishu.onToolEvent()`
- **Active tasks**: `Map<string, AbortController>` for `/stop` cancellation

### `claude-provider.ts` (514 lines) — Claude Agent SDK wrapper

- **CLI resolution**: `resolveClaudeCliPath()` checks `CTI_CLAUDE_CODE_EXECUTABLE` env, then PATH, then well-known locations. Validates version >= 2.x and required flags.
- **`preflightCheck()`**: Runs `claude --version` and `claude --help` to verify compatibility.
- **`streamChat()`**: Returns a `ReadableStream<string>` of SSE-formatted events. Internally calls `query()` from `@anthropic-ai/claude-agent-sdk`.
- **`canUseTool` callback**: The blocking permission mechanism. Enqueues a `permission_request` SSE event, then `await pendingPerms.waitFor(toolUseID)`. The stream pauses until resolved.
- **`handleMessage()`**: Translates SDK message types (`stream_event`, `assistant`, `user`, `result`, `system`) into SSE events (`text`, `tool_use`, `tool_result`, `result`, `status`, `error`).
- **Multi-modal**: `buildPrompt()` converts text + image attachments into the SDK's content block format.
- **Auth error classification**: `classifyAuthError()` detects CLI auth vs API auth errors and provides user-friendly messages.
- **Environment isolation**: `buildSubprocessEnv()` strips `CLAUDECODE` env var to prevent recursive invocation.

### `conversation.ts` (349 lines) — Conversation engine

- **`processMessage()`**: Acquires session lock (600s TTL, renewed every 60s) → saves user message → builds `StreamChatParams` → calls `provider.streamChat()` → `consumeStream()` → saves assistant message → releases lock.
- **`consumeStream()`**: Reads from the `ReadableStream`, parses SSE lines, accumulates text, tracks tool calls and results, captures `sdkSessionId` and `tokenUsage`, forwards permission requests.
- **File attachments**: Persisted to `.codepilot-uploads/` in the working directory before being passed to the provider.

### `permissions.ts` (199 lines) — Permission management

- **`PendingPermissions` class**: `waitFor(toolUseID)` → Promise with 5-minute timeout. `resolve()` fulfills it. `denyAll()` for shutdown.
- **`forwardPermissionRequest()`**: Builds markdown description, calls `feishu.sendPermissionCard()`, records a `PermissionLink` in the store.
- **`handlePermissionCallback()`**: Parses `perm:action:id` callback data, validates chat/message match, marks link resolved, calls `pendingPerms.resolve()`.

### `store.ts` (401 lines) — JSON file persistence

In-memory Maps with write-through to JSON files in `.bridge/data/`:
- `sessions.json` — bridge sessions
- `bindings.json` — chat ↔ session bindings (keyed by `feishu:{chatId}`)
- `permissions.json` — permission link records
- `messages/{sessionId}.json` — message history per session
- `offsets.json`, `dedup.json`, `audit.json` — bookkeeping

Also provides: session locking (`acquireSessionLock` / `renewSessionLock` / `releaseSessionLock`), CLI session discovery (delegates to `session-scanner.ts`), SDK session ID updates (propagates to both session and binding records).

### `delivery.ts` (176 lines) — Reliable message delivery

- **Chunking**: Splits at 30KB (Feishu limit), prefers splitting at newlines
- **Rate limiting**: 20 messages/minute per chat (sliding window)
- **Retry**: 3 attempts with exponential backoff + jitter, skips 400/403/404
- **Dedup**: Optional dedup key checked against store
- **Audit**: Logs outbound messages to the audit trail

### `session-scanner.ts` (223 lines) — CLI session discovery

Scans `~/.claude/projects/<project>/<uuid>.jsonl` files:
- Reads first 20 lines (head) for session metadata (cwd, git branch, first prompt, slug)
- Reads last 500 bytes (tail) to check if session has `last-prompt` line (closed vs. still open)
- Returns sorted by mtime, max 30 days old
- Used by `/list` and `/resume` commands

### `activity-session-scanner.ts` — Eureka/Codex mobile activity view

- Discovers Eureka task JSONL under `~/.eureka*` / legacy `~/.craft-agent`
- Discovers Codex rollouts from global `CODEX_HOME` and Eureka per-task `.codex-home`
- Distinguishes live tasks from history, extracts request/change/result digests, and correlates Codex thread IDs back to clickable `eureka://` task links
- Used by `/tasks` and `/summary`; reads local durable state only and does not invoke a model

### `eureka-provider.ts` — Eureka desktop execution backend

- Implements Streamable HTTP MCP initialization and tool calls against the local Eureka desktop endpoint
- Creates or resumes a real Eureka task, forwards attachments and permission choices, polls incremental turn/tool state, and maps it into bridge SSE events
- Handles MCP-session renewal, explicit endpoint/tool failures, timeout, `/stop` interruption, and transcript fallback when a terminal status arrives without a delta

### `feishu-markdown.ts` (189 lines) — Markdown helpers

- **`hasComplexMarkdown()`**: Detects code blocks or tables → route to card rendering
- **`buildCardContent()`**: Wraps markdown in a schema 2.0 card
- **`buildPostContent()`**: Wraps markdown in a `post` message (for fallback)
- **`htmlToFeishuMarkdown()`**: Basic HTML → Feishu markdown conversion
- **`buildStreamingContent()`**: Combines text + tool progress for live card updates
- **`buildFinalCardJson()`**: Full card body with response text + tool progress + footer (status, elapsed, tokens, cost, context %)
- **`buildPermissionButtonCard()`**: Interactive card with Allow/Allow Session/Deny buttons

### `validators.ts` (71 lines) — Input validation

- `validateWorkingDirectory()`: Absolute path, no traversal, no shell metacharacters
- `validateSessionId()`: UUID hex pattern
- `isDangerousInput()`: Blocks null bytes, `../`, `$()`, backtick substitution, pipe-to-shell, etc.
- `sanitizeInput()`: Strips control characters, truncates at 32KB

### `logger.ts` (82 lines) — Logging

Overrides `console.log/error/warn` to write to `.bridge/logs/bridge.log`. Secret masking (tokens, API keys, Bearer tokens). Log rotation at 10MB, keeps 3 rotated files.

---

## Critical Implementation Details

### 1. WSClient Monkey-Patch

**File**: `feishu.ts:151-171`

The `@larksuiteoapi/node-sdk` WSClient only dispatches messages with `type: "event"`. Card action callbacks arrive as `type: "card"` and are silently dropped. The monkey-patch intercepts `handleEventData()` and rewrites the type header before passing to the original handler.

**If this patch breaks**: Card buttons (permission Allow/Deny) will silently stop working. The `card.action.trigger` event handler will never fire. Check if the SDK updated its internal method name.

### 2. CardKit v2 API Structure

**File**: `feishu.ts:493-499`

The `cardkit.v1.card.update` endpoint requires:
```typescript
data: {
  card: { type: 'card_json', data: finalCardJson },
  sequence: state.sequence,
}
```
Note: `type` and `data` must be nested inside a `card` object. A flat structure `{ type, data, sequence }` returns error `99992402: field validation failed: card is required`.

Similarly, `cardkit.v1.card.create` uses a flat structure: `data: { type: 'card_json', data: ... }` — no wrapping `card` object. These two endpoints are inconsistent.

### 3. Permission Deadlock Prevention

**File**: `bridge.ts:161-186`

In `runBridgeLoop()`, three types of messages bypass the session lock:
- `msg.callbackData` (card button presses)
- Messages starting with `/` (slash commands)
- Numeric permission shortcuts (`1`/`2`/`3`) when pending permissions exist

This is critical because: a running conversation holds the session lock while `canUseTool()` awaits permission. If the user's "1" reply also waited for the session lock, it would deadlock.

The global receive loop never awaits command completion. Normal commands are
ordered per chat; subsequent prompts wait for those commands before resolving
their binding. Stop commands, permission replies, and card callbacks bypass
the command queue. `getCommandHealth()` tracks active command age and pending
messages; commands older than five minutes make `/health` unhealthy and trigger
the process watchdog. Pending work also defers hourly idle maintenance.

### 4. canUseTool Blocking Pattern

**File**: `claude-provider.ts:307-331`

The SDK's `query()` provides a `canUseTool` callback that must return a `PermissionResult`. Our implementation:
1. Emits a `permission_request` SSE event into the stream
2. Calls `pendingPerms.waitFor(toolUseID)` → blocks the entire query stream
3. Returns `{ behavior: 'allow' }` or `{ behavior: 'deny', message }` when the user responds

The stream is fully paused during this wait. Timeout: 5 minutes (auto-deny).

### 5. Streaming Card Lifecycle

**File**: `feishu.ts:297-513`

1. **Create**: `cardkit.v1.card.create` with `streaming_mode: true` → get `card_id`
2. **Send**: `im.message.create` or `im.message.reply` with `msg_type: 'interactive'` referencing the card
3. **Update**: `cardkit.v1.cardElement.content` targeting `element_id: 'streaming_content'`, with incrementing `sequence` numbers, throttled to 200ms minimum interval
4. **Finalize**: First `cardkit.v1.card.settings` to disable streaming mode, then `cardkit.v1.card.update` to replace the full card body with final content

### 6. WebSocket self-healing

The Feishu SDK liveness watchdog is enabled with a 15-second pong timeout after each server-directed ping, so half-open sockets are terminated and reconnected. An outer 30-second monitor reads the SDK lifecycle state and exits for PM2 restart on terminal failure or after two minutes of continuous reconnecting.

Windows adds an out-of-process scheduled watchdog (`scripts/windows-watchdog.ps1`) every five minutes. It checks both the PM2 PID and `http://127.0.0.1:59991/health`, waits through a short reconnect grace period, then uses `startOrRestart ecosystem.config.cjs --only feishu-bridge`. This recovers stopped/errored entries and missing dumps without resurrecting unrelated apps. Health must match the managed PID. Duplicate instances and failed commands are reported as failures. The installer supports S4U boot recovery; the logon-only fallback is explicit.

`feishu-http.ts` supplies a private SDK HTTP client with both request and absolute
abort deadlines, covering token requests and download streams. Its response
interceptor preserves the SDK's unwrapped-data and `$return_headers` contracts.
It does not mutate the SDK's shared default transport.

### 6.1 Agent stream deadlines

`stream-health.ts` races each real `ReadableStream.read()` against first-event, idle, and absolute deadlines. On timeout, `conversation.ts` aborts the provider, cancels the reader, records an explicit error, and releases the session lock. Codex additionally destroys its Windows child pipes and terminates the full subprocess tree without waiting for an unreliable `close` event.

### 7. Session Lock + Renewal

**File**: `conversation.ts:47-61`, `store.ts:257-282`

- Lock acquired with 600s TTL
- Renewed every 60s via `setInterval`
- Released in `finally` block after stream consumption
- If a lock is held by another request, `processMessage()` returns immediately with "Session is busy"

---

## Data Directory Layout

Configuration lives at the project root; all runtime data lives under `.bridge/`:

```
<project root>/
├── config.env                    # Configuration (see CLAUDE.md)
└── .bridge/                      # Runtime data (gitignored)
    ├── data/
    │   ├── sessions.json         # { "uuid": { id, working_directory, model, ... } }
    │   ├── bindings.json         # { "feishu:chatId": { id, chatId, codepilotSessionId, sdkSessionId, ... } }
    │   ├── permissions.json      # { "toolUseId": { permissionRequestId, chatId, messageId, resolved } }
    │   ├── messages/
    │   │   └── {sessionId}.json  # [{ role: "user"|"assistant", content: "..." }, ...]
    │   ├── offsets.json          # Channel cursor offsets
    │   ├── dedup.json            # Message dedup keys with timestamps
    │   └── audit.json            # Outbound message audit trail (last 1000)
    ├── logs/
    │   ├── bridge.log            # Current log (max 10MB)
    │   ├── bridge.log.1          # Rotated logs
    │   ├── bridge.log.2
    │   └── bridge.log.3
    └── runtime/
        ├── bridge.pid            # Process ID file
        └── status.json           # { running, pid, runId, startedAt, lastExitReason }
```

---

## Important Notes for Modifications

1. **AppContext is passed explicitly** — no global state. Every function that needs config, store, feishu, or permissions receives it through the `ctx: AppContext` parameter.

2. **All persistence is write-through** — `store.ts` methods modify the in-memory Map and immediately write to disk. There is no batch/lazy flush. This means calling `updateChannelBinding()` inside a loop will write `bindings.json` on every iteration.

3. **The SDK session ID (`sdkSessionId`) is distinct from the bridge session ID (`codepilotSessionId`)**. The bridge session is our internal bookkeeping; the SDK session is the Claude Agent SDK's session UUID used for `resume`. When creating a new binding, `sdkSessionId` starts empty and gets populated after the first `query()` returns a `result` or `status` event.

4. **3-layer send degradation order**: Card (schema 2.0) → Post (msg_type: post, with md tag) → Text (msg_type: text, plain string). If the bot lacks `cardkit:card` scope, cards fail and posts are used. If posts fail, plain text is the final fallback.

5. **The `@larksuiteoapi/node-sdk` types are incomplete**. Many calls use `(this.restClient as any).cardkit.v1.card.*` because the SDK doesn't have TypeScript definitions for CardKit v2 APIs. If the SDK adds types in a future version, these casts can be removed.

6. **Tests are in `src/__tests__/`**:
   - `unit.test.ts` — 55 tests, no network, tests validators/markdown/delivery/store/scanner
   - `feishu-api.test.ts` — 5 tests, requires live Feishu credentials
   - `integration.test.ts` — 6 tests, requires live Feishu credentials, tests full send/card lifecycle
   - Tests use `node:test` runner. **Do not use `async describe()`** — it causes tests to silently skip. Use top-level `test()` with `before()`/`after()` hooks instead.
