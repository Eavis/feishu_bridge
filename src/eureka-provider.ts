/**
 * Eureka desktop provider.
 *
 * Uses Eureka's real Streamable HTTP MCP endpoint to create/resume tasks,
 * submit turns, observe incremental status, forward permissions, and stop work.
 */

import type { PendingPermissions } from './permissions.js';
import type { FileAttachment, StreamChatParams } from './types.js';

export const DEFAULT_EUREKA_MCP_URL = 'http://127.0.0.1:21900/mcp';

export type EurekaAgentEngine = 'claude' | 'codex' | 'copilot' | 'pi';
type EurekaPermissionMode = 'safe' | 'ask' | 'allow-all';
type EurekaThinkingLevel = 'off' | 'think' | 'max';

export interface EurekaProviderConfig {
  endpoint?: string;
  callerSessionId?: string;
  agentEngine?: EurekaAgentEngine;
  thinkingLevel?: EurekaThinkingLevel;
  enabledSourceSlugs?: string[];
  pollIntervalMs?: number;
  turnTimeoutMs?: number;
  requestTimeoutMs?: number;
  autoApprove?: boolean;
}

interface JsonRpcEnvelope {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

interface EurekaTurn {
  id?: string;
  role?: string;
  text?: string;
  isIntermediate?: boolean;
  isError?: boolean;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResult?: unknown;
}

interface EurekaPermission {
  request_id?: string;
  id?: string;
  tool_name?: string;
  toolName?: string;
  tool_input?: unknown;
  toolInput?: unknown;
  input?: unknown;
  arguments?: unknown;
  suggestions?: unknown[];
}

interface EurekaAgentStatus {
  engine?: string;
  model?: string;
  thinkingLevel?: string;
  status?: string;
  turns?: EurekaTurn[];
  pending_permissions?: EurekaPermission[];
  error?: string;
}

type FetchLike = typeof fetch;

function sseEvent(type: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: payload })}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseEventStream(body: string): JsonRpcEnvelope {
  const dataLines = body.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(Boolean);
  const candidates = dataLines.length ? dataLines : [body.trim()];
  let lastError: unknown;
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) as JsonRpcEnvelope; } catch (err) { lastError = err; }
  }
  throw new Error(`Invalid Eureka MCP response: ${lastError ? errorMessage(lastError) : 'empty body'}`);
}

function toolErrorText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map(item => item && typeof item === 'object' && 'text' in item ? String((item as { text?: unknown }).text || '') : '')
    .filter(Boolean)
    .join('\n') || 'Eureka MCP tool call failed';
}

function toolPayload<T>(result: Record<string, unknown>): T {
  if (result.isError) throw new Error(toolErrorText(result));
  const structured = result.structuredContent ?? result.structured_content;
  if (structured && typeof structured === 'object') return structured as T;
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (!item || typeof item !== 'object' || !('text' in item)) continue;
    const text = String((item as { text?: unknown }).text || '');
    try { return JSON.parse(text) as T; } catch { /* try next */ }
  }
  return {} as T;
}

export class EurekaMcpClient {
  private sessionId?: string;
  private requestId = 0;
  private serverVersion = '';

  constructor(
    private endpoint = DEFAULT_EUREKA_MCP_URL,
    private callerSessionId?: string,
    private fetchImpl: FetchLike = fetch,
    private requestTimeoutMs = 15_000,
  ) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Eureka MCP URL must use http or https');
  }

  get version(): string {
    return this.serverVersion;
  }

  private headers(includeSession = true): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    if (includeSession && this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.callerSessionId) headers['x-eureka-caller-session-id'] = this.callerSessionId;
    return headers;
  }

  private async post(envelope: Record<string, unknown>, includeSession = true, rateAttempt = 0): Promise<{ response: Response; rpc: JsonRpcEnvelope }> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.headers(includeSession),
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      throw new Error(`Cannot reach Eureka desktop MCP at ${this.endpoint}: ${errorMessage(err)}`);
    }
    const body = await response.text();
    if (response.status === 429 && rateAttempt < 6) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const headerDelay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 0;
      const delayMs = Math.max(headerDelay, Math.min(500 * 2 ** rateAttempt, 8_000));
      console.warn(`[eureka-provider] MCP rate limited; retrying in ${delayMs}ms (attempt ${rateAttempt + 1}/6)`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return this.post(envelope, includeSession, rateAttempt + 1);
    }
    if (!response.ok) throw new Error(`Eureka MCP HTTP ${response.status}: ${body.slice(0, 500)}`);
    const rpc = parseEventStream(body);
    if (rpc.error) throw new Error(`Eureka MCP ${rpc.error.code ?? 'error'}: ${rpc.error.message || JSON.stringify(rpc.error.data)}`);
    return { response, rpc };
  }

  async initialize(force = false): Promise<void> {
    if (this.sessionId && !force) return;
    this.sessionId = undefined;
    const id = ++this.requestId;
    const { response, rpc } = await this.post({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'feishu-bridge', version: '0.1.0' },
      },
    }, false);
    const sessionId = response.headers.get('mcp-session-id');
    if (!sessionId) throw new Error('Eureka MCP initialize response did not include mcp-session-id');
    this.sessionId = sessionId;
    const info = rpc.result?.serverInfo as Record<string, unknown> | undefined;
    this.serverVersion = String(info?.version || 'unknown');
  }

  async callTool<T>(name: string, args: Record<string, unknown>, retry = true): Promise<T> {
    await this.initialize();
    const id = ++this.requestId;
    try {
      const { rpc } = await this.post({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      return toolPayload<T>((rpc.result || {}) as Record<string, unknown>);
    } catch (err) {
      const message = errorMessage(err);
      const sessionFailure = /session|404|400|not initialized/i.test(message);
      if (retry && sessionFailure) {
        await this.initialize(true);
        return this.callTool<T>(name, args, false);
      }
      throw err;
    }
  }
}

function taskName(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.slice(0, 60) || 'Feishu Eureka task';
}

export function mapEurekaPermissionMode(permissionMode: string | undefined, autoApprove = false): EurekaPermissionMode {
  if (permissionMode === 'plan') return 'safe';
  if (permissionMode === 'default') return 'ask';
  return autoApprove ? 'allow-all' : 'ask';
}

export function buildEurekaAttachments(files?: FileAttachment[]): Array<Record<string, unknown>> | undefined {
  if (!files?.length) return undefined;
  return files.map(file => ({
    name: file.name,
    mime_type: file.type,
    data_base64: file.data,
  }));
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

function terminalFailure(status: string): boolean {
  return ['failed', 'error', 'cancelled', 'canceled', 'interrupted'].includes(status);
}

export class EurekaProvider {
  private client: EurekaMcpClient;
  private pollIntervalMs: number;
  private turnTimeoutMs: number;

  constructor(
    private pendingPermissions: PendingPermissions,
    private config: EurekaProviderConfig = {},
    client?: EurekaMcpClient,
  ) {
    this.client = client || new EurekaMcpClient(
      config.endpoint || DEFAULT_EUREKA_MCP_URL,
      config.callerSessionId,
      fetch,
      config.requestTimeoutMs,
    );
    this.pollIntervalMs = config.pollIntervalMs ?? 1_500;
    this.turnTimeoutMs = config.turnTimeoutMs ?? 30 * 60 * 1000;
  }

  async preflight(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const result = await this.client.callTool<{ engines?: Array<{ available?: boolean }> }>('list_engines', {});
      if (!Array.isArray(result.engines) || !result.engines.some(engine => engine.available !== false)) {
        return { ok: false, error: 'Eureka desktop reported no available agent engines' };
      }
      return { ok: true, version: `Eureka MCP ${this.client.version}` };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  private async interruptTask(taskId: string, reason: string): Promise<void> {
    try {
      await this.client.callTool('interrupt_agent', { agent_id: taskId });
    } catch (err) {
      console.warn(`[eureka-provider] Failed to interrupt ${taskId} after ${reason}: ${errorMessage(err)}`);
    }
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream<string>({
      start: controller => {
        void this.runTurn(params, controller).catch(err => {
          controller.enqueue(sseEvent('error', errorMessage(err)));
          controller.close();
        });
      },
    });
  }

  private async runTurn(params: StreamChatParams, controller: ReadableStreamDefaultController<string>): Promise<void> {
    const emit = (type: string, data: unknown) => controller.enqueue(sseEvent(type, data));
    const signal = params.abortController?.signal;
    const permissionMode = mapEurekaPermissionMode(params.permissionMode, this.config.autoApprove);
    let taskId = params.forkSession ? undefined : params.sdkSessionId;

    if (taskId) {
      let found: { task?: { id?: string; status?: string } } = {};
      try {
        found = await this.client.callTool<{ task?: { id?: string; status?: string } }>('get_task', { task_id: taskId });
      } catch (err) {
        const message = errorMessage(err);
        if (!/not found|does not exist|no (?:such )?task|unknown task/i.test(message)) throw err;
      }
      if (!found.task?.id || found.task.status === 'archived') {
        emit('retry_notice', {
          reason: !found.task?.id ? 'saved Eureka task no longer exists' : 'saved Eureka task is archived',
          attempt: 1,
          total: 1,
          originalError: `Cannot resume Eureka task ${taskId}`,
        });
        taskId = undefined;
      }
    }
    if (!taskId) {
      const created = await this.client.callTool<{ task?: { id?: string; model?: string } }>('create_task', {
        name: taskName(params.prompt),
        ...(params.workingDirectory ? { working_dir: params.workingDirectory } : {}),
        ...(this.config.agentEngine ? { agent_engine: this.config.agentEngine } : {}),
        ...(params.model ? { model: params.model } : {}),
        permission_mode: permissionMode,
        ...(this.config.thinkingLevel ? { thinking_level: this.config.thinkingLevel } : {}),
        ...(this.config.enabledSourceSlugs?.length ? { enabled_source_slugs: this.config.enabledSourceSlugs } : {}),
        tag: 'feishu-bridge',
      });
      taskId = created.task?.id;
      if (!taskId) throw new Error('Eureka create_task succeeded without returning a task ID');
      emit('status', { session_id: taskId, model: created.task?.model || params.model || 'eureka-default' });
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const sent = await this.client.callTool<{ turn_id?: string }>('send_message', {
      agent_id: taskId,
      text: params.prompt,
      ...(buildEurekaAttachments(params.files) ? { attachments: buildEurekaAttachments(params.files) } : {}),
      permission_mode: permissionMode,
      ...(this.config.agentEngine ? { agent_engine: this.config.agentEngine } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(this.config.thinkingLevel ? { thinking_level: this.config.thinkingLevel } : {}),
      ...(this.config.enabledSourceSlugs?.length ? { enabled_source_slugs: this.config.enabledSourceSlugs } : {}),
    });
    if (!sent.turn_id) throw new Error('Eureka send_message succeeded without returning a turn ID');
    emit('status', { session_id: taskId, model: params.model || 'eureka-default' });

    let cursor = sent.turn_id;
    let sawRunning = false;
    let emittedAssistant = false;
    let terminalPolls = 0;
    let consecutivePollFailures = 0;
    const seenPermissions = new Set<string>();
    const startedAt = Date.now();
    const waitForPoll = async (): Promise<void> => {
      try {
        await sleepWithAbort(this.pollIntervalMs, signal);
      } catch (err) {
        if (signal?.aborted) await this.interruptTask(taskId, 'abort during poll wait');
        throw err;
      }
    };

    while (true) {
      if (Date.now() - startedAt > this.turnTimeoutMs) {
        await this.interruptTask(taskId, 'turn timeout');
        throw new Error(`Eureka task timed out after ${Math.round(this.turnTimeoutMs / 1000)} seconds`);
      }
      if (signal?.aborted) {
        await this.interruptTask(taskId, 'user abort');
        throw new DOMException('Task stopped by user', 'AbortError');
      }

      let status: EurekaAgentStatus;
      try {
        status = await this.client.callTool<EurekaAgentStatus>('get_agent_status', {
          agent_id: taskId,
          since_turn_id: cursor,
        });
        consecutivePollFailures = 0;
      } catch (err) {
        consecutivePollFailures++;
        if (consecutivePollFailures >= 3) throw new Error(`Eureka status polling failed 3 times: ${errorMessage(err)}`);
        await waitForPoll();
        continue;
      }

      const turns = Array.isArray(status.turns) ? status.turns : [];
      for (const turn of turns) {
        if (turn.id) cursor = turn.id;
        if (turn.role === 'assistant' && turn.text) {
          if (turn.isIntermediate) emit('text_preview', turn.text);
          else {
            emit('text', turn.text);
            emittedAssistant = true;
          }
        } else if (turn.role === 'tool') {
          const id = turn.toolUseId || turn.id || `eureka-tool-${Date.now()}`;
          emit('tool_use', { id, name: turn.toolName || 'Eureka tool', input: normalizeObject(turn.toolInput) });
          emit('tool_result', {
            tool_use_id: id,
            content: typeof turn.toolResult === 'string' ? turn.toolResult.slice(0, 4000) : JSON.stringify(turn.toolResult ?? '').slice(0, 4000),
            is_error: Boolean(turn.isError),
          });
        }
      }

      for (const pending of status.pending_permissions || []) {
        const requestId = pending.request_id || pending.id;
        if (!requestId || seenPermissions.has(requestId)) continue;
        seenPermissions.add(requestId);
        emit('permission_request', {
          permissionRequestId: requestId,
          toolName: pending.tool_name || pending.toolName || 'Eureka tool',
          toolInput: normalizeObject(pending.tool_input ?? pending.toolInput ?? pending.input ?? pending.arguments),
          suggestions: pending.suggestions || [],
        });
        const abortPermission = () => this.pendingPermissions.resolve(requestId, { behavior: 'deny', message: 'Task stopped by user' });
        signal?.addEventListener('abort', abortPermission, { once: true });
        const decision = await this.pendingPermissions.waitFor(requestId);
        signal?.removeEventListener('abort', abortPermission);
        await this.client.callTool('respond_permission', {
          request_id: requestId,
          decision: decision.behavior === 'deny' ? 'deny' : decision.allowAlways ? 'allow_always' : 'allow',
        });
      }

      const state = String(status.status || 'unknown').toLowerCase();
      if (state === 'running') {
        sawRunning = true;
        terminalPolls = 0;
      } else {
        terminalPolls++;
        if (terminalFailure(state)) throw new Error(status.error || `Eureka task ended with status ${state}`);
        if ((sawRunning || Date.now() - startedAt > 5_000) && terminalPolls >= 2) break;
      }
      await waitForPoll();
    }

    if (!emittedAssistant) {
      const conversation = await this.client.callTool<{ turns?: EurekaTurn[] }>('get_conversation', { agent_id: taskId, limit: 20 });
      const fallback = [...(conversation.turns || [])].reverse().find(turn => turn.role === 'assistant' && turn.text && !turn.isIntermediate);
      if (fallback?.text) {
        emit('text', fallback.text);
        emittedAssistant = true;
      }
    }
    if (!emittedAssistant) throw new Error('Eureka task finished without an assistant response');
    emit('result', { session_id: taskId, is_error: false });
    controller.close();
  }
}
