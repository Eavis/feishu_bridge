/**
 * Entry point for the Feishu Bridge (hybrid) daemon.
 *
 * Assembles AppContext with a lazy multi-backend provider factory,
 * eager-preflights only the configured default agent, starts FeishuClient, runs
 * the bridge loop, and handles graceful shutdown.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { loadConfig, CTI_HOME } from './config.js';
import type { AppContext } from './types.js';
import { JsonFileStore } from './store.js';
import { createProviderFactory } from './provider-factory.js';
import { PendingPermissions } from './permissions.js';
import { FeishuClient } from './feishu.js';
import { OutboxServer } from './outbox-server.js';
import { Scheduler } from './scheduler.js';
import { setupLogger } from './logger.js';
import { getActiveTaskCount, getCommandHealth, hasActiveTasks, runBridgeLoop } from './bridge.js';
import { WsHealthWatchdog } from './ws-health.js';
import { shouldRecycleIdleDaemon } from './task-health.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  // Keep atomic rename, but avoid collisions if PM2 accidentally has more
  // than one bridge instance writing status at the same time.
  const tmp = `${STATUS_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[feishu-bridge] Starting (run_id: ${runId}, default agent: ${config.defaultAgent})`);

  if (!config.feishuAppId || !config.feishuAppSecret) {
    console.error('[feishu-bridge] FATAL: CTI_FEISHU_APP_ID and CTI_FEISHU_APP_SECRET must be set in config.env');
    process.exit(1);
  }

  const store = new JsonFileStore(config);
  const pendingPerms = new PendingPermissions();

  // Eager-preflight the default agent so startup fails fast with a clear error
  // if its CLI is missing/broken. The non-default agent stays lazy.
  let providerFactory;
  try {
    providerFactory = createProviderFactory(config, pendingPerms, {
      eagerPreflight: config.defaultAgent,
    });
    const defaultProvider = providerFactory(config.defaultAgent);
    if (defaultProvider.preflight) {
      const live = await defaultProvider.preflight();
      if (!live.ok) throw new Error(live.error || 'live provider preflight failed');
      console.log(`[provider-factory] ${config.defaultAgent} live preflight ready (${live.version || 'ok'})`);
    }
  } catch (err) {
    console.error(
      `[feishu-bridge] FATAL: Default agent "${config.defaultAgent}" failed preflight.\n` +
      `  ${err instanceof Error ? err.message : String(err)}\n` +
      `  Fix: start/configure the required backend, or set CTI_DEFAULT_AGENT to another backend in config.env.`,
    );
    process.exit(1);
  }

  const feishu = new FeishuClient(config);
  const processStartedAt = new Date().toISOString();
  const outbox = new OutboxServer(feishu, config.outboxPort, () => ({
    ws: feishu.getWsConnectionHealth(),
    activeTasks: getActiveTaskCount(),
    startedAt: processStartedAt,
    lastInboundEventAt: feishu.getLastInboundEventAt(),
    commands: getCommandHealth(),
  }));

  const ctx: AppContext = {
    config,
    store,
    providerFactory,
    permissions: pendingPerms,
    feishu,
    outbox,
  };

  const scheduler = new Scheduler(ctx);
  ctx.scheduler = scheduler;
  outbox.scheduler = scheduler;
  outbox.store = store;

  await feishu.start();

  try {
    await outbox.start();
  } catch (err) {
    throw new Error(`Health/outbox server failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }

  scheduler.start();

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
  writeStatus({
    running: true,
    pid: process.pid,
    runId,
    startedAt: processStartedAt,
    lastExitReason: '',
  });

  console.log(`[feishu-bridge] Bridge started (PID: ${process.pid})`);

  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[feishu-bridge] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    try { scheduler.stop(); } catch { /* ignore */ }
    try { outbox.stop(); } catch { /* ignore */ }
    await feishu.stop();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  process.on('unhandledRejection', (reason) => {
    console.error('[feishu-bridge] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[feishu-bridge] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });

  setInterval(() => { /* keepalive */ }, 45_000);

  // SDK pingTimeout handles half-open sockets. This outer watchdog handles a
  // reconnect loop that becomes terminal or remains unhealthy too long.
  const HEALTH_CHECK_INTERVAL = 30 * 1000;
  const wsWatchdog = new WsHealthWatchdog(2 * 60 * 1000);
  const daemonStartedAt = Date.now();

  setInterval(() => {
    const commands = getCommandHealth();
    if (commands.stalled) {
      const reason = `watchdog: command stalled for ${Math.round(commands.oldestActiveMs / 1000)}s`;
      console.error(`[watchdog] ${reason}; exiting for process-manager restart`);
      writeStatus({ running: false, lastExitReason: reason });
      process.exit(1);
    }
    const decision = wsWatchdog.inspect(feishu.getWsConnectionHealth());
    if (decision.healthy) return;
    if (decision.shouldRestart) {
      const reason = `watchdog: WebSocket ${decision.reason} for ${Math.round(decision.unhealthyForMs / 1000)}s`;
      console.error(`[watchdog] ${reason}; exiting for process-manager restart`);
      writeStatus({ running: false, lastExitReason: reason });
      process.exit(1);
    }
    console.warn(`[watchdog] WebSocket ${decision.reason}; unhealthy for ${Math.round(decision.unhealthyForMs / 1000)}s`);
  }, HEALTH_CHECK_INTERVAL);

  // The Feishu SDK can report `connected` while delivering no inbound events,
  // including after successful pong checks. Recycle hourly while idle so this
  // false-health cannot persist. Live turns defer until a later check.
  const MAX_DAEMON_AGE_MS = 60 * 60 * 1000;
  const MAINTENANCE_CHECK_MS = 60 * 1000;
  setInterval(() => {
    if (!shouldRecycleIdleDaemon(daemonStartedAt, Date.now(), hasActiveTasks(), MAX_DAEMON_AGE_MS)) return;
    const reason = 'maintenance: hourly idle recycle to prevent stale Feishu WebSocket';
    console.warn(`[watchdog] ${reason}; exiting for process-manager restart`);
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  }, MAINTENANCE_CHECK_MS);

  await runBridgeLoop(ctx);
}

main().catch((err) => {
  console.error('[feishu-bridge] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
