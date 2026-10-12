import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { Client, defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { createFeishuHttpClient } from '../feishu-http.js';
import { getCommandHealth, hasActiveTasks, runBridgeLoop } from '../bridge.js';
import { OutboxServer } from '../outbox-server.js';
import { CodexProvider } from '../codex-provider.js';
import { processMessage } from '../conversation.js';

async function localApi(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

test('private Feishu transport bounds hung REST and token requests without changing the SDK singleton', { timeout: 5000 }, async () => {
  const originalTimeout = defaultHttpInstance.defaults.timeout;
  const api = await localApi(req => { req.resume(); });
  const transport = createFeishuHttpClient(40);
  transport.interceptors.request.use(request => {
    request.url = `${api.origin}${new URL(request.url!).pathname}`;
    return request;
  });
  try {
    await assert.rejects(transport.get(`${api.origin}/hung`));
    const sdk = new Client({
      appId: 'deadline-test', appSecret: 'fake', httpInstance: transport,
      logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} },
    });
    await assert.rejects(sdk.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'fake-chat', msg_type: 'text', content: '{}' },
    }));
    assert.equal(defaultHttpInstance.defaults.timeout, originalTimeout);
  } finally { await api.close(); }
});

test('Feishu transport preserves SDK response shapes and terminates a stalled download', { timeout: 5000 }, async () => {
  const api = await localApi((req, res) => {
    req.resume();
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write('partial');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-test', 'present');
    res.end(JSON.stringify({ code: 0, data: { ok: true } }));
  });
  const transport = createFeishuHttpClient(80);
  try {
    const plain = await transport.get(`${api.origin}/json`);
    assert.deepEqual(plain, { code: 0, data: { ok: true } });
    const wrapped = await transport.get(`${api.origin}/json`, { $return_headers: true } as any);
    assert.equal(wrapped.headers['x-test'], 'present');
    assert.equal(wrapped.data.code, 0);
    const stream = await transport.get(`${api.origin}/stream`, { responseType: 'stream' });
    await assert.rejects(async () => { for await (const _chunk of stream as any) { /* drain */ } });
  } finally { await api.close(); }
});

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= end) throw new Error('condition did not become true');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('stalled commands preserve chat order without blocking other chats or permission controls', { timeout: 5000 }, async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let running = true;
  let permissionResolved = false;
  const sent: string[] = [];
  const messages = [
    { chatId: 'a', messageId: 'first', text: '/whoami' },
    { chatId: 'a', messageId: 'second', text: '/whoami' },
    { chatId: 'b', messageId: 'other-chat', text: '/whoami' },
    { chatId: 'a', messageId: 'permission', text: '', callbackData: 'perm:deny:pending' },
  ];
  const ctx = {
    feishu: {
      isRunning: () => running,
      consumeOne: async () => {
        const msg = messages.shift();
        if (!msg) running = false;
        return msg ? { ...msg, userId: 'fake-user', timestamp: Date.now() } : null;
      },
      send: async (_chat: string, text: string, _mode: string, reply?: string) => {
        if (reply) sent.push(reply);
        if (reply === 'first') await blocked;
        return { ok: true, messageId: `reply-${reply || text.length}` };
      },
    },
    store: {
      insertAuditLog() {}, cleanupExpiredDedup() {},
      getPermissionLink: () => ({ chatId: 'a', resolved: false }),
      markPermissionLinkResolved: () => true,
    },
    permissions: { resolve: () => { permissionResolved = true; return true; } },
  } as any;
  const server = new OutboxServer({ isRunning: () => true } as any, 0, () => ({
    ws: { state: 'connected' }, activeTasks: 0, startedAt: new Date().toISOString(),
    lastInboundEventAt: Date.now(), commands: getCommandHealth(Date.now() + 301_000),
  }));
  const port = await server.start();
  try {
    await runBridgeLoop(ctx);
    await until(() => sent.includes('other-chat') && permissionResolved);
    assert.ok(!sent.includes('second'), 'same-chat commands must remain ordered');
    assert.ok(hasActiveTasks(), 'maintenance must defer while a command is pending');
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 503, 'a stalled command must not look healthy');
    assert.equal((await health.json() as any).commands.stalled, true);
  } finally {
    release();
    await until(() => getCommandHealth().pendingMessages === 0);
    server.stop();
  }
  assert.ok(sent.includes('second'));
  assert.equal(hasActiveTasks(), false);
  assert.equal(getCommandHealth().stalled, false);
});

test('failed command does not poison the next command in that chat', { timeout: 5000 }, async () => {
  let running = true;
  let count = 0;
  const sent: string[] = [];
  const ctx = {
    feishu: {
      isRunning: () => running,
      consumeOne: async () => {
        if (++count > 2) { running = false; return null; }
        return { chatId: 'failure', messageId: `${count}`, text: '/whoami', userId: 'u' };
      },
      send: async (_chat: string, _text: string, _mode: string, id: string) => {
        sent.push(id);
        if (id === '1') throw new Error('injected send failure');
        return { ok: true };
      },
    },
    store: { insertAuditLog() {}, cleanupExpiredDedup() {} },
  } as any;
  await runBridgeLoop(ctx);
  await until(() => getCommandHealth().pendingMessages === 0);
  assert.deepEqual(sent, ['1', '2']);
});

async function runCodexFixture(ending: 'completed' | 'failed' | 'silent' | 'exit') {
  const script = `
    process.stdin.resume();
    process.stdin.on('end', () => {
      const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
      emit({ type: 'thread.started', thread_id: 'fixture-' + process.pid });
      emit({ type: 'item.completed', item: { id: 'narration', type: 'agent_message', text: 'First step. ' } });
      setTimeout(() => {
        emit({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Saved answer.' } });
        const ending = ${JSON.stringify(ending)};
        if (ending === 'failed') emit({ type: 'turn.failed', error: { message: 'Fixture upstream failure' } });
        if (ending === 'completed' || ending === 'exit') {
          const result = { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } };
          if (ending === 'exit') { process.stdout.write(JSON.stringify(result)); return; }
          emit(result);
        }
        setInterval(() => {}, 1000);
      }, 20);
    });
  `;
  const provider = new CodexProvider(
    { executable: process.execPath, prefixArgs: ['-e', script, '--'] },
    { baseUrl: 'http://127.0.0.1:1', authEnvKey: 'PATH' }, 'fixture-model', [],
  );
  let released = false;
  let threadId = '';
  const saved: Array<{ role: string; content: string; usage?: string }> = [];
  const ctx = {
    config: { defaultAgent: 'codex', agentFirstEventTimeoutMs: 2000, agentIdleTimeoutMs: 250, agentMaxTurnTimeoutMs: 4000 },
    providerFactory: () => provider,
    store: {
      acquireSessionLock: () => true, renewSessionLock() {}, getSession: () => ({}),
      releaseSessionLock: () => { released = true; },
      addMessage: (_id: string, role: string, content: string, usage?: string) => { saved.push({ role, content, usage }); },
      updateSdkSessionId: (_id: string, id: string) => { threadId = id; }, updateSessionModel() {},
    },
  } as any;
  const result = await processMessage(ctx, {
    codepilotSessionId: 'fixture-session', agent: 'codex', mode: 'code', workingDirectory: process.cwd(),
  } as any, 'Fixture only; no model or network access');
  const pid = Number(threadId.replace('fixture-', ''));
  assert.ok(Number.isInteger(pid) && pid > 0, 'fixture child must announce its PID');
  // Both cancellation and completion must reap a child that keeps its pipes open.
  const deadline = Date.now() + 6000;
  let exited = false;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { exited = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!exited) { try { process.kill(pid); } catch { /* already gone */ } }
  assert.ok(exited, 'finished fixture process must be cleaned up');
  assert.ok(released, 'conversation session lock must be released');
  return { result, saved, threadId };
}

test('Codex completion preserves the answer and usage even if the CLI never exits', { timeout: 10000 }, async () => {
  const { result, saved, threadId } = await runCodexFixture('completed');
  assert.equal(result.hasError, false, result.errorMessage);
  assert.equal(result.responseText, 'First step. Saved answer.');
  assert.equal(result.sdkSessionId, threadId);
  assert.equal(result.tokenUsage?.output_tokens, 4);
  assert.equal(saved.at(-1)?.content, result.responseText);
  assert.equal(JSON.parse(saved.at(-1)!.usage!).output_tokens, 4);
});

test('Codex terminal failure keeps its original error even if the CLI never exits', { timeout: 10000 }, async () => {
  const { result } = await runCodexFixture('failed');
  assert.equal(result.hasError, true);
  assert.equal(result.errorMessage, 'Fixture upstream failure');
  assert.equal(result.responseText, 'First step. Saved answer.');
});

test('Codex completion accepts a final JSON line without a newline on natural exit', { timeout: 10000 }, async () => {
  const { result } = await runCodexFixture('exit');
  assert.equal(result.hasError, false, result.errorMessage);
  assert.equal(result.responseText, 'First step. Saved answer.');
  assert.equal(result.tokenUsage?.output_tokens, 4);
});

test('a genuinely silent Codex turn retains partial output when it times out', { timeout: 10000 }, async () => {
  const { result, saved } = await runCodexFixture('silent');
  assert.equal(result.hasError, true);
  assert.match(result.errorMessage || '', /stream was silent/);
  assert.equal(result.responseText, 'First step. Saved answer.');
  assert.equal(saved.at(-1)?.content, result.responseText);
});
