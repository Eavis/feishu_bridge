// Discovers durable OpenAI Codex CLI sessions under CODEX_HOME/sessions.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliSessionInfo } from './types.js';

interface ScanOptions {
  limit?: number;
  maxAgeDays?: number;
  codexHome?: string;
}

function sessionsRoot(codexHome?: string): string {
  return path.join(codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

function collectRollouts(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) collectRollouts(fullPath, out);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) out.push(fullPath);
  }
}

function readScanLines(filePath: string, maxBytes = 2 * 1024 * 1024): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= maxBytes * 2) return fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const head = Buffer.alloc(maxBytes);
    const tail = Buffer.alloc(maxBytes);
    fs.readSync(fd, head, 0, maxBytes, 0);
    fs.readSync(fd, tail, 0, maxBytes, size - maxBytes);
    const tailText = tail.toString('utf8');
    const firstNewline = tailText.indexOf('\n');
    return [
      ...head.toString('utf8').split(/\r?\n/),
      ...(firstNewline >= 0 ? tailText.slice(firstNewline + 1) : tailText).split(/\r?\n/),
    ];
  } catch { return []; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (!block || typeof block !== 'object') return '';
    const value = block as Record<string, unknown>;
    return value.type === 'input_text' || value.type === 'output_text' || value.type === 'text' ? String(value.text || '') : '';
  }).filter(Boolean).join('\n');
}

function stripBridgePrompt(text: string): string {
  const normalized = text
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, '')
    .trim();
  if (normalized.startsWith('<recommended_plugins>')) return '';
  if (!normalized.startsWith('请始终用简体中文回复')) return normalized;
  const parts = normalized.split(/\n\n---\n\n/);
  return parts.length > 1 ? parts[parts.length - 1].trim() : normalized;
}

function parseRollout(filePath: string, timestamp: number): CliSessionInfo | null {
  let sessionId = '';
  let cwd = '';
  const userPrompts: string[] = [];
  const assistantMessages: string[] = [];
  let gitBranch: string | undefined;
  let model = '';
  let isOpen = false;

  const pushUnique = (items: string[], raw: string): void => {
    const value = stripBridgePrompt(raw).replace(/\s+/g, ' ').trim();
    if (value && items[items.length - 1] !== value) items.push(value);
  };

  for (const line of readScanLines(filePath)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = (record.payload || {}) as Record<string, unknown>;
    if (record.type === 'session_meta') {
      sessionId = String(payload.id || payload.session_id || sessionId);
      cwd = String(payload.cwd || cwd);
      const git = payload.git as Record<string, unknown> | undefined;
      if (git && typeof git.branch === 'string') gitBranch = git.branch;
    } else if (record.type === 'turn_context') {
      cwd = String(payload.cwd || cwd);
      model = String(payload.model || model);
    } else if (record.type === 'event_msg' && payload.type === 'user_message') {
      pushUnique(userPrompts, String(payload.message || ''));
    } else if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      pushUnique(userPrompts, textFromContent(payload.content));
    } else if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      pushUnique(assistantMessages, textFromContent(payload.content));
    } else if (record.type === 'event_msg' && payload.type === 'agent_message') {
      pushUnique(assistantMessages, String(payload.message || ''));
    } else if (record.type === 'event_msg' && payload.type === 'item_completed') {
      const item = (payload.item || {}) as Record<string, unknown>;
      if (String(item.type || '').toLowerCase() === 'agentmessage') {
        pushUnique(assistantMessages, textFromContent(item.content));
      }
    }
    if (record.type === 'event_msg' && (payload.type === 'task_started' || payload.type === 'turn_started')) {
      isOpen = true;
    } else if (record.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_completed' || payload.type === 'turn_aborted')) {
      isOpen = false;
      if (typeof payload.last_agent_message === 'string') pushUnique(assistantMessages, payload.last_agent_message);
    }
  }
  if (!sessionId) return null;
  // An unmatched task_started means "interrupted/unfinished", not necessarily
  // "still executing" forever. Codex writes rollout activity continuously, so
  // stale unfinished files must be treated as history rather than live work.
  isOpen = isOpen && Date.now() - timestamp <= 10 * 60 * 1000;
  const firstPrompt = userPrompts[0] || '';
  const latestPrompt = userPrompts.at(-1);
  const accomplished = assistantMessages.at(-1) || (isOpen ? '任务仍在运行，尚未产出可见结果' : '未提取到最终结果');
  const project = cwd ? path.basename(cwd) : '';
  return {
    sdkSessionId: sessionId,
    project,
    cwd,
    firstPrompt: firstPrompt.slice(0, 200) || '(Codex session — no prompt captured)',
    slug: model,
    timestamp,
    isOpen,
    gitBranch,
    backend: 'codex',
    digest: {
      requested: firstPrompt.slice(0, 600) || '(Codex session — no prompt captured)',
      latestRequest: latestPrompt && latestPrompt !== firstPrompt ? latestPrompt.slice(0, 600) : undefined,
      accomplished: accomplished.slice(0, 600),
    },
  };
}

export function scanCodexSessions(opts?: ScanOptions): CliSessionInfo[] {
  const limit = opts?.limit ?? 20;
  const cutoff = Date.now() - (opts?.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000;
  const files: string[] = [];
  collectRollouts(sessionsRoot(opts?.codexHome), files);
  const results: CliSessionInfo[] = [];
  for (const filePath of files) {
    let timestamp: number;
    try { timestamp = fs.statSync(filePath).mtimeMs; } catch { continue; }
    if (timestamp < cutoff) continue;
    const parsed = parseRollout(filePath, timestamp);
    if (parsed) results.push(parsed);
  }
  results.sort((a, b) => b.timestamp - a.timestamp);
  return results.slice(0, limit);
}
