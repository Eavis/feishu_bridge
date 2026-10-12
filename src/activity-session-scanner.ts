/**
 * Unified local activity scanner for Eureka tasks and Codex CLI sessions.
 *
 * The bridge intentionally reads durable session files instead of trying to
 * introspect desktop process memory. Eureka writes authoritative task state to
 * the first JSONL record, while both Eureka and Codex append the conversation
 * needed for a compact mobile digest.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActivitySessionInfo, SessionDigest } from './types.js';
import { scanCodexSessions } from './codex-session-scanner.js';

interface ScanActivityOptions {
  limit?: number;
  maxAgeDays?: number;
  eurekaRoots?: string[];
  codexHomes?: string[];
}

interface EurekaMetadata {
  id?: string;
  name?: string;
  preview?: string;
  workspaceRootPath?: string;
  createdAt?: number;
  lastUsedAt?: number;
  todoState?: string;
  taskAttentionStatus?: string;
  workingDirectory?: string;
  sdkCwd?: string;
  sdkSessionId?: string;
  engine?: string;
  model?: string;
}

const WINDOW_BYTES = 2 * 1024 * 1024;

function expandHome(value: string): string {
  return value.replace(/^~(?=[\\/]|$)/, os.homedir());
}

function readWindow(filePath: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= WINDOW_BYTES * 2) return fs.readFileSync(filePath, 'utf8');
    const head = Buffer.alloc(WINDOW_BYTES);
    const tail = Buffer.alloc(WINDOW_BYTES);
    fs.readSync(fd, head, 0, WINDOW_BYTES, 0);
    fs.readSync(fd, tail, 0, WINDOW_BYTES, size - WINDOW_BYTES);
    const tailText = tail.toString('utf8');
    const firstNewline = tailText.indexOf('\n');
    return `${head.toString('utf8')}\n${firstNewline >= 0 ? tailText.slice(firstNewline + 1) : tailText}`;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function compact(value: string, max = 600): string {
  const cleaned = value
    .replace(/<!--files:[\s\S]*?-->/g, '')
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function uniquePush(values: string[], value: string): void {
  const text = compact(value);
  if (text && values[values.length - 1] !== text) values.push(text);
}

function digestFromEureka(records: Array<Record<string, unknown>>, metadata: EurekaMetadata): SessionDigest {
  const users: string[] = [];
  const assistants: string[] = [];
  for (const record of records) {
    if (record.type === 'user' && typeof record.content === 'string') {
      uniquePush(users, record.content);
    } else if (record.type === 'assistant' && typeof record.content === 'string') {
      uniquePush(assistants, record.content);
    }
  }
  const requested = users[0] || compact(metadata.preview || '') || '（未提取到用户要求）';
  const latest = users.at(-1);
  const latestRequest = latest && latest !== requested ? latest : undefined;
  const accomplished = assistants.at(-1) || '尚未产出可见结果';
  return { requested, latestRequest, accomplished };
}

function eurekaStatus(metadata: EurekaMetadata): ActivitySessionInfo['status'] {
  if (metadata.taskAttentionStatus === 'in_progress') return 'running';
  if (metadata.todoState === 'needs-review') return 'waiting';
  if (metadata.todoState === 'done' || metadata.taskAttentionStatus === 'read' || metadata.taskAttentionStatus === 'unread') return 'completed';
  return 'unknown';
}

function discoverEurekaRoots(explicit?: string[]): string[] {
  if (explicit?.length) return explicit.map(expandHome);
  const configured = process.env.CTI_EUREKA_ROOTS?.split(path.delimiter).filter(Boolean).map(expandHome) || [];
  const roots = new Set(configured);
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(os.homedir(), { withFileTypes: true }); } catch { /* ignore */ }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.eureka' || entry.name.startsWith('.eureka-') || entry.name === '.craft-agent') {
      roots.add(path.join(os.homedir(), entry.name));
    }
  }
  return [...roots];
}

function discoverEurekaSessionFiles(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const workspaces = path.join(root, 'workspaces');
    let workspaceEntries: fs.Dirent[] = [];
    try { workspaceEntries = fs.readdirSync(workspaces, { withFileTypes: true }); } catch { continue; }
    for (const workspace of workspaceEntries) {
      if (!workspace.isDirectory()) continue;
      const sessions = path.join(workspaces, workspace.name, 'sessions');
      let sessionEntries: fs.Dirent[] = [];
      try { sessionEntries = fs.readdirSync(sessions, { withFileTypes: true }); } catch { continue; }
      for (const session of sessionEntries) {
        if (!session.isDirectory()) continue;
        const filePath = path.join(sessions, session.name, 'session.jsonl');
        try { if (fs.statSync(filePath).isFile()) files.push(filePath); } catch { /* ignore */ }
      }
    }
  }
  return files;
}

function parseEurekaFile(filePath: string): ActivitySessionInfo | null {
  const raw = readWindow(filePath);
  if (!raw) return null;
  const records: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as Record<string, unknown>); } catch { /* partial/large line */ }
  }
  const metadata = (records[0] || {}) as EurekaMetadata;
  const sessionId = metadata.id || path.basename(path.dirname(filePath));
  const workspaceId = path.basename(path.dirname(path.dirname(path.dirname(filePath))));
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); } catch { return null; }
  const digest = digestFromEureka(records.slice(1), metadata);
  return {
    id: sessionId,
    source: 'eureka',
    name: compact(metadata.name || digest.requested, 80),
    status: eurekaStatus(metadata),
    updatedAt: metadata.lastUsedAt || stat.mtimeMs,
    createdAt: metadata.createdAt,
    cwd: expandHome(metadata.workingDirectory || metadata.sdkCwd || ''),
    engine: metadata.engine || 'eureka',
    model: metadata.model || '',
    digest,
    deepLink: `eureka://workspaces/${workspaceId}/sessions/${sessionId}`,
    workspaceId,
    sdkSessionId: metadata.sdkSessionId,
  };
}

export function scanEurekaSessions(opts?: ScanActivityOptions): ActivitySessionInfo[] {
  const cutoff = Date.now() - (opts?.maxAgeDays ?? 90) * 24 * 60 * 60 * 1000;
  const results: ActivitySessionInfo[] = [];
  for (const filePath of discoverEurekaSessionFiles(discoverEurekaRoots(opts?.eurekaRoots))) {
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch { continue; }
    if (mtime < cutoff) continue;
    const parsed = parseEurekaFile(filePath);
    if (parsed) results.push(parsed);
  }
  results.sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.updatedAt - a.updatedAt);
  return results.slice(0, opts?.limit ?? 50);
}

function discoverCodexHomes(eurekaRoots: string[], explicit?: string[]): string[] {
  const homes = new Set<string>();
  for (const value of explicit || []) homes.add(expandHome(value));
  if (process.env.CODEX_HOME) homes.add(expandHome(process.env.CODEX_HOME));
  homes.add(path.join(os.homedir(), '.codex'));
  for (const sessionFile of discoverEurekaSessionFiles(eurekaRoots)) {
    const candidate = path.join(path.dirname(sessionFile), '.codex-home');
    if (fs.existsSync(path.join(candidate, 'sessions'))) homes.add(candidate);
  }
  return [...homes];
}

export function scanActivitySessions(opts?: ScanActivityOptions): ActivitySessionInfo[] {
  const eurekaRoots = discoverEurekaRoots(opts?.eurekaRoots);
  const eureka = scanEurekaSessions({ ...opts, eurekaRoots, limit: Math.max(opts?.limit ?? 50, 50) });
  const linksBySdkId = new Map(eureka.filter(s => s.sdkSessionId).map(s => [s.sdkSessionId!, s.deepLink!]));
  const codexById = new Map<string, ActivitySessionInfo>();
  for (const home of discoverCodexHomes(eurekaRoots, opts?.codexHomes)) {
    const sessions = scanCodexSessions({ codexHome: home, limit: Math.max(opts?.limit ?? 50, 50), maxAgeDays: opts?.maxAgeDays });
    for (const session of sessions) {
      const current: ActivitySessionInfo = {
        id: session.sdkSessionId,
        source: 'codex',
        name: compact(session.firstPrompt, 80),
        status: session.isOpen ? 'running' : 'completed',
        updatedAt: session.timestamp,
        cwd: session.cwd,
        engine: 'codex',
        model: session.slug || '',
        digest: session.digest || {
          requested: session.firstPrompt,
          accomplished: session.isOpen ? '任务仍在运行' : '未提取到最终结果',
        },
        deepLink: session.deepLink || linksBySdkId.get(session.sdkSessionId),
        sdkSessionId: session.sdkSessionId,
      };
      const previous = codexById.get(current.id);
      if (!previous || current.updatedAt > previous.updatedAt) codexById.set(current.id, current);
    }
  }
  const merged = [...eureka, ...codexById.values()];
  merged.sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.updatedAt - a.updatedAt);
  return merged.slice(0, opts?.limit ?? 50);
}
