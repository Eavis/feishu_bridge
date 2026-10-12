/**
 * Bridge — message orchestrator for the Feishu-Claude bridge.
 *
 * Consumes inbound messages from FeishuClient, routes slash commands,
 * handles numeric permission shortcuts, and dispatches to the conversation engine.
 * Uses per-session locks for concurrency control.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type {
  AppContext,
  InboundMessage,
  ChannelBinding,
  CliSessionInfo,
  ActivitySessionInfo,
  ToolCallInfo,
} from './types.js';
import * as conversation from './conversation.js';
import { deliver } from './delivery.js';
import {
  forwardPermissionRequest,
  handlePermissionCallback,
} from './permissions.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './validators.js';
import { formatRelativeTime } from './session-scanner.js';
import { htmlToFeishuMarkdown } from './feishu-markdown.js';
import { CARD_TEXT_BYTE_BUDGET } from './feishu.js';
import { isAgentKind } from './provider-factory.js';
import { DEFAULT_CODEX_MODEL } from './codex-provider.js';
import { armAbortedTaskWatchdog } from './task-health.js';
import { readWithStreamDeadline, StreamDeadlinePolicy } from './stream-health.js';

// ── /list cache (per-chat, 5 min TTL) ───────────────────────

interface ListCacheEntry {
  sessions: CliSessionInfo[];
  cachedAt: number;
}

const LIST_CACHE_TTL = 5 * 60 * 1000;
const listCache = new Map<string, ListCacheEntry>();
const activityCache = new Map<string, { sessions: ActivitySessionInfo[]; cachedAt: number }>();

function clipInline(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').replace(/`/g, "'").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function activityStatusIcon(status: ActivitySessionInfo['status']): string {
  return status === 'running' ? '🟢' : status === 'waiting' ? '🟡' : status === 'completed' ? '⚪' : '❔';
}

function formatActivityList(sessions: ActivitySessionInfo[]): string {
  const lines = [`**本机任务 (${sessions.length})**`, ''];
  sessions.forEach((session, index) => {
    const source = session.source === 'eureka' ? 'Eureka' : 'Codex';
    lines.push(`${index + 1}. ${activityStatusIcon(session.status)} \[${source}] **${clipInline(session.name, 48)}** · ${formatRelativeTime(session.updatedAt)}`);
    lines.push(`   要求：${clipInline(session.digest.requested, 92)}`);
    lines.push(`   ${session.status === 'running' ? '进展' : '结果'}：${clipInline(session.digest.accomplished, 110)}`);
    if (session.deepLink) lines.push(`   [打开原对话](${session.deepLink})`);
  });
  lines.push('', '发送 `/summary <编号>` 查看“要求 / 后续修改 / 做到什么”的完整摘要。');
  return lines.join('\n');
}

function formatActivitySummary(session: ActivitySessionInfo): string {
  const lines = [
    `${activityStatusIcon(session.status)} **${session.name}**`,
    '',
    `- 来源：${session.source === 'eureka' ? 'Eureka' : 'Codex CLI'}`,
    `- 状态：${session.status}`,
    `- 更新时间：${new Date(session.updatedAt).toLocaleString('zh-CN')}`,
    session.engine ? `- 引擎：${session.engine}${session.model ? ` / ${session.model}` : ''}` : '',
    session.cwd ? `- 目录：\`${session.cwd}\`` : '',
    '',
    '**你最初要求**',
    clipInline(session.digest.requested, 600),
  ].filter(Boolean);
  if (session.digest.latestRequest) {
    lines.push('', '**你后续要求修改/补充**', clipInline(session.digest.latestRequest, 600));
  }
  lines.push('', session.status === 'running' ? '**当前进展**' : '**它做到了什么**', clipInline(session.digest.accomplished, 900));
  if (session.deepLink) lines.push('', `[直接打开原对话](${session.deepLink})`);
  if (session.source === 'codex' && session.sdkSessionId) {
    lines.push('', `继续该 Codex 会话：\`/resume ${session.sdkSessionId}\``);
  }
  return lines.join('\n');
}

/**
 * Extract a short hint from a tool call's input to show next to the tool name
 * on the streaming card. Each well-known tool has a different "informative" field.
 * Returns at most ~60 chars; null when no useful hint can be derived.
 */
function extractToolHint(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };

  let raw: string | undefined;
  switch (toolName) {
    case 'Bash':
    case 'BashOutput':
      raw = pick('description', 'command');
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      raw = pick('file_path', 'notebook_path');
      break;
    case 'Glob':
      raw = pick('pattern');
      break;
    case 'Grep':
      raw = pick('pattern');
      break;
    case 'WebFetch':
    case 'WebSearch':
      raw = pick('url', 'query');
      break;
    case 'TaskCreate':
    case 'TaskUpdate':
      raw = pick('subject', 'description');
      break;
    case 'Agent':
      raw = pick('description');
      break;
    case 'Skill':
      raw = pick('skill');
      break;
    default:
      // Generic fallback: try common informative fields.
      raw = pick('description', 'path', 'file_path', 'query', 'pattern', 'name', 'subject', 'url');
  }

  if (!raw) return undefined;
  // Collapse whitespace and clip.
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? oneLine.slice(0, 57) + '...' : oneLine;
}

/**
 * Format a scheduled-task line for /cron list. Shows id, cron, target chat
 * abbreviated, and human-readable next-fire time.
 */
function formatScheduledTask(t: import('./scheduler.js').ScheduledTask, currentChatId?: string): string {
  const status = t.enabled ? '🟢' : '⏸';
  const nextStr = t.nextFireAt ? new Date(t.nextFireAt).toLocaleString('sv-SE') : '—';
  const chatTag = t.chatId === currentChatId ? '此聊天' : `\`${t.chatId.slice(0, 12)}…\``;
  const promptPreview = t.prompt.length > 40 ? t.prompt.slice(0, 40) + '…' : t.prompt;
  return `${status} \`${t.id}\` · \`${t.cron}\` → ${chatTag} · 下次: ${nextStr}\n   ${promptPreview}`;
}

function handleCronCommand(ctx: AppContext, currentChatId: string, rawArgs: string): string {
  const sched = ctx.scheduler!;
  const argsTrim = (rawArgs || '').trim();
  if (!argsTrim) {
    return [
      '**/cron — 定时任务管理**',
      '',
      '**用法:**',
      '`/cron add "<cron>" <prompt>` — 在当前 chat 添加定时任务',
      '`/cron add "<cron>" --to <chatId> <prompt>` — 指定目标 chat',
      '`/cron list` — 列出所有任务',
      '`/cron del <id>` — 删除任务',
      '`/cron pause <id>` / `/cron resume <id>` — 暂停 / 恢复',
      '',
      '**Cron 5 段示例:**',
      '`*/5 * * * *` — 每 5 分钟',
      '`0 9 * * 1-5` — 工作日早 9 点',
      '`30 14 * * *` — 每天 14:30',
      '',
      '触发后 = 在目标 chat 里像你发了那条 prompt 一样跑 Claude（fork 模式不污染原 session）',
    ].join('\n');
  }

  const sub = argsTrim.split(/\s+/)[0];
  const rest = argsTrim.slice(sub.length).trim();

  switch (sub) {
    case 'list': {
      const tasks = sched.list();
      if (tasks.length === 0) return '无任务。用 `/cron add "<cron>" <prompt>` 添加。';
      return [`**定时任务 (${tasks.length})**`, '', ...tasks.map((t) => formatScheduledTask(t, currentChatId))].join('\n');
    }

    case 'del':
    case 'delete':
    case 'rm': {
      if (!rest) return 'Usage: /cron del <id>';
      const ok = sched.delete(rest);
      return ok ? `已删除 \`${rest}\`` : `未找到任务 \`${rest}\``;
    }

    case 'pause':
    case 'resume': {
      if (!rest) return `Usage: /cron ${sub} <id>`;
      const ok = sched.setEnabled(rest, sub === 'resume');
      return ok ? `${sub === 'resume' ? '已恢复' : '已暂停'} \`${rest}\`` : `未找到任务 \`${rest}\``;
    }

    case 'add': {
      // Parse: "<cron expr in quotes>" [--to <chatId>] <prompt rest>
      // Cron must be in double quotes because it has spaces.
      const m = rest.match(/^"([^"]+)"\s*([\s\S]*)$/);
      if (!m) return 'Usage: /cron add "<cron expr>" [--to <chatId>] <prompt>\n例: /cron add "0 9 * * 1-5" 跑下今日股票播报';
      const cronExpr = m[1].trim();
      let tail = m[2].trim();
      let targetChatId = currentChatId;
      const toMatch = tail.match(/^--to\s+(\S+)\s+([\s\S]+)$/);
      if (toMatch) {
        targetChatId = toMatch[1];
        tail = toMatch[2];
      }
      if (!tail) return 'Prompt 不能为空。';
      const result = sched.add({ cron: cronExpr, prompt: tail, chatId: targetChatId });
      if (!result.ok || !result.task) return `添加失败: ${result.error || 'unknown'}`;
      const t = result.task;
      return [
        `✅ 已添加任务 \`${t.id}\``,
        `- cron: \`${t.cron}\``,
        `- 目标 chat: ${targetChatId === currentChatId ? '此聊天' : `\`${targetChatId}\``}`,
        `- 下次触发: ${t.nextFireAt ? new Date(t.nextFireAt).toLocaleString('sv-SE') : '—'}`,
        `- prompt: ${t.prompt.length > 80 ? t.prompt.slice(0, 80) + '…' : t.prompt}`,
      ].join('\n');
    }

    default:
      return `未知子命令: ${sub}\n发送 \`/cron\` 查看帮助。`;
  }
}

function getCachedList(chatId: string): CliSessionInfo[] | null {
  const entry = listCache.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > LIST_CACHE_TTL) {
    listCache.delete(chatId);
    return null;
  }
  return entry.sessions;
}

// ── Session locks ────────────────────────────────────────────

const sessionLocks = new Map<string, Promise<void>>();

function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const prev = sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  sessionLocks.set(sessionId, current);
  current.finally(() => {
    if (sessionLocks.get(sessionId) === current) {
      sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

// ── Active tasks ─────────────────────────────────────────────

const activeTasks = new Map<string, AbortController>();
const commandQueues = new Map<string, Promise<void>>();
const activeCommands = new Map<symbol, number>();
let pendingMessages = 0;
const COMMAND_STALL_MS = 5 * 60_000;

export function getCommandHealth(now = Date.now()): {
  active: number; pendingMessages: number; oldestActiveMs: number; stalled: boolean;
} {
  let oldestActiveMs = 0;
  for (const startedAt of activeCommands.values()) {
    oldestActiveMs = Math.max(oldestActiveMs, now - startedAt);
  }
  return { active: activeCommands.size, pendingMessages, oldestActiveMs, stalled: oldestActiveMs >= COMMAND_STALL_MS };
}

/** Used by daemon-level maintenance to avoid recycling during a live turn. */
export function hasActiveTasks(): boolean {
  return activeTasks.size > 0 || pendingMessages > 0;
}

export function getActiveTaskCount(): number {
  return activeTasks.size;
}

function abortActiveTask(sessionId: string): boolean {
  const controller = activeTasks.get(sessionId);
  if (!controller) return false;
  controller.abort();
  // Do not remove the active marker here. handleMessage owns it and clears it
  // in finally. Removing it early hides runtimes that ignored AbortSignal and
  // leaves processWithSessionLock permanently blocked.
  armAbortedTaskWatchdog(
    controller,
    () => activeTasks.get(sessionId) === controller,
    () => {
      console.error(`[watchdog] Aborted task ${sessionId} did not exit within 15s; restarting to release its session lock`);
      process.exit(1);
    },
  );
  return true;
}

// ── Numeric permission shortcut check ────────────────────────

function isNumericPermissionShortcut(ctx: AppContext, rawText: string, chatId: string): boolean {
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const pending = ctx.store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0;
}

// ── Resolve binding ──────────────────────────────────────────

function resolveBinding(ctx: AppContext, chatId: string): ChannelBinding {
  const existing = ctx.store.getChannelBinding(chatId);
  if (existing) {
    const session = ctx.store.getSession(existing.codepilotSessionId);
    if (session) return existing;
  }
  return createNewBinding(ctx, chatId);
}

function createNewBinding(ctx: AppContext, chatId: string, workDir?: string): ChannelBinding {
  const cwd = workDir || ctx.config.defaultWorkDir || process.env.HOME || '';
  const model = ctx.config.defaultModel || '';
  const session = ctx.store.createSession(`Bridge: ${chatId}`, model, undefined, cwd);
  const binding = ctx.store.upsertChannelBinding({
    chatId,
    codepilotSessionId: session.id,
    workingDirectory: cwd,
    model,
  });
  // upsertChannelBinding's update path preserves sdkSessionId + agentSessions
  // from the existing binding, which is wrong for /new — the user expects a
  // truly fresh start with no stale per-backend resume IDs hanging around.
  // Wipe them explicitly. Also reset to config.defaultAgent so /new on a chat
  // that drifted to a different backend gives the user the configured default.
  ctx.store.updateChannelBinding(binding.id, {
    sdkSessionId: '',
    agentSessions: {},
    agentModels: {},
    agent: ctx.config.defaultAgent,
  });
  return { ...binding, sdkSessionId: '', agentSessions: {}, agentModels: {}, agent: ctx.config.defaultAgent };
}

// ── SDK Session Update Logic ─────────────────────────────────

function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
  userAborted: boolean,
): string | null {
  if (sdkSessionId && !hasError) return sdkSessionId;
  // User-initiated abort (/stop, stop button): never touch the binding's
  // sdkSessionId. The conversation up to the abort point is still valid
  // and resumable; if abort happened so fast that no new session id was
  // captured this turn, the binding's previous sdkSessionId must survive.
  if (userAborted) return sdkSessionId || null;
  if (hasError) return '';
  return null;
}

export function shouldRetryCodexFresh(input: {
  agent: string;
  sdkSessionId?: string;
  hasError: boolean;
  responseText: string;
  toolCount: number;
  aborted: boolean;
}): boolean {
  return input.agent === 'codex'
    && Boolean(input.sdkSessionId)
    && input.hasError
    && !input.responseText
    && input.toolCount === 0
    && !input.aborted;
}

// ── CLI Session Helpers ──────────────────────────────────────

function findCliSession(ctx: AppContext, query: string): CliSessionInfo | null {
  const sessions = ctx.store.listCliSessions({ limit: 50 });
  const q = query.toLowerCase();
  const byId = sessions.find(s => s.sdkSessionId.toLowerCase().startsWith(q));
  if (byId) return byId;
  const bySlug = sessions.find(s => s.slug.toLowerCase() === q);
  return bySlug || null;
}

/**
 * Fork the current chat into a new session that INHERITS its context.
 *
 * Copilot CLI has no native session-fork, so we seed a brand-new session with a
 * compact transcript of the original conversation (built from the store), then
 * ask it for a group NAME + SUMMARY in the same turn. The original session is
 * never resumed, so it stays untouched. Returns the new session id (which now
 * carries the transcript) plus the parsed name and summary.
 */
/**
 * Build a compact, readable transcript of a session's stored messages to seed a
 * forked chat. Extracts user prompts and assistant *text* (dropping bulky
 * tool_use / tool_result blocks), strips internal markers, and keeps the most
 * recent ~9000 chars so the fork inherits the conversation's gist.
 */
function buildForkSeed(ctx: AppContext, sessionId: string): string {
  const { messages } = ctx.store.getMessages(sessionId);
  const parts: string[] = [];
  for (const m of messages) {
    let text = (m.content || '').trim();
    if (text.startsWith('[')) {
      // Assistant messages with tool use are stored as JSON content-blocks;
      // keep only the text blocks (the narration/conclusions).
      try {
        const blocks = JSON.parse(text) as Array<{ type?: string; text?: string }>;
        text = blocks
          .filter((b) => b && b.type === 'text' && b.text)
          .map((b) => b.text as string)
          .join('\n')
          .trim();
      } catch { /* not JSON — keep raw */ }
    }
    text = text
      .replace(/<!--files:[\s\S]*?-->/g, '')
      .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, '')
      .trim();
    if (!text) continue;
    parts.push(`${m.role === 'user' ? '用户' : '助手'}：${text}`);
  }
  let transcript = parts.join('\n\n');
  const CAP = 9000;
  if (transcript.length > CAP) {
    transcript = '（更早的内容已省略）\n\n' + transcript.slice(-CAP);
  }
  return transcript;
}

/**
 * Resolve the directory where Copilot CLI stores per-session state.
 * Override with CTI_COPILOT_SESSION_DIR if Copilot's home differs.
 */
function copilotSessionDir(): string {
  return process.env.CTI_COPILOT_SESSION_DIR
    || path.join(os.homedir(), '.copilot', 'session-state');
}

/**
 * True file-level fork of a Copilot session: copy
 * ~/.copilot/session-state/<src>/ to a fresh <newId>/ and rewrite the embedded
 * session id inside events.jsonl and workspace.yaml. `copilot --resume=<newId>`
 * then loads the full cloned transcript (lossless — every message, tool call and
 * working-state file). The source directory is never modified. Returns the new
 * id, or null if the source dir isn't found (caller falls back to seeding).
 */
function cloneCopilotSession(sourceId: string): string | null {
  try {
    const base = copilotSessionDir();
    const src = path.join(base, sourceId);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return null;
    const newId = crypto.randomUUID();
    const dst = path.join(base, newId);
    fs.cpSync(src, dst, { recursive: true });
    for (const fn of ['events.jsonl', 'workspace.yaml']) {
      const p = path.join(dst, fn);
      if (fs.existsSync(p)) {
        const rewritten = fs.readFileSync(p, 'utf-8').split(sourceId).join(newId);
        fs.writeFileSync(p, rewritten, 'utf-8');
      }
    }
    return newId;
  } catch (err) {
    console.warn('[fork] clone failed, falling back to transcript-seed:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function summarizeAndForkSession(
  ctx: AppContext,
  binding: ChannelBinding,
): Promise<{ ok: boolean; forkedSdkSessionId?: string; name?: string; summary?: string; error?: string }> {
  if (!binding.sdkSessionId) {
    return { ok: false, error: 'Current chat has no SDK session yet — talk to the bot at least once first.' };
  }

  const session = ctx.store.getSession(binding.codepilotSessionId);
  const promptText =
    '请基于到目前为止的全部对话上下文输出两部分内容，严格按以下格式（不要使用 Markdown 代码块）：\n\n' +
    'NAME: <一个约 10 个字、不���标点的群名，提炼当前对话主题；可适当多一两个字以保持完整>\n' +
    'SUMMARY:\n<一段不超过 200 字的对话摘要，第三人称，提到主要议题、结论或当前进展，作为发到新群的开场白>';

  // Preferred path — TRUE file-level fork: clone the Copilot session directory
  // to a new id. Lossless (full event tree + tool calls + working state) and the
  // source session is never touched. We then resume the CLONE to produce the
  // group name + summary, so the returned session_id is the clone itself.
  // Fallback — if the on-disk session can't be cloned, seed a compact transcript
  // into a fresh session via the prompt.
  const clonedId = cloneCopilotSession(binding.sdkSessionId);

  let prompt: string;
  let resumeId: string | undefined;
  if (clonedId) {
    prompt = promptText; // the clone already holds the full context
    resumeId = clonedId;
  } else {
    const seed = buildForkSeed(ctx, binding.codepilotSessionId);
    if (!seed.trim()) {
      return { ok: false, error: '原会话暂无可继承的历史内容，无法 fork。' };
    }
    prompt =
      '以下是此前一段对话的完整记录。请在这个新会话里把它作为你已经掌握的上下文记住，' +
      '后续我会接着这个话题继续提问。\n\n' +
      '=== 对话记录开始 ===\n' + seed + '\n=== 对话记录结束 ===\n\n' +
      promptText;
  }

  const abortController = new AbortController();
  const stream = (() => {
    try {
      const provider = ctx.providerFactory(binding.agent ?? ctx.config.defaultAgent);
      return provider.streamChat({
        prompt,
        sessionId: binding.codepilotSessionId,
        // Clone path: resume the freshly-cloned session (context-aware summary, and
        // result.session_id == the clone). Fallback path: no resume (fresh session
        // seeded via the prompt above).
        sdkSessionId: resumeId,
        model: binding.model || session?.model || ctx.config.defaultModel,
        workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
        permissionMode: 'default',
        abortController,
      });
    } catch (err) {
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

  let text = '';
  let forkedSdkSessionId: string | undefined;
  let hasError = false;
  let errorMessage = '';

  const reader = stream.getReader();
  const deadline = new StreamDeadlinePolicy(Date.now(), 120_000, 120_000, 240_000);
  try {
    while (true) {
      const { done, value } = await readWithStreamDeadline(reader, deadline);
      if (done) break;
      for (const line of value.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let evt: { type: string; data: string };
        try { evt = JSON.parse(line.slice(6)); } catch { continue; }
        if (evt.type === 'text') {
          text += evt.data;
        } else if (evt.type === 'status' || evt.type === 'result') {
          try {
            const d = JSON.parse(evt.data);
            if (d.session_id) forkedSdkSessionId = d.session_id;
          } catch { /* ignore */ }
        } else if (evt.type === 'error') {
          hasError = true;
          errorMessage = evt.data || 'unknown';
        }
      }
    }
  } catch (e) {
    abortController.abort();
    void reader.cancel().catch(() => {});
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    reader.releaseLock();
  }

  if (hasError) return { ok: false, error: errorMessage };
  if (!forkedSdkSessionId) {
    return { ok: false, error: 'Fork 未返回 session_id（新会话可能启动失败，请重试）。' };
  }

  // Parse "NAME: ..." and "SUMMARY: ..." out of Claude's response.
  const nameMatch = text.match(/NAME\s*[:：]\s*(.+)/i);
  const summaryMatch = text.match(/SUMMARY\s*[:：]\s*([\s\S]+?)$/i);
  let name = (nameMatch?.[1] || '').trim()
    .replace(/[、，。"'`*_]/g, '')   // 去标点（不再删空白；中文之间罕有空白，但英文有）
    .replace(/\s+/g, ' ')
    .trim();
  // 仅在 Claude 严重不听话时兜底（>20 字才截断，保留语义完整）
  if (name.length > 20) name = name.slice(0, 20);
  let summary = (summaryMatch?.[1] || '').trim();
  if (!name) name = '新对话';
  if (!summary) summary = text.trim() || '（无法生成摘要）';

  return { ok: true, forkedSdkSessionId, name, summary };
}

function resumeCliSession(ctx: AppContext, chatId: string, target: CliSessionInfo): string {
  const backend = target.backend ?? 'claude';
  const existing = ctx.store.getChannelBinding(chatId);
  const model = existing?.agentModels?.[backend]
    ?? (backend === 'codex' ? DEFAULT_CODEX_MODEL : ctx.config.defaultModel || '');
  const session = ctx.store.createSession(
    `Resume: ${target.slug || target.sdkSessionId.slice(0, 8)}`,
    model,
    undefined,
    target.cwd,
  );

  const binding = ctx.store.upsertChannelBinding({
    chatId,
    codepilotSessionId: session.id,
    workingDirectory: target.cwd,
    model,
  });

  // Park the OTHER backend's active session (if any) under agentSessions so a
  // future /agent switch can return to it. Then set agent + sdkSessionId for
  // the resumed backend.
  const previousAgent = existing?.agent ?? binding.agent ?? ctx.config.defaultAgent;
  const parked: Partial<Record<typeof backend, string>> = { ...(binding.agentSessions ?? {}) };
  const parkedModels = { ...(binding.agentModels ?? {}) };
  if (previousAgent !== backend && binding.sdkSessionId) {
    (parked as Record<string, string>)[previousAgent] = binding.sdkSessionId;
  }
  if (previousAgent !== backend && existing?.model) {
    (parkedModels as Record<string, string>)[previousAgent] = existing.model;
  }
  // The resumed session always wins for the chosen backend — overwrite any
  // older parked id for that same backend.
  delete (parked as Record<string, unknown>)[backend];
  ctx.store.updateChannelBinding(binding.id, {
    sdkSessionId: target.sdkSessionId,
    agent: backend,
    agentSessions: parked,
    agentModels: parkedModels,
    model,
  });

  const icon = target.isOpen ? '🟢' : '⚪';
  const prompt = target.firstPrompt.length > 40 ? target.firstPrompt.slice(0, 40) + '...' : target.firstPrompt;
  const cliCmd = backend === 'copilot'
    ? `copilot --resume ${target.sdkSessionId}`
    : backend === 'codex'
      ? `codex exec resume ${target.sdkSessionId}`
      : `claude --resume ${target.sdkSessionId}`;
  return [
    `${icon} 已恢复 ${backend} CLI 会话`,
    '',
    `Project: \`${target.project}\``,
    `CWD: \`${target.cwd}\``,
    target.slug ? `Slug: \`${target.slug}\`` : '',
    `"${prompt}"`,
    '',
    `终端恢复: \`${cliCmd}\``,
    '',
    '现在可以直接发消息继续对话。',
  ].filter(Boolean).join('\n');
}

// ── Main loop ────────────────────────────────────────────────

export async function runBridgeLoop(ctx: AppContext): Promise<void> {
  while (ctx.feishu.isRunning()) {
    try {
      const msg = await ctx.feishu.consumeOne();
      if (!msg) continue;

      const text = msg.text.trim();
      const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();
      const urgent = Boolean(msg.callbackData) || command === '/stop' || command === '/perm'
        || isNumericPermissionShortcut(ctx, text, msg.chatId);
      pendingMessages++;

      let work: Promise<void>;
      if (urgent || text.startsWith('/')) {
        const previous = urgent ? Promise.resolve() : commandQueues.get(msg.chatId) || Promise.resolve();
        work = previous.then(async () => {
          const id = Symbol();
          activeCommands.set(id, Date.now());
          try { await handleMessage(ctx, msg); }
          finally { activeCommands.delete(id); }
        });
        if (!urgent) {
          // Keep changes such as /agent then /model in order in this chat,
          // while other chats and stop/permission controls continue receiving.
          const tail = work.catch(() => {});
          commandQueues.set(msg.chatId, tail);
          void tail.then(() => {
            if (commandQueues.get(msg.chatId) === tail) commandQueues.delete(msg.chatId);
          });
        }
      } else {
        // Resolve the binding after prior commands have applied their changes.
        work = (commandQueues.get(msg.chatId) || Promise.resolve()).then(() => {
          const binding = resolveBinding(ctx, msg.chatId);
          return processWithSessionLock(binding.codepilotSessionId, () => handleMessage(ctx, msg));
        });
      }
      void work.catch(err => {
        console.error('[bridge] Message handling failed:', err instanceof Error ? err.message : String(err));
      }).finally(() => { pendingMessages--; });
    } catch (err) {
      console.error('[bridge] Error in loop:', err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ── Message handler ──────────────────────────────────────────

async function handleMessage(ctx: AppContext, msg: InboundMessage): Promise<void> {
  // Handle callback queries (permission buttons + cron confirm)
  if (msg.callbackData) {
    console.log('[bridge] handleMessage callback:', msg.callbackData, 'chatId=', msg.chatId);
    // Cron confirm/cancel buttons (must come before perm so cron-* doesn't match perm:)
    if (msg.callbackData.startsWith('cron-confirm:') || msg.callbackData.startsWith('cron-cancel:')) {
      const [verb, pendingId] = msg.callbackData.split(':');
      console.log('[bridge] cron callback:', verb, pendingId);
      if (!ctx.outbox) {
        await deliver(ctx, msg.chatId, 'Outbox not initialized.');
        return;
      }
      if (verb === 'cron-confirm') {
        const r = ctx.outbox.confirmPendingCron(pendingId);
        console.log('[bridge] confirmPendingCron result:', r.ok, r.error || r.task?.id);
        if (r.ok && r.task) {
          const next = r.task.nextFireAt ? new Date(r.task.nextFireAt).toLocaleString('sv-SE') : '—';
          await deliver(ctx, msg.chatId, `✅ 任务已确认 \`${r.task.id}\`，下次触发: ${next}`);
        } else {
          await deliver(ctx, msg.chatId, `创建失败: ${r.error || 'unknown'}`);
        }
      } else {
        const ok = ctx.outbox.cancelPendingCron(pendingId);
        await deliver(ctx, msg.chatId, ok ? '已取消。' : '该待确认任务已过期或不存在。');
      }
      return;
    }
    // Inline stop button on streaming cards. Silent abort — finalizeCard will
    // run with status='interrupted' and rewrite the card without the button.
    if (msg.callbackData.startsWith('stop:')) {
      const sessionId = msg.callbackData.slice('stop:'.length);
      const controller = activeTasks.get(sessionId);
      if (controller) {
        console.log('[bridge] stop button clicked, aborting session:', sessionId);
        abortActiveTask(sessionId);
      } else {
        console.log('[bridge] stop button clicked but no active task for session:', sessionId);
      }
      return;
    }
    const handled = handlePermissionCallback(ctx, msg.callbackData, msg.chatId, msg.callbackMessageId);
    if (handled) {
      await deliver(ctx, msg.chatId, 'Permission response recorded.');
    }
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  if (!rawText && !hasAttachments) return;

  // Numeric shortcut for permission replies (1/2/3)
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (/^[123]$/.test(normalized)) {
    const pendingLinks = ctx.store.listPendingPermissionLinksByChat(msg.chatId);
    if (pendingLinks.length === 1) {
      const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
      const action = actionMap[normalized];
      const permId = pendingLinks[0].permissionRequestId;
      const callbackData = `perm:${action}:${permId}`;
      const handled = handlePermissionCallback(ctx, callbackData, msg.chatId);
      const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
      if (handled) {
        await deliver(ctx, msg.chatId, `${label}: recorded.`);
      } else {
        await deliver(ctx, msg.chatId, 'Permission not found or already resolved.');
      }
      return;
    }
    if (pendingLinks.length > 1) {
      await deliver(ctx, msg.chatId,
        `Multiple pending permissions (${pendingLinks.length}). Use /perm allow|allow_session|deny <id>`,
      );
      return;
    }
    // No pending → fall through as normal message
  }

  // Slash commands
  if (rawText.startsWith('/')) {
    await handleCommand(ctx, msg, rawText);
    return;
  }

  // Sanitize
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge] Input truncated from ${rawText.length} to ${text.length} chars`);
  }

  if (!text && !hasAttachments) return;

  // Did the user explicitly ask for verbose tool output? Keywords (CN+EN) only
  // expand the final card; streaming progress is always shown live.
  const verboseTools = /\b(verbose|show ops|show tools|details?)\b/i.test(text)
    || /详细|展开|显示操作|看操作|看工具|显示工具/.test(text);

  // Regular message → conversation engine
  const binding = resolveBinding(ctx, msg.chatId);

  // Cron-triggered messages skip the eager card creation. The streaming card
  // is lazy-created when (and only when) Claude emits its first text chunk,
  // so cron tasks that produce no output never pollute the chat with an
  // empty "Completed · 1 ops" card. (See docs/superpowers/specs/2026-06-09-cron-silent-card-design.md.)
  const isCron = msg.userId === '__scheduler__';
  if (!isCron) {
    ctx.feishu.onMessageStart(msg.chatId, binding.codepilotSessionId);
  }

  const taskAbort = new AbortController();
  activeTasks.set(binding.codepilotSessionId, taskAbort);

  // Tool call tracker for streaming card
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onPartialText = (fullText: string) => {
    try { ctx.feishu.onStreamText(msg.chatId, fullText, binding.codepilotSessionId); } catch { /* non-critical */ }
  };

  const onToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error', toolInput?: unknown) => {
    if (toolName) {
      const hint = extractToolHint(toolName, toolInput);
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status, hint });
    } else {
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      ctx.feishu.onToolEvent(msg.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  };

  try {
    // Default prompt when user sent only attachments without text.
    // Generic enough for both images ("describe") and documents ("read+summarize").
    let promptText = text || (hasAttachments ? '请处理我刚上传的附件（图片就描述，文档就读取后总结/分析）。' : '');

    // If user used Feishu's reply/quote UI, prepend the quoted message so
    // Claude can see what's being referenced (Feishu events do NOT inline it).
    if (msg.quotedContent) {
      const quoted = msg.quotedContent
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      const attribution = msg.quotedSenderName ? `${msg.quotedSenderName} 此前说：` : '用户引用的消息：';
      promptText = `${attribution}\n${quoted}\n\n---\n\n${promptText}`;
    }

    const runConversation = (targetBinding: ChannelBinding, skipUserSave = false, forceFresh = false) => conversation.processMessage(
      ctx,
      targetBinding,
      promptText,
      async (perm) => {
        await forwardPermissionRequest(
          ctx,
          msg.chatId,
          perm.permissionRequestId,
          perm.toolName,
          perm.toolInput,
          targetBinding.codepilotSessionId,
          perm.suggestions,
          msg.messageId,
        );
      },
      taskAbort.signal,
      hasAttachments ? msg.attachments : undefined,
      onPartialText,
      onToolEvent,
      msg.chatId,
      msg.messageId,
      msg.userId === '__scheduler__',
      (info) => {
        try { ctx.feishu.onRetryNotice(msg.chatId, info); } catch { /* non-critical */ }
      },
      skipUserSave,
      forceFresh,
    );

    let result = await runConversation(binding);
    const activeAgent = binding.agent ?? ctx.config.defaultAgent;
    const safeToRetryFresh = shouldRetryCodexFresh({
      agent: activeAgent,
      sdkSessionId: binding.sdkSessionId,
      hasError: result.hasError,
      responseText: result.responseText,
      toolCount: toolCallTracker.size,
      aborted: taskAbort.signal.aborted,
    });
    if (safeToRetryFresh) {
      const originalError = result.errorMessage || 'Codex resume failed';
      try {
        ctx.feishu.onRetryNotice(msg.chatId, {
          reason: 'Codex historical resume failed; retrying once with a fresh thread',
          attempt: 1,
          total: 2,
          originalError,
        });
      } catch { /* non-critical */ }
      console.warn(`[bridge] Codex resume failed before output; retrying fresh: ${originalError}`);
      result = await runConversation({ ...binding, sdkSessionId: '' }, true, true);
    }

    // Finalize streaming card
    let cardFinalized = false;
    let deliverFull = false;
    let finalText = result.responseText;
    try {
      const status = result.hasError ? 'error' : 'completed';
      // On error, append the underlying error message to the response text so
      // the user can see the actual failure cause (e.g. Anthropic Usage Policy
      // refusal), not just a red ❌ Error footer with no detail.
      if (result.hasError && result.errorMessage) {
        const sep = finalText.trim() ? '\n\n---\n\n' : '';
        finalText = `${finalText}${sep}**❌ 错误详情**\n\`\`\`\n${result.errorMessage}\n\`\`\``;
      }
      // A response bigger than the Feishu card limit would make card.update fail
      // and leave the card stuck in streaming (Stop button never clears). When
      // too long, finalize the card with a short pointer and deliver the full
      // text as follow-up message(s) below.
      const tooLong = Buffer.byteLength(finalText || '', 'utf8') > CARD_TEXT_BYTE_BUDGET;
      const cardText = tooLong
        ? `📄 内容较长（约 ${finalText.length} 字），完整结果见下方 👇`
        : finalText;
      cardFinalized = await ctx.feishu.onStreamEnd(msg.chatId, status, cardText, result.tokenUsage, { verboseTools });
      deliverFull = tooLong || !cardFinalized;
    } catch (err) {
      console.warn('[bridge] Card finalize failed:', err instanceof Error ? err.message : err);
      deliverFull = true;
    }

    // Deliver the full response when the card couldn't carry it (too long / failed)
    if (finalText) {
      if (deliverFull) {
        await deliver(ctx, msg.chatId, finalText, {
          sessionId: binding.codepilotSessionId,
          parseMode: 'Markdown',
          replyToMessageId: msg.messageId,
        });
      }
    } else if (result.hasError) {
      const errorText = `**Error:** ${result.errorMessage}`;
      await deliver(ctx, msg.chatId, errorText, {
        sessionId: binding.codepilotSessionId,
        parseMode: 'Markdown',
        replyToMessageId: msg.messageId,
      });
    }

    // Persist SDK session ID
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError, taskAbort.signal.aborted);
        if (update !== null) {
          ctx.store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } finally {
    if (taskAbort.signal.aborted) {
      try {
        await ctx.feishu.onStreamEnd(msg.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }
    activeTasks.delete(binding.codepilotSessionId);
    ctx.feishu.onMessageEnd(msg.chatId);
  }
}

// ── Slash commands ───────────────────────────────────────────

export async function handleCommand(
  ctx: AppContext,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Dangerous input check
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    console.warn(`[bridge] Blocked dangerous input: ${dangerCheck.reason}`);
    await deliver(ctx, msg.chatId, 'Command rejected: invalid input detected.');
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
    case '/help':
      response = [
        '**Feishu Bridge** (Claude Code / Copilot / Codex / Eureka)',
        '',
        'Send any message to chat with the configured agent.',
        '',
        '**Commands:**',
        '/new [path] - Start new session',
        '/bind <session_id> - Bind to existing session',
        '/list - Discover local CLI sessions',
        '/resume <编号或ID> - Resume a CLI session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change Claude permission mode',
        '/model <name> - Override the model for this chat (see `/model` for examples)',
        '/agent claude|copilot|codex|eureka - Switch backend agent for this chat',
        '/status - Show current chat status',
        '/tasks [all|running|history|eureka|codex] - 在手机查看本机 Eureka/Codex 任务',
        '/summary <编号或ID> - 快速看会话要求、修改和完成情况',
        '/sessions (or /board) - List every chat binding + their per-backend session IDs',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny <id> - Permission response',
        '1/2/3 - Quick permission reply (single pending)',
        '/whoami - Show your open_id and current chatId',
        '/spawn-chat [name] - Create a new group, invite you, send greeting',
        '/fork-chat - Fork current session into a new group, inviting you with a summary',
        '/cron <add|list|del|pause|resume> ... - Schedule recurring prompts (see `/cron`)',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      const oldBinding = resolveBinding(ctx, msg.chatId);
      const oldTask = activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        abortActiveTask(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = createNewBinding(ctx, msg.chatId, workDir);
      response = [
        'New session created.',
        `Session: \`${binding.codepilotSessionId.slice(0, 8)}...\``,
        `CWD: \`${binding.workingDirectory || '~'}\``,
      ].join('\n');
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind <session_id>';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format.';
        break;
      }
      const session = ctx.store.getSession(args);
      if (session) {
        ctx.store.upsertChannelBinding({
          chatId: msg.chatId,
          codepilotSessionId: args,
          workingDirectory: session.working_directory,
          model: session.model,
        });
        response = `Bound to session \`${args.slice(0, 8)}...\``;
      } else {
        const cliSession = findCliSession(ctx, args);
        if (cliSession) {
          response = resumeCliSession(ctx, msg.chatId, cliSession);
        } else {
          response = 'Session not found.';
        }
      }
      break;
    }

    case '/whoami': {
      response = [
        '**You**',
        `- userId (open_id): \`${msg.userId || '(unknown)'}\``,
        `- chatId: \`${msg.chatId}\``,
      ].join('\n');
      break;
    }

    case '/spawn-chat': {
      const chatName = args || `Bot Chat ${new Date().toISOString().slice(5, 16)}`;
      if (!msg.userId) {
        response = 'Cannot resolve your open_id from this message; cannot invite you.';
        break;
      }
      const result = await ctx.feishu.createGroupAndInvite({
        chatName,
        inviteOpenIds: [msg.userId],
        greeting: '你好',
      });
      if (result.ok) {
        const warn = result.warning ? `\n⚠️  ${result.warning}` : '';
        response = `Created chat \`${result.chatId}\` ("${chatName}") and invited you. Bot sent a greeting there.${warn}`;
      } else {
        response = `Failed: ${result.error || 'unknown error'}`;
      }
      break;
    }

    case '/fork-chat': {
      if (!msg.userId) {
        response = 'Cannot resolve your open_id; cannot invite you.';
        break;
      }
      const binding = resolveBinding(ctx, msg.chatId);
      if (!binding.sdkSessionId) {
        response = 'Current chat has no SDK session yet. Send any message first, then run /fork-chat.';
        break;
      }

      // Step 1: Fork the current SDK session and ask Claude for name+summary
      // in a single round. The fork inherits all prior context.
      const sum = await summarizeAndForkSession(ctx, binding);
      if (!sum.ok || !sum.forkedSdkSessionId) {
        response = `Fork failed: ${sum.error || 'unknown error'}`;
        break;
      }

      // Step 2: Create the group chat, invite the user, send the summary as greeting.
      const grp = await ctx.feishu.createGroupAndInvite({
        chatName: sum.name || '新对话',
        inviteOpenIds: [msg.userId],
        greeting: sum.summary,
      });
      if (!grp.ok || !grp.chatId) {
        response = `Created fork session but group creation failed: ${grp.error || 'unknown error'}\n(Forked sdkSessionId: \`${sum.forkedSdkSessionId.slice(0, 8)}...\`)`;
        break;
      }

      // Step 3: Bind the new chatId to a new bridge session pointing at the
      // forked SDK session. From now on messages in the new group continue
      // the forked branch — original chat keeps its own SDK session intact.
      const newSession = ctx.store.createSession(
        `Fork: ${sum.name}`,
        binding.model || ctx.config.defaultModel || '',
        undefined,
        binding.workingDirectory,
      );
      const newBinding = ctx.store.upsertChannelBinding({
        chatId: grp.chatId,
        codepilotSessionId: newSession.id,
        sdkSessionId: sum.forkedSdkSessionId,
        workingDirectory: binding.workingDirectory,
        model: binding.model || ctx.config.defaultModel || '',
        mode: binding.mode,
      });
      // upsert ignores sdkSessionId on existing rows; force-set via updateChannelBinding too.
      ctx.store.updateChannelBinding(newBinding.id, { sdkSessionId: sum.forkedSdkSessionId });

      response = [
        `🌿 已 fork 当前会话到新群`,
        `- 群名: **${sum.name}**`,
        `- 新 chatId: \`${grp.chatId}\``,
        `- forked sdkSessionId: \`${sum.forkedSdkSessionId.slice(0, 8)}...\``,
        grp.warning ? `- ⚠️  ${grp.warning}` : `- 原会话不受影响，在新群继续聊会延续完整上下文`,
      ].join('\n');
      break;
    }

    case '/cron': {
      if (!ctx.scheduler) {
        response = 'Scheduler not initialized.';
        break;
      }
      response = handleCronCommand(ctx, msg.chatId, args);
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path.';
        break;
      }
      const binding = resolveBinding(ctx, msg.chatId);
      ctx.store.updateChannelBinding(binding.id, { workingDirectory: validatedPath });
      response = `Working directory set to \`${validatedPath}\``;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = resolveBinding(ctx, msg.chatId);
      ctx.store.updateChannelBinding(binding.id, { mode: args as 'code' | 'plan' | 'ask' });
      response = `Mode set to **${args}**`;
      break;
    }

    case '/model': {
      const binding = resolveBinding(ctx, msg.chatId);
      const agent = binding.agent ?? ctx.config.defaultAgent;
      const requested = args.trim();
      if (!requested) {
        response = [
          `Current model: \`${binding.model || '(backend default)'}\``,
          `Current agent: **${agent}**`,
          '',
          'Usage: `/model <name>` — override the model for this chat.',
          'Reset: `/model default` (falls back to backend default).',
          '',
          'Examples per backend:',
          '  claude:    claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5',
          '  copilot:   auto (recommended), gpt-5.5, claude-opus-4.8, gemini-3.1-pro-preview',
          `  codex:     ${DEFAULT_CODEX_MODEL} (default; aliases: gpt6, gpt-6), or another Codex model id`,
          '  eureka:    Eureka workspace default, or any model supported by its selected engine',
          '',
          'Model IDs are validated by the backend, not by bridge. Wrong name = backend error.',
        ].join('\n');
        break;
      }
      let newModel = requested.toLowerCase() === 'default' || requested === '' ? '' : requested;
      if (agent === 'codex' && ['gpt6', 'gpt-6'].includes(newModel.toLowerCase())) {
        newModel = DEFAULT_CODEX_MODEL;
      } else if (agent === 'codex' && newModel.toLowerCase() === 'gpt-5.6') {
        newModel = 'gpt-5.6-luna';
      }
      if (agent === 'copilot' && newModel.toLowerCase() === 'gpt-5.6') {
        response = `Copilot CLI does not provide model \`gpt-5.6\`. No change was saved.\n\nTo use GPT-5.6 through Codex, send \`/agent codex\`, then \`/model ${DEFAULT_CODEX_MODEL}\`.`;
        break;
      }
      const agentModels = { ...(binding.agentModels ?? {}), [agent]: newModel };
      ctx.store.updateChannelBinding(binding.id, { model: newModel, agentModels });
      if (!newModel) {
        response = 'Model cleared — using backend default.';
        break;
      }
      // Warn if the requested model doesn't look like it belongs to the current backend.
      const isGpt = /^gpt-/i.test(newModel);
      const isGemini = /^gemini-/i.test(newModel);
      const isClaudeModel = /^claude-/i.test(newModel);
      const claudeHonors = agent === 'claude' ? isClaudeModel : true;
      const backendCanUseGpt = agent === 'copilot' || agent === 'codex';
      let hint = '';
      if (agent === 'claude' && (isGpt || isGemini)) {
        hint = ` ⚠️ Claude backend can't run \`${newModel}\`. Send \`/agent copilot\` to actually use it.`;
      } else if (!backendCanUseGpt && isGpt) {
        hint = ` ⚠️ Use a backend that supports the selected GPT model, such as Copilot or Codex.`;
      } else if (agent === 'claude' && !isClaudeModel) {
        hint = ` ⚠️ Claude backend expects an Anthropic model id (e.g. \`claude-opus-4-7\`). If you meant to test a non-Claude model, switch backend first: \`/agent copilot\`.`;
      }
      response = `Saved \`model=${newModel}\` on this chat (currently on **${agent}**).${hint}`;
      if (agent === 'claude' && !claudeHonors) {
        response += `\n\nNote: claude-provider currently ignores per-chat model overrides even for Claude ids — configure globally via \`CTI_DEFAULT_MODEL\` in config.env if you want to pin Claude to a specific version.`;
      }
      break;
    }

    case '/agent': {
      const requested = args.trim().toLowerCase();
      console.log(`[bridge] /agent invoked: chat=${msg.chatId} requested="${requested}"`);
      if (!requested) {
        const binding = resolveBinding(ctx, msg.chatId);
        const current = binding.agent ?? ctx.config.defaultAgent;
        response = [
          `Current agent: **${current}**`,
          '',
          'Usage: `/agent claude|copilot|codex|eureka`',
          '',
          'Backends:',
          '  claude    — in-process Claude Code SDK (per-tool permission gating, fork support)',
          '  copilot   — GitHub Copilot CLI subprocess (auto-approves all tools)',
          `  codex     — OpenAI Codex CLI (exec/resume JSONL, default model ${DEFAULT_CODEX_MODEL})`,
          '  eureka    — Eureka desktop task runtime (create/resume tasks through local MCP)',
        ].join('\n');
        break;
      }
      if (!isAgentKind(requested)) {
        response = `Unknown agent "${requested}". Supported: claude, copilot, codex, eureka.`;
        break;
      }
      try {
        const provider = ctx.providerFactory(requested);
        if (provider.preflight) {
          const live = await provider.preflight();
          if (!live.ok) throw new Error(live.error || 'live preflight failed');
        }
      } catch (err) {
        console.error(`[bridge] /agent preflight failed for ${requested}:`, err instanceof Error ? err.message : err);
        response = `Cannot switch to **${requested}** — ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
      try {
        const binding = resolveBinding(ctx, msg.chatId);
        const previousAgent = binding.agent ?? ctx.config.defaultAgent;
        console.log(`[bridge] /agent switching chat=${msg.chatId} binding=${binding.id.slice(0,8)} ${previousAgent} → ${requested}`);
        if (previousAgent === requested) {
          response = `Already on **${requested}** — nothing to do.`;
          break;
        }
        // Park the active session under the previous agent, then restore (or
        // empty) the new agent's saved session. Session IDs are NOT portable
        // across backends — a Claude UUID is meaningless to `copilot --resume`
        // and vice versa.
        const parked: Partial<Record<typeof requested, string>> = { ...(binding.agentSessions ?? {}) };
        const parkedModels = { ...(binding.agentModels ?? {}) };
        if (binding.sdkSessionId) {
          (parked as Record<string, string>)[previousAgent] = binding.sdkSessionId;
        }
        if (binding.model) {
          (parkedModels as Record<string, string>)[previousAgent] = binding.model;
        }
        const restored = (parked as Record<string, string>)[requested] ?? '';
        const restoredModel = (parkedModels as Record<string, string>)[requested]
          ?? (requested === 'codex' ? DEFAULT_CODEX_MODEL : ctx.config.defaultModel || '');
        ctx.store.updateChannelBinding(binding.id, {
          agent: requested,
          sdkSessionId: restored,
          agentSessions: parked,
          agentModels: parkedModels,
          model: restoredModel,
        });
        // Verify the write actually stuck. If persistence silently failed,
        // fail loudly instead of leaving the user with a false-positive
        // "switched" message and next turn going through the wrong backend.
        const verify = ctx.store.getChannelBinding(msg.chatId);
        if (!verify || verify.agent !== requested) {
          console.error(`[bridge] /agent WRITE FAILED verification: got ${verify?.agent ?? 'null'}, expected ${requested}`);
          response = `⚠️ Switch to **${requested}** wrote OK but read-back shows ${verify?.agent ?? 'nothing'}. Please retry, or /new to reset.`;
          break;
        }
        console.log(`[bridge] /agent switch verified: chat=${msg.chatId} agent=${verify.agent} sdkSessionId=${verify.sdkSessionId || '(empty)'}`);
        const continuity = restored
          ? `Resumed your previous **${requested}** session.`
          : `Starting a fresh **${requested}** session (no prior context).`;
        response = `Agent switched to **${requested}** for this chat. ${continuity}`;
      } catch (err) {
        console.error(`[bridge] /agent handler exception after preflight:`, err instanceof Error ? err.stack || err.message : err);
        response = `Switch failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`;
      }
      break;
    }

    case '/status': {
      const binding = resolveBinding(ctx, msg.chatId);
      const agent = binding.agent ?? ctx.config.defaultAgent;
      const lines = [
        '**Bridge Status**',
        '',
        `Agent: **${agent}**${binding.agent ? '' : ' (inherited from config default)'}`,
        `CWD: \`${binding.workingDirectory || '~'}\``,
        `Mode: **${binding.mode}**`,
        `Model: \`${binding.model || 'default'}\``,
      ];
      if (binding.sdkSessionId) {
        const resumeHint = agent === 'codex'
          ? 'codex exec resume'
          : agent === 'copilot' ? 'copilot --resume' : agent === 'eureka' ? 'Eureka task' : 'claude --resume';
        lines.push('', `SDK Session (用于终端 \`${resumeHint}\`):`);
        lines.push(`\`${binding.sdkSessionId}\``);
      } else {
        lines.push('', 'SDK Session: 尚未建立（发一条消息后生成）');
      }
      response = lines.join('\n');
      break;
    }

    case '/stop': {
      const binding = resolveBinding(ctx, msg.chatId);
      const taskAbort = activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        abortActiveTask(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/tasks': {
      const filter = (args || 'all').toLowerCase();
      if (!['all', 'running', 'history', 'eureka', 'codex'].includes(filter)) {
        response = 'Usage: /tasks [all|running|history|eureka|codex]';
        break;
      }
      const allSessions = ctx.store.listActivitySessions({ limit: 80, maxAgeDays: 90 });
      const eurekaSdkIds = new Set(allSessions.filter(s => s.source === 'eureka' && s.sdkSessionId).map(s => s.sdkSessionId));
      // In the combined views, one Eureka task should appear once even though
      // its underlying Codex rollout is also discoverable. `/tasks codex`
      // deliberately keeps the raw Codex view for backend verification.
      const combined = filter === 'eureka' || filter === 'codex'
        ? allSessions
        : allSessions.filter(s => s.source === 'eureka' || !eurekaSdkIds.has(s.sdkSessionId));
      let sessions = filter === 'running'
        ? combined.filter(s => s.status === 'running')
        : filter === 'history'
          ? combined.filter(s => s.status !== 'running')
          : filter === 'eureka' || filter === 'codex'
            ? allSessions.filter(s => s.source === filter)
            : combined;
      sessions = sessions.slice(0, 12);
      if (sessions.length === 0) {
        response = filter === 'running' ? '当前没有检测到正在运行的 Eureka/Codex 任务。' : `没有找到 ${filter} 会话。`;
        break;
      }
      activityCache.set(msg.chatId, { sessions, cachedAt: Date.now() });
      response = formatActivityList(sessions);
      break;
    }

    case '/summary': {
      if (!args) {
        response = 'Usage: /summary <编号或session ID>\n先发送 `/tasks` 获取编号。';
        break;
      }
      const cached = activityCache.get(msg.chatId);
      const cachedSessions = cached && Date.now() - cached.cachedAt <= LIST_CACHE_TTL ? cached.sessions : [];
      let target: ActivitySessionInfo | undefined;
      const num = Number(args);
      if (Number.isInteger(num) && num > 0) target = cachedSessions[num - 1];
      if (!target) {
        const candidates = cachedSessions.length ? cachedSessions : ctx.store.listActivitySessions({ limit: 80, maxAgeDays: 90 });
        const query = args.toLowerCase();
        target = candidates.find(s => s.id.toLowerCase().startsWith(query) || s.sdkSessionId?.toLowerCase().startsWith(query));
      }
      if (!target) {
        response = `未找到会话 "${clipInline(args, 80)}"。请先发送 \`/tasks\`。`;
        break;
      }
      response = formatActivitySummary(target);
      break;
    }

    case '/board':
    case '/sessions': {
      const all = ctx.store.listChannelBindings();
      if (all.length === 0) {
        response = 'No chat bindings yet. Send a message to any chat to create one.';
        break;
      }
      const sorted = [...all].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      // Resolve names in parallel; getChatName has internal cache + failure backoff.
      const named = await Promise.all(sorted.map(async b => ({
        b,
        name: await ctx.feishu.getChatName(b.chatId),
      })));
      const lines: string[] = [`**Sessions Dashboard** (${sorted.length} chats)`, ''];
      const defaultAgent = ctx.config.defaultAgent;
      const port = ctx.outbox?.getPort();
      if (port) {
        lines.push(`🖥 Web view: http://127.0.0.1:${port}/dashboard`);
        lines.push('');
      }
      for (const { b, name } of named) {
        const isCurrent = b.chatId === msg.chatId;
        const activeAgent = b.agent ?? defaultAgent;
        const cwdShort = b.workingDirectory ? `\`${b.workingDirectory}\`` : '`~`';
        const updated = b.updatedAt ? formatRelativeTime(new Date(b.updatedAt).getTime()) : '?';
        const chatIdShort = b.chatId.length > 18 ? b.chatId.slice(0, 18) + '...' : b.chatId;
        const msgCount = ctx.store.getMessages(b.codepilotSessionId).messages.length;
        const heading = name ? `**${name}**  \`${chatIdShort}\`` : `\`${chatIdShort}\``;
        lines.push(`${heading}${isCurrent ? ' ← **current**' : ''}`);
        lines.push(`  Agent: **${activeAgent}** · CWD: ${cwdShort} · Msgs: ${msgCount} · Updated: ${updated}`);

        const parked = b.agentSessions || {};
        const allBackends = new Set<string>([activeAgent, ...Object.keys(parked)]);
        const sessionLines: string[] = [];
        for (const backend of allBackends) {
          const isActive = backend === activeAgent;
          const sid = isActive ? b.sdkSessionId : parked[backend as keyof typeof parked];
          if (!sid) continue;
          const sidShort = sid.length > 12 ? sid.slice(0, 12) + '...' : sid;
          sessionLines.push(`  ${backend}: \`${sidShort}\` ${isActive ? '(active)' : '(parked)'}`);
        }
        if (sessionLines.length > 0) lines.push(...sessionLines);
        else lines.push('  _(no SDK session yet — send a message to start one)_');
        lines.push('');
      }
      response = lines.join('\n').trim();
      break;
    }

    case '/perm': {
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny <permission_id>';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = handlePermissionCallback(ctx, callbackData, msg.chatId);
      response = handled
        ? `Permission ${permAction}: recorded.`
        : 'Permission not found or already resolved.';
      break;
    }

    case '/list': {
      const sessions = ctx.store.listCliSessions({ limit: 20 });
      if (sessions.length === 0) {
        response = 'No local CLI sessions found.';
        break;
      }
      listCache.set(msg.chatId, { sessions, cachedAt: Date.now() });

      const lines = ['**本地 CLI 会话:**', ''];
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const icon = s.isOpen ? '🟢' : '⚪';
        const prompt = s.firstPrompt.length > 40 ? s.firstPrompt.slice(0, 40) + '...' : s.firstPrompt;
        const timeAgo = formatRelativeTime(s.timestamp);
        const backendTags: Record<string, string> = {
          claude: '🟠 \\[claude]',
          copilot: '🟢 \\[copilot]',
          codex: '🔵 \\[codex]',
        };
        const backendTag = backendTags[s.backend ?? 'claude'] ?? `⚪ \\[${s.backend}]`;
        lines.push(`${i + 1}. ${icon} ${backendTag} \`${s.sdkSessionId.slice(0, 8)}\`  ${s.project}`);
        lines.push(`   "${prompt}" (${timeAgo})`);
      }
      lines.push('');
      lines.push('发送 /resume <编号> 恢复会话');
      response = lines.join('\n');
      break;
    }

    case '/resume': {
      if (!args) {
        response = 'Usage: /resume <编号或ID>\n先发送 /list 查看可用会话。';
        break;
      }

      let target: CliSessionInfo | null = null;

      const num = parseInt(args, 10);
      if (!isNaN(num) && num > 0 && String(num) === args.trim()) {
        const cached = getCachedList(msg.chatId);
        if (cached && num <= cached.length) {
          target = cached[num - 1];
        } else {
          const freshSessions = ctx.store.listCliSessions({ limit: 20 });
          listCache.set(msg.chatId, { sessions: freshSessions, cachedAt: Date.now() });
          if (num <= freshSessions.length) {
            target = freshSessions[num - 1];
          }
        }
        if (!target) {
          response = `编号 ${num} 超出范围。发送 /list 查看可用会话。`;
          break;
        }
      }

      if (!target) {
        target = findCliSession(ctx, args);
      }

      if (!target) {
        response = `未找到匹配 "${args}" 的会话。\n发送 /list 查看可用会话。`;
        break;
      }

      // Abort running task
      const oldBinding = resolveBinding(ctx, msg.chatId);
      const oldTask = activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        abortActiveTask(oldBinding.codepilotSessionId);
      }

      response = resumeCliSession(ctx, msg.chatId, target);
      break;
    }

    default:
      response = `Unknown command: ${command}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(ctx, msg.chatId, response, {
      parseMode: 'Markdown',
      replyToMessageId: msg.messageId,
    });
  }
}
