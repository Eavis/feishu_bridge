/**
 * Outbox HTTP server — local-only endpoint that the feishu-outbox MCP
 * server calls back into. The MCP server runs as a child process of
 * Claude (spawned by the SDK) and cannot share memory with the bridge,
 * so we expose this loopback HTTP API for it.
 *
 * Each session registers a (token → chatId, workDir, replyToMessageId)
 * tuple; the MCP server is started with that token in its env and uses
 * it to call back. Tokens are single-session scoped.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import type { FeishuClient } from './feishu.js';
import type { JsonFileStore } from './store.js';
import type { Scheduler, ScheduledTask } from './scheduler.js';
import type { AgentKind } from './provider-factory.js';
import type { WsConnectionHealth } from './ws-health.js';

const MAX_FILE_SIZE_MB = 30;

interface TokenEntry {
  chatId: string;
  workDir: string;
  replyToMessageId?: string;
}

interface PendingCron {
  cron: string;
  prompt: string;
  chatId: string;       // target chat (where the task will fire)
  originChatId: string; // chat that issued the request (where confirm card lives)
  name?: string;
  createdAt: number;
}

export class OutboxServer {
  private server: http.Server | null = null;
  private port = 0;
  private tokens = new Map<string, TokenEntry>();
  /** Cron tasks proposed by Claude that need user confirmation. */
  private pendingCron = new Map<string, PendingCron>();
  /** Optional scheduler — set after construction by main.ts to avoid circular ref. */
  scheduler: Scheduler | null = null;
  /** Optional store — set after construction by main.ts so the dashboard can list bindings. */
  store: JsonFileStore | null = null;

  constructor(
    private feishu: FeishuClient,
    private requestedPort = 59_991,
    private healthSnapshot?: () => {
      ws: WsConnectionHealth;
      activeTasks: number;
      startedAt: string;
      lastInboundEventAt: number | null;
      commands?: { active: number; pendingMessages: number; oldestActiveMs: number; stalled: boolean };
    },
  ) {}

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          console.error('[outbox] handler error:', err instanceof Error ? err.message : err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: 'internal error' }));
          }
        });
      });
      // 127.0.0.1 only — never expose to LAN.
      this.server.listen(this.requestedPort, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          console.log(`[outbox] listening on http://127.0.0.1:${this.port}`);
          console.log(`[outbox] dashboard available at http://127.0.0.1:${this.port}/dashboard`);
          resolve(this.port);
        } else {
          reject(new Error('failed to bind outbox port'));
        }
      });
      this.server.on('error', reject);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.tokens.clear();
  }

  getPort(): number {
    return this.port;
  }

  /** Register or refresh a token for this chat. Returns the token. */
  registerSession(chatId: string, workDir: string, replyToMessageId?: string): string {
    // Reuse existing token for this chat to keep MCP env stable across messages.
    for (const [tok, entry] of this.tokens) {
      if (entry.chatId === chatId) {
        entry.workDir = workDir;
        entry.replyToMessageId = replyToMessageId;
        return tok;
      }
    }
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.set(token, { chatId, workDir, replyToMessageId });
    return token;
  }

  /** Update the "reply target" for a chat without rotating the token. */
  updateReplyTarget(chatId: string, replyToMessageId: string | undefined): void {
    for (const entry of this.tokens.values()) {
      if (entry.chatId === chatId) {
        entry.replyToMessageId = replyToMessageId;
        return;
      }
    }
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > 64 * 1024) throw new Error('request body too large');
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.url === '/health') {
      const snapshot = this.healthSnapshot?.();
      const healthy = this.feishu.isRunning() && snapshot?.ws.state === 'connected' && !snapshot?.commands?.stalled;
      res.statusCode = healthy ? 200 : 503;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({
        ok: healthy,
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        ...snapshot,
      }));
      return;
    }

    // ── Dashboard (GET) ──
    if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(DASHBOARD_HTML);
      return;
    }
    if (req.method === 'GET' && req.url === '/api/dashboard.json') {
      const data = await this.buildDashboardData();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(data));
      return;
    }

    if (req.method !== 'POST') {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
      return;
    }

    // Cron management endpoints (require token, like /send-file).
    if (req.url === '/cron-add') return this.handleCronAdd(req, res);
    if (req.url === '/cron-list') return this.handleCronList(req, res);
    if (req.url === '/cron-del') return this.handleCronDel(req, res);
    if (req.url === '/cron-pause') return this.handleCronToggle(req, res, false);
    if (req.url === '/cron-resume') return this.handleCronToggle(req, res, true);

    if (req.url !== '/send-file') {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }

    const body = await this.readBody(req);
    let payload: { token?: string; path?: string; caption?: string; reply?: boolean };
    try { payload = JSON.parse(body); } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
      return;
    }

    const token = payload.token;
    if (!token || typeof token !== 'string') {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'missing token' }));
      return;
    }
    const entry = this.tokens.get(token);
    if (!entry) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'invalid token' }));
      return;
    }

    const filePath = payload.path;
    if (!filePath || typeof filePath !== 'string') {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'missing path' }));
      return;
    }

    const resolved = path.resolve(filePath);
    const workDir = path.resolve(entry.workDir);
    // Containment check: must live under workDir (case-insensitive on Windows).
    const cmp = process.platform === 'win32'
      ? resolved.toLowerCase().startsWith(workDir.toLowerCase() + path.sep)
        || resolved.toLowerCase() === workDir.toLowerCase()
      : resolved.startsWith(workDir + path.sep) || resolved === workDir;
    if (!cmp) {
      res.statusCode = 403;
      res.end(JSON.stringify({ ok: false, error: `path must be inside workDir ${workDir}` }));
      return;
    }

    // Size check
    const fs = await import('node:fs');
    let stat: import('node:fs').Stats;
    try { stat = fs.statSync(resolved); } catch (e) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: `file not found: ${resolved}` }));
      return;
    }
    if (stat.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      res.statusCode = 413;
      res.end(JSON.stringify({ ok: false, error: `file exceeds ${MAX_FILE_SIZE_MB}MB limit (${stat.size} bytes)` }));
      return;
    }

    const reply = payload.reply !== false; // default true
    const result = await this.feishu.uploadAndSendFile({
      chatId: entry.chatId,
      filePath: resolved,
      replyToMessageId: reply ? entry.replyToMessageId : undefined,
      caption: payload.caption,
    });

    res.setHeader('Content-Type', 'application/json');
    res.statusCode = result.ok ? 200 : 500;
    res.end(JSON.stringify(result));
  }

  // ── Cron management ────────────────────────────────────────

  private async authToken(req: http.IncomingMessage, res: http.ServerResponse): Promise<{ entry: TokenEntry; payload: any } | null> {
    const body = await this.readBody(req);
    let payload: any;
    try { payload = JSON.parse(body); } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
      return null;
    }
    const token = payload.token;
    if (!token || typeof token !== 'string') {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'missing token' }));
      return null;
    }
    const entry = this.tokens.get(token);
    if (!entry) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'invalid token' }));
      return null;
    }
    return { entry, payload };
  }

  private async handleCronAdd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const auth = await this.authToken(req, res);
    if (!auth) return;
    if (!this.scheduler) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: 'scheduler not initialized' }));
      return;
    }
    const { entry, payload } = auth;
    const cron = String(payload.cron || '').trim();
    const prompt = String(payload.prompt || '').trim();
    const targetChatId = (payload.chatId && String(payload.chatId).trim()) || entry.chatId;
    const name = payload.name ? String(payload.name).trim() : undefined;
    if (!cron || !prompt) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'cron and prompt are required' }));
      return;
    }

    // Validate cron + compute next fire BEFORE asking the user to confirm.
    let nextFireAt: number;
    try {
      const { CronExpressionParser } = await import('cron-parser');
      nextFireAt = CronExpressionParser.parse(cron).next().getTime();
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: `invalid cron: ${e instanceof Error ? e.message : String(e)}` }));
      return;
    }

    // Stash as pending; send confirm card to the chat that issued the request.
    const pendingId = crypto.randomBytes(4).toString('hex');
    this.pendingCron.set(pendingId, {
      cron, prompt, chatId: targetChatId, originChatId: entry.chatId, name, createdAt: Date.now(),
    });

    // Best-effort: GC pending entries older than 1h to avoid leaks.
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [k, v] of this.pendingCron) {
      if (v.createdAt < cutoff) this.pendingCron.delete(k);
    }

    try {
      await this.feishu.sendCronConfirmCard(entry.chatId, {
        pendingId,
        cron,
        prompt,
        targetChatId,
        nextFireAt,
        sameAsOrigin: targetChatId === entry.chatId,
      });
      console.log(`[outbox] cron-add pending=${pendingId} cron="${cron}" → ${targetChatId} next=${new Date(nextFireAt).toISOString()}`);
    } catch (e) {
      this.pendingCron.delete(pendingId);
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: `failed to send confirm card: ${e instanceof Error ? e.message : e}` }));
      return;
    }

    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, pendingId, nextFireAt: new Date(nextFireAt).toISOString(), pending: true }));
  }

  private async handleCronList(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const auth = await this.authToken(req, res);
    if (!auth) return;
    if (!this.scheduler) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: 'scheduler not initialized' }));
      return;
    }
    const tasks = this.scheduler.list().map((t) => ({
      id: t.id, cron: t.cron, prompt: t.prompt, chatId: t.chatId,
      enabled: t.enabled, name: t.name, lastFiredAt: t.lastFiredAt,
      nextFireAt: t.nextFireAt ? new Date(t.nextFireAt).toISOString() : null,
    }));
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, tasks }));
  }

  private async handleCronDel(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const auth = await this.authToken(req, res);
    if (!auth) return;
    if (!this.scheduler) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: 'scheduler not initialized' }));
      return;
    }
    const id = String(auth.payload.id || '').trim();
    if (!id) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'id is required' }));
      return;
    }
    const ok = this.scheduler.delete(id);
    res.statusCode = ok ? 200 : 404;
    res.end(JSON.stringify({ ok, error: ok ? undefined : 'task not found' }));
  }

  private async handleCronToggle(req: http.IncomingMessage, res: http.ServerResponse, enabled: boolean): Promise<void> {
    const auth = await this.authToken(req, res);
    if (!auth) return;
    if (!this.scheduler) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: 'scheduler not initialized' }));
      return;
    }
    const id = String(auth.payload.id || '').trim();
    if (!id) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'id is required' }));
      return;
    }
    const ok = this.scheduler.setEnabled(id, enabled);
    res.statusCode = ok ? 200 : 404;
    res.end(JSON.stringify({ ok, error: ok ? undefined : 'task not found' }));
  }

  // ── Pending cron confirm/cancel (called by bridge.ts after card button press)

  /** Returns { ok, task? } describing the result of confirmation. */
  confirmPendingCron(pendingId: string): { ok: boolean; task?: ScheduledTask; error?: string } {
    const pending = this.pendingCron.get(pendingId);
    if (!pending) {
      console.warn(`[outbox] cron-confirm: pending=${pendingId} not found (expired or unknown)`);
      return { ok: false, error: 'pending cron not found or expired' };
    }
    this.pendingCron.delete(pendingId);
    if (!this.scheduler) return { ok: false, error: 'scheduler not initialized' };
    const r = this.scheduler.add({
      cron: pending.cron, prompt: pending.prompt, chatId: pending.chatId, name: pending.name,
    });
    if (r.ok && r.task) {
      console.log(`[outbox] cron-confirm: pending=${pendingId} → task=${r.task.id} cron="${r.task.cron}" → ${r.task.chatId}`);
    } else {
      console.warn(`[outbox] cron-confirm: scheduler.add failed: ${r.error}`);
    }
    return { ok: r.ok, task: r.task, error: r.error };
  }

  cancelPendingCron(pendingId: string): boolean {
    const ok = this.pendingCron.delete(pendingId);
    console.log(`[outbox] cron-cancel: pending=${pendingId} ${ok ? 'dropped' : 'not found'}`);
    return ok;
  }

  // ── Dashboard ───────────────────────────────────────────────

  /**
   * Build the dashboard payload: every chat binding with its active backend,
   * parked per-backend session IDs, resolved chat name, message count, and
   * last-activity timestamp. Used by both the in-Feishu /sessions command
   * and the localhost HTML dashboard.
   */
  private async buildDashboardData(): Promise<{
    generatedAt: string;
    chats: Array<{
      chatId: string;
      chatName: string | null;
      agent: AgentKind;
      cwd: string;
      mode: string;
      model: string;
      updatedAt: string;
      createdAt: string;
      messageCount: number;
      activeSessionId: string;
      parkedSessions: Partial<Record<AgentKind, string>>;
    }>;
    scheduled: Array<{
      id: string;
      cron: string;
      prompt: string;
      chatId: string;
      enabled: boolean;
      name?: string;
      lastFiredAt?: number;
      nextFireAt: string | null;
    }>;
  }> {
    if (!this.store) {
      return { generatedAt: new Date().toISOString(), chats: [], scheduled: [] };
    }
    const bindings = this.store.listChannelBindings();
    // Resolve names in parallel; getChatName has its own cache + failure backoff.
    const named = await Promise.all(bindings.map(async b => ({
      b,
      name: await this.feishu.getChatName(b.chatId),
    })));
    const chats = named.map(({ b, name }) => {
      const msgs = this.store!.getMessages(b.codepilotSessionId);
      const messageCount = msgs.messages.length;
      const agent = (b.agent ?? 'claude') as AgentKind;
      const parked: Partial<Record<AgentKind, string>> = b.agentSessions ? { ...b.agentSessions } : {};
      // Don't double-report the active id under "parked".
      if (parked[agent]) delete parked[agent];
      return {
        chatId: b.chatId,
        chatName: name,
        agent,
        cwd: b.workingDirectory || '',
        mode: b.mode || 'code',
        model: b.model || '',
        updatedAt: b.updatedAt || '',
        createdAt: b.createdAt || '',
        messageCount,
        activeSessionId: b.sdkSessionId || '',
        parkedSessions: parked,
      };
    });
    chats.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    const scheduled = this.scheduler
      ? this.scheduler.list().map(t => ({
          id: t.id,
          cron: t.cron,
          prompt: t.prompt,
          chatId: t.chatId,
          enabled: t.enabled,
          name: t.name,
          lastFiredAt: t.lastFiredAt,
          nextFireAt: t.nextFireAt ? new Date(t.nextFireAt).toISOString() : null,
        }))
      : [];

    return { generatedAt: new Date().toISOString(), chats, scheduled };
  }
}

// ── Dashboard HTML ─────────────────────────────────────────────
//
// Single-page app that polls /api/dashboard.json every 5s and renders the
// chat bindings + scheduled cron tasks. No build step, no dependencies.

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feishu Bridge — Sessions Dashboard</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface-2: #1f2630;
    --border: #30363d;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --claude: #ff8c00;
    --copilot: #7ee787;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, "Segoe UI", -apple-system, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; font-weight: 600; }
  .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 24px; display: flex; gap: 16px; align-items: center; }
  .subtitle .live { display: inline-flex; align-items: center; gap: 6px; }
  .live::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 32px 0 12px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 8px; overflow: hidden; }
  th { text-align: left; padding: 10px 12px; background: var(--surface-2); border-bottom: 1px solid var(--border); font-weight: 600; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  td { padding: 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--surface-2); }
  code { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 12px; background: var(--surface-2); padding: 1px 6px; border-radius: 4px; color: var(--text); }
  .agent { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
  .agent.claude    { background: rgba(255,140,0,0.15); color: var(--claude); }
  .agent.copilot   { background: rgba(126,231,135,0.15); color: var(--copilot); }
  .muted { color: var(--muted); }
  .sid-list { display: flex; flex-direction: column; gap: 4px; }
  .sid-list code { font-size: 11px; }
  .sid-list .label { color: var(--muted); font-size: 11px; }
  .badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 3px; margin-left: 6px; background: var(--surface-2); color: var(--muted); }
  .badge.active { background: #1f6feb; color: white; }
  .badge.disabled { background: #6e7681; color: white; }
  .empty { text-align: center; padding: 40px; color: var(--muted); background: var(--surface); border-radius: 8px; }
  .prompt-cell { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .num { font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<h1>Feishu Bridge — Sessions Dashboard</h1>
<div class="subtitle">
  <span class="live">Auto-refresh every 5s</span>
  <span id="updated"></span>
</div>

<h2>Chat bindings (<span id="chat-count">0</span>)</h2>
<div id="chats"></div>

<h2>Scheduled cron tasks (<span id="cron-count">0</span>)</h2>
<div id="crons"></div>

<script>
function fmtRelative(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const delta = Date.now() - t;
  if (delta < 0) return new Date(t).toLocaleString();
  if (delta < 60_000) return Math.floor(delta / 1000) + 's ago';
  if (delta < 3_600_000) return Math.floor(delta / 60_000) + 'm ago';
  if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + 'h ago';
  return Math.floor(delta / 86_400_000) + 'd ago';
}
function short(s, n) { if (!s) return ''; return s.length > n ? s.slice(0, n) + '…' : s; }
function escape(s) { return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function renderChats(chats) {
  document.getElementById('chat-count').textContent = chats.length;
  if (chats.length === 0) {
    document.getElementById('chats').innerHTML = '<div class="empty">No chat bindings yet. Send a message to the bot in any Feishu chat to create one.</div>';
    return;
  }
  const rows = chats.map(c => {
    const sidLines = [];
    if (c.activeSessionId) {
      sidLines.push('<div><span class="label">' + escape(c.agent) + ':</span> <code>' + escape(short(c.activeSessionId, 14)) + '</code> <span class="badge active">active</span></div>');
    }
    for (const [backend, sid] of Object.entries(c.parkedSessions || {})) {
      sidLines.push('<div><span class="label">' + escape(backend) + ':</span> <code>' + escape(short(sid, 14)) + '</code> <span class="badge">parked</span></div>');
    }
    if (sidLines.length === 0) sidLines.push('<span class="muted">(none yet)</span>');
    const chatLabel = c.chatName ? escape(c.chatName) : '<span class="muted">' + escape(short(c.chatId, 18)) + '</span>';
    return '<tr>' +
      '<td><div><strong>' + chatLabel + '</strong></div><code class="muted">' + escape(short(c.chatId, 24)) + '</code></td>' +
      '<td><span class="agent ' + escape(c.agent) + '">' + escape(c.agent) + '</span></td>' +
      '<td><code>' + escape(c.cwd || '~') + '</code></td>' +
      '<td>' + escape(c.mode || '') + '</td>' +
      '<td class="num">' + (c.messageCount ?? 0) + '</td>' +
      '<td>' + fmtRelative(c.updatedAt) + '</td>' +
      '<td><div class="sid-list">' + sidLines.join('') + '</div></td>' +
      '</tr>';
  }).join('');
  document.getElementById('chats').innerHTML =
    '<table><thead><tr><th>Chat</th><th>Agent</th><th>CWD</th><th>Mode</th><th>Msgs</th><th>Updated</th><th>Sessions</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderCrons(crons) {
  document.getElementById('cron-count').textContent = crons.length;
  if (crons.length === 0) {
    document.getElementById('crons').innerHTML = '<div class="empty">No cron tasks scheduled. Use /cron add &quot;&lt;5-field cron&gt;&quot; &lt;prompt&gt; in Feishu.</div>';
    return;
  }
  const rows = crons.map(t =>
    '<tr>' +
      '<td><code>' + escape(t.id) + '</code></td>' +
      '<td><code>' + escape(t.cron) + '</code> ' + (t.enabled ? '' : '<span class="badge disabled">paused</span>') + '</td>' +
      '<td>' + (t.name ? '<strong>' + escape(t.name) + '</strong><br>' : '') + '<span class="prompt-cell muted" title="' + escape(t.prompt) + '">' + escape(short(t.prompt, 60)) + '</span></td>' +
      '<td><code>' + escape(short(t.chatId, 18)) + '</code></td>' +
      '<td>' + (t.nextFireAt ? fmtRelative(t.nextFireAt) : '—') + '</td>' +
      '<td>' + (t.lastFiredAt ? fmtRelative(new Date(t.lastFiredAt).toISOString()) : 'never') + '</td>' +
    '</tr>'
  ).join('');
  document.getElementById('crons').innerHTML =
    '<table><thead><tr><th>ID</th><th>Cron</th><th>Prompt</th><th>Target chat</th><th>Next fire</th><th>Last fired</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

async function refresh() {
  try {
    const r = await fetch('/api/dashboard.json');
    const data = await r.json();
    document.getElementById('updated').textContent = 'Last refresh: ' + new Date(data.generatedAt).toLocaleTimeString();
    renderChats(data.chats || []);
    renderCrons(data.scheduled || []);
  } catch (e) {
    document.getElementById('updated').textContent = 'Refresh failed: ' + String(e);
  }
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
