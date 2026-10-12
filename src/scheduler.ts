/**
 * Scheduler — cron-driven task runner for the bridge.
 *
 * Loads scheduled tasks from .bridge/data/scheduled.json on startup, ticks
 * once per minute, and for each due task synthesizes an InboundMessage that
 * goes through the normal bridge loop. This means a triggered task runs
 * exactly the same path as a real user message: full Claude session with
 * tools, MCP servers, streaming card delivery — except sourced from the
 * scheduler instead of WebSocket.
 *
 * State is persisted on every mutation; restart resumes silently (no
 * catch-up firing for tasks missed while bridge was down).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type { AppContext, InboundMessage } from './types.js';
import { CTI_HOME } from './config.js';

const SCHEDULED_FILE = path.join(CTI_HOME, 'data', 'scheduled.json');

export interface ScheduledTask {
  id: string;
  cron: string;
  /** Prompt text to send as if a user typed it. */
  prompt: string;
  /** Target chat for the response and command. */
  chatId: string;
  /** Whether the task is active. Pause = false. */
  enabled: boolean;
  /** Optional human-readable name. */
  name?: string;
  createdAt: string;
  /** Last time the task fired (epoch ms). Used for missed-fire detection / display. */
  lastFiredAt?: number;
  /** Cached next fire time (epoch ms) to avoid recomputing every tick. */
  nextFireAt?: number;
}

export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private ctx: AppContext) {}

  // ── Persistence ───────────────────────────────────────────────

  private load(): void {
    try {
      if (!fs.existsSync(SCHEDULED_FILE)) return;
      const raw = fs.readFileSync(SCHEDULED_FILE, 'utf-8');
      const arr = JSON.parse(raw) as ScheduledTask[];
      for (const t of arr) {
        // Recompute nextFireAt on load — saved value may be stale across restarts.
        t.nextFireAt = this.computeNext(t.cron);
        this.tasks.set(t.id, t);
      }
      console.log(`[scheduler] loaded ${this.tasks.size} task(s) from disk`);
    } catch (e) {
      console.warn('[scheduler] load failed:', e instanceof Error ? e.message : e);
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(SCHEDULED_FILE), { recursive: true });
      const tmp = SCHEDULED_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...this.tasks.values()], null, 2), 'utf-8');
      fs.renameSync(tmp, SCHEDULED_FILE);
    } catch (e) {
      console.error('[scheduler] persist failed:', e instanceof Error ? e.message : e);
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────

  start(): void {
    this.load();
    // Tick every 30s — cron resolution is 1 minute, 30s gives margin for clock drift.
    this.timer = setInterval(() => { this.tick().catch((e) => console.error('[scheduler] tick error:', e)); }, 30_000);
    if (this.timer && typeof (this.timer as any).unref === 'function') {
      (this.timer as any).unref();
    }
    console.log('[scheduler] started (tick=30s)');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── CRUD ─────────────────────────────────────────────────────

  add(input: { cron: string; prompt: string; chatId: string; name?: string }): { ok: boolean; task?: ScheduledTask; error?: string } {
    let nextFireAt: number;
    try {
      nextFireAt = this.computeNext(input.cron);
    } catch (e) {
      return { ok: false, error: `Invalid cron expression: ${e instanceof Error ? e.message : String(e)}` };
    }
    const task: ScheduledTask = {
      id: crypto.randomBytes(4).toString('hex'),
      cron: input.cron,
      prompt: input.prompt,
      chatId: input.chatId,
      enabled: true,
      name: input.name,
      createdAt: new Date().toISOString(),
      nextFireAt,
    };
    this.tasks.set(task.id, task);
    this.persist();
    return { ok: true, task };
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()].sort((a, b) => (a.nextFireAt ?? Infinity) - (b.nextFireAt ?? Infinity));
  }

  get(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  delete(id: string): boolean {
    const ok = this.tasks.delete(id);
    if (ok) this.persist();
    return ok;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    t.enabled = enabled;
    if (enabled && !t.nextFireAt) t.nextFireAt = this.computeNext(t.cron);
    this.persist();
    return true;
  }

  // ── Internals ────────────────────────────────────────────────

  private computeNext(cronExpr: string): number {
    const interval = CronExpressionParser.parse(cronExpr);
    return interval.next().getTime();
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;
      if (!task.nextFireAt || now < task.nextFireAt) continue;

      // Fire — synthesize an inbound message and let the bridge handle it.
      console.log(`[scheduler] firing task ${task.id} (${task.name || task.cron}) → chat ${task.chatId}`);
      try {
        const msg: InboundMessage = {
          // Empty messageId — scheduler-originated. FeishuClient's reply paths
          // and lastIncomingMessageId tracker check for truthy strings, so an
          // empty string causes them to fall through to create instead of
          // calling im.message.reply with a fake id (which Feishu rejects 400).
          messageId: '',
          chatId: task.chatId,
          // Use the bot's open_id as the sender so authorization passes; this
          // also signals "system-originated" to anything that inspects userId.
          userId: '__scheduler__',
          text: task.prompt,
          timestamp: now,
        };
        this.ctx.feishu.injectInboundMessage(msg);
      } catch (e) {
        console.error(`[scheduler] failed to inject task ${task.id}:`, e instanceof Error ? e.message : e);
      }

      task.lastFiredAt = now;
      try {
        task.nextFireAt = this.computeNext(task.cron);
      } catch {
        task.nextFireAt = undefined;
        task.enabled = false;
      }
    }
    this.persist();
  }
}
