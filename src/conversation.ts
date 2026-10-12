/**
 * Conversation Engine — processes inbound messages through Claude.
 *
 * Takes a ChannelBinding + inbound message, calls the LLM provider,
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 *
 * Permission requests are forwarded immediately during streaming
 * because the stream blocks until the permission is resolved.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import type {
  AppContext,
  ChannelBinding,
  FileAttachment,
  SSEEvent,
  TokenUsage,
  MessageContentBlock,
  ConversationResult,
  PermissionRequestInfo,
} from './types.js';
import { AgentStreamTimeoutError, readWithStreamDeadline, StreamDeadlinePolicy } from './stream-health.js';

export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;
export type OnPartialText = (fullText: string) => void;
export type OnToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error', toolInput?: unknown) => void;
export type OnRetryNotice = (info: { reason: string; attempt: number; total: number; originalError: string }) => void;

/**
 * Build the per-turn MCP server config. Currently registers feishu-outbox
 * so Claude can send files back to the user.
 */
function buildExtraMcpServers(
  ctx: AppContext,
  chatId: string | undefined,
  workDir: string | undefined,
  replyToMessageId: string | undefined,
): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> | undefined {
  if (!ctx.outbox || !chatId || !workDir) return undefined;
  const token = ctx.outbox.registerSession(chatId, workDir, replyToMessageId);
  const port = ctx.outbox.getPort();

  // Resolve MCP server path relative to bridge bundle location.
  // dist/daemon.mjs lives at <project>/dist; the MCP script at <project>/mcp-servers/feishu-outbox.mjs.
  let scriptPath: string;
  try {
    const here = url.fileURLToPath(import.meta.url);
    const projectRoot = path.resolve(path.dirname(here), '..');
    scriptPath = path.join(projectRoot, 'mcp-servers', 'feishu-outbox.mjs');
  } catch {
    scriptPath = path.join(process.cwd(), 'mcp-servers', 'feishu-outbox.mjs');
  }

  return {
    'feishu-outbox': {
      command: process.execPath, // current node binary
      args: [scriptPath],
      env: {
        FEISHU_OUTBOX_URL: `http://127.0.0.1:${port}`,
        FEISHU_OUTBOX_TOKEN: token,
        FEISHU_OUTBOX_WORKDIR: workDir,
      },
    },
  };
}

/**
 * Process an inbound message: send to Claude, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(
  ctx: AppContext,
  binding: ChannelBinding,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
  chatId?: string,
  replyToMessageId?: string,
  forkSession?: boolean,
  onRetryNotice?: OnRetryNotice,
  skipUserMessagePersistence = false,
  forceFreshSession = false,
): Promise<ConversationResult> {
  const sessionId = binding.codepilotSessionId;

  // Acquire session lock
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = ctx.store.acquireSessionLock(sessionId, lockId, 'bridge-feishu', 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      permissionRequests: [],
      sdkSessionId: null,
    };
  }

  const renewalInterval = setInterval(() => {
    try { ctx.store.renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
  }, 60_000);

  try {
    const session = ctx.store.getSession(sessionId);

    // Save user message with file attachments
    let savedContent = text;
    if (files && files.length > 0) {
      const workDir = binding.workingDirectory || session?.working_directory || '';
      if (workDir) {
        try {
          const uploadDir = path.join(workDir, '.codepilot-uploads');
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          const fileMeta = files.map((f) => {
            const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
            const buffer = Buffer.from(f.data, 'base64');
            fs.writeFileSync(filePath, buffer);
            // Write the local path back onto the file object so the provider
            // (buildPrompt) can reference it for non-image attachments.
            f.filePath = filePath;
            return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
          });
          savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${text}`;
        } catch (err) {
          console.warn('[conversation] Failed to persist attachments:', err instanceof Error ? err.message : err);
          savedContent = `[${files.length} image(s) attached] ${text}`;
        }
      } else {
        savedContent = `[${files.length} image(s) attached] ${text}`;
      }
    }
    if (!forkSession && !skipUserMessagePersistence) {
      ctx.store.addMessage(sessionId, 'user', savedContent);
    }

    // Permission mode from binding mode
    let permissionMode: string;
    switch (binding.mode) {
      case 'plan': permissionMode = 'plan'; break;
      case 'ask': permissionMode = 'default'; break;
      default: permissionMode = 'acceptEdits'; break;
    }

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const stream = (() => {
      try {
        const provider = ctx.providerFactory(binding.agent ?? ctx.config.defaultAgent);
        return provider.streamChat({
          prompt: text,
          sessionId,
          sdkSessionId: forceFreshSession ? undefined : (binding.sdkSessionId || undefined),
          model: binding.model || session?.model || ctx.config.defaultModel,
          systemPrompt: session?.system_prompt || undefined,
          workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
          abortController,
          permissionMode,
          files,
          extraMcpServers: buildExtraMcpServers(ctx, chatId, binding.workingDirectory || session?.working_directory, replyToMessageId),
          forkSession: forkSession || forceFreshSession,
        });
      } catch (err) {
        // ProviderUnavailableError or any other init failure — surface as a
        // one-shot error SSE stream so the conversation engine and delivery
        // layer treat it uniformly.
        const msg = err instanceof Error ? err.message : String(err);
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: msg })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'done', data: '' })}\n`);
            controller.close();
          },
        });
      }
    })();

    return await consumeStream(
      ctx, stream, sessionId, onPermissionRequest, onPartialText, onToolEvent,
      forkSession, onRetryNotice, abortController,
    );
  } finally {
    clearInterval(renewalInterval);
    ctx.store.releaseSessionLock(sessionId, lockId);
  }
}

/**
 * Consume an SSE stream and extract response data.
 */
async function consumeStream(
  ctx: AppContext,
  stream: ReadableStream<string>,
  sessionId: string,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
  forkSession?: boolean,
  onRetryNotice?: OnRetryNotice,
  abortController?: AbortController,
): Promise<ConversationResult> {
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  let previewText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  const seenToolResultIds = new Set<string>();
  const permissionRequests: PermissionRequestInfo[] = [];
  let capturedSdkSessionId: string | null = null;
  const deadlines = new StreamDeadlinePolicy(
    Date.now(),
    ctx.config.agentFirstEventTimeoutMs,
    ctx.config.agentIdleTimeoutMs,
    ctx.config.agentMaxTurnTimeoutMs,
  );

  try {
    while (true) {
      const chunk = await readWithStreamDeadline(reader, deadlines);
      const { done, value } = chunk;
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        let event: SSEEvent;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        switch (event.type) {
          case 'text':
            // Authoritative, committed text — saved and used to build the
            // final card. (Live token preview arrives via 'text_preview'.)
            currentText += event.data;
            break;

          case 'text_preview':
            // Transient live tokens — drive the streaming card only, never saved.
            // Orphaned partials from an abandoned message may flicker here, but
            // the finalized card is rebuilt from committed 'text'/contentBlocks.
            if (onPartialText) {
              previewText += event.data;
              try { onPartialText(previewText); } catch { /* non-critical */ }
            }
            break;

          case 'tool_use': {
            if (currentText.trim()) {
              contentBlocks.push({ type: 'text', text: currentText });
              currentText = '';
            }
            // Step boundary: keep the live preview's lines separated too, so
            // streaming matches the finalized card (one step per line).
            if (previewText && !previewText.endsWith('\n')) {
              previewText += '\n';
            }
            try {
              const toolData = JSON.parse(event.data);
              contentBlocks.push({
                type: 'tool_use',
                id: toolData.id,
                name: toolData.name,
                input: toolData.input,
              });
              if (onToolEvent) {
                try { onToolEvent(toolData.id, toolData.name, 'running', toolData.input); } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'tool_result': {
            try {
              const resultData = JSON.parse(event.data);
              const newBlock = {
                type: 'tool_result' as const,
                tool_use_id: resultData.tool_use_id,
                content: resultData.content,
                is_error: resultData.is_error || false,
              };
              if (seenToolResultIds.has(resultData.tool_use_id)) {
                const idx = contentBlocks.findIndex(
                  (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id,
                );
                if (idx >= 0) contentBlocks[idx] = newBlock;
              } else {
                seenToolResultIds.add(resultData.tool_use_id);
                contentBlocks.push(newBlock);
              }
              if (onToolEvent) {
                try {
                  onToolEvent(resultData.tool_use_id, '', resultData.is_error ? 'error' : 'complete');
                } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'permission_request': {
            try {
              const permData = JSON.parse(event.data);
              const perm: PermissionRequestInfo = {
                permissionRequestId: permData.permissionRequestId,
                toolName: permData.toolName,
                toolInput: permData.toolInput,
                suggestions: permData.suggestions,
              };
              permissionRequests.push(perm);
              if (onPermissionRequest) {
                onPermissionRequest(perm).catch((err) => {
                  console.error('[conversation] Failed to forward permission request:', err);
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'retry_notice': {
            // Provider is about to retry; wipe any text/tool blocks we've
            // accumulated so the final card reflects only the retry result.
            try {
              const noticeData = JSON.parse(event.data);
              contentBlocks.length = 0;
              currentText = '';
              previewText = '';
              seenToolResultIds.clear();
              if (onRetryNotice) {
                try { onRetryNotice(noticeData); } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'status': {
            try {
              const statusData = JSON.parse(event.data);
              if (statusData.session_id) {
                capturedSdkSessionId = statusData.session_id;
                if (!forkSession) ctx.store.updateSdkSessionId(sessionId, statusData.session_id);
              }
              if (statusData.model && !forkSession) {
                ctx.store.updateSessionModel(sessionId, statusData.model);
              }
            } catch { /* skip */ }
            break;
          }

          case 'error':
            hasError = true;
            errorMessage = event.data || 'Unknown error';
            break;

          case 'result': {
            try {
              const resultData = JSON.parse(event.data);
              if (resultData.usage) tokenUsage = resultData.usage;
              if (resultData.is_error) hasError = true;
              if (resultData.session_id) {
                capturedSdkSessionId = resultData.session_id;
                if (!forkSession) ctx.store.updateSdkSessionId(sessionId, resultData.session_id);
              }
            } catch { /* skip */ }
            break;
          }
        }
      }
    }

    // Flush remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    // Save assistant message
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result',
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();

      if (content && !forkSession) {
        ctx.store.addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
      }
    }

    const responseText = contentBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text.trim())
      .filter(Boolean)
      // Each text block is one agentic step's narration (separated by tool calls).
      // Join with a single line break so each step (ending in 👉) sits on its own
      // line — no blank line between steps.
      .join('\n')
      .trim();

    return {
      responseText,
      tokenUsage,
      hasError,
      errorMessage,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  } catch (e) {
    if (e instanceof AgentStreamTimeoutError) {
      abortController?.abort();
      void reader.cancel(e.message).catch(() => {});
      console.error(`[conversation] ${e.message}; provider aborted and session lock released`);
    }
    // Best-effort save on stream error
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result',
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();
      if (content && !forkSession) {
        ctx.store.addMessage(sessionId, 'assistant', content);
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';

    return {
      responseText: '',
      tokenUsage,
      hasError: true,
      errorMessage: isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error'),
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  }
}
