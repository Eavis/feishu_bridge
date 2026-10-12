/**
 * Unit tests for feishu-claude-bridge-v2.
 * Tests pure-logic modules without requiring Feishu or Claude connections.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('websocket health watchdog', async () => {
  const { WsHealthWatchdog } = await import('../ws-health.js');

  test('treats connected as healthy and resets a prior outage', () => {
    const watchdog = new WsHealthWatchdog(1_000);
    watchdog.inspect({ state: 'reconnecting', reconnectAttempts: 1 }, 1_000);
    assert.equal(watchdog.inspect({ state: 'connected' }, 1_500).healthy, true);
    const again = watchdog.inspect({ state: 'idle' }, 10_000);
    assert.equal(again.unhealthyForMs, 0);
    assert.equal(again.shouldRestart, false);
  });

  test('restarts immediately on terminal SDK failure', () => {
    const decision = new WsHealthWatchdog(60_000).inspect({ state: 'failed', reconnectAttempts: 3 }, 1_000);
    assert.equal(decision.shouldRestart, true);
    assert.match(decision.reason, /failed.*3 reconnect attempts/);
  });

  test('allows reconnect grace then restarts a stuck connection', () => {
    const watchdog = new WsHealthWatchdog(1_000);
    assert.equal(watchdog.inspect({ state: 'reconnecting' }, 1_000).shouldRestart, false);
    assert.equal(watchdog.inspect({ state: 'reconnecting' }, 1_999).shouldRestart, false);
    assert.equal(watchdog.inspect({ state: 'reconnecting' }, 2_000).shouldRestart, true);
  });
});

describe('aborted task watchdog', async () => {
  const { armAbortedTaskWatchdog, shouldRecycleIdleDaemon } = await import('../task-health.js');

  test('forces recovery when an aborted task remains active', async () => {
    const controller = new AbortController();
    controller.abort();
    let recovered = false;
    armAbortedTaskWatchdog(controller, () => true, () => { recovered = true; }, 5);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(recovered, true);
  });

  test('does nothing when the aborted task finishes during grace', async () => {
    const controller = new AbortController();
    controller.abort();
    let active = true;
    let recovered = false;
    armAbortedTaskWatchdog(controller, () => active, () => { recovered = true; }, 10);
    active = false;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(recovered, false);
  });

  test('recycles an aged idle daemon but defers while a task is active', () => {
    assert.equal(shouldRecycleIdleDaemon(1_000, 61_000, false, 60_000), true);
    assert.equal(shouldRecycleIdleDaemon(1_000, 61_000, true, 60_000), false);
    assert.equal(shouldRecycleIdleDaemon(1_000, 60_999, false, 60_000), false);
  });
});

describe('agent stream deadlines', async () => {
  const { AgentStreamTimeoutError, readWithStreamDeadline, StreamDeadlinePolicy } = await import('../stream-health.js');

  test('enforces first-event, idle, and absolute deadlines', () => {
    const p = new StreamDeadlinePolicy(1_000, 2_000, 5_000, 20_000);
    assert.equal(p.nextWaitMs(1_000), 2_000);
    assert.match(p.timeoutMessage(3_000), /no event/i);
    p.markActivity(2_000);
    assert.equal(p.nextWaitMs(3_000), 4_000);
    assert.match(p.timeoutMessage(7_000), /silent/i);
    p.markActivity(19_500);
    assert.equal(p.nextWaitMs(19_500), 1_500);
    assert.match(p.timeoutMessage(21_000), /maximum/i);
  });

  test('rejects a real stream read that never produces an event', async () => {
    const stream = new ReadableStream<string>({ start() { /* deliberately silent */ } });
    const policy = new StreamDeadlinePolicy(Date.now(), 10, 50, 100);
    await assert.rejects(readWithStreamDeadline(stream.getReader(), policy), AgentStreamTimeoutError);
  });
});

test('Codex stream closes immediately on abort even if the child never exits cleanly', async () => {
  const { CodexProvider } = await import('../codex-provider.js');
  const abortController = new AbortController();
  const provider = new CodexProvider(
    { executable: process.execPath, prefixArgs: ['-e', 'setInterval(() => {}, 1000)'] },
    { baseUrl: 'http://127.0.0.1:1', authEnvKey: 'PATH' },
    'test-model',
    [],
  );
  const reader = provider.streamChat({
    prompt: 'hang', sessionId: 'test', workingDirectory: process.cwd(), abortController,
  }).getReader();
  abortController.abort();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(first.value || '', /Task stopped by user/);
  const second = await reader.read();
  assert.equal(second.done, true);
});

test('Codex fresh retry is limited to safe pre-output resume failures', async () => {
  const { shouldRetryCodexFresh } = await import('../bridge.js');
  const base = { agent: 'codex', sdkSessionId: 'old', hasError: true, responseText: '', toolCount: 0, aborted: false };
  assert.equal(shouldRetryCodexFresh(base), true);
  assert.equal(shouldRetryCodexFresh({ ...base, toolCount: 1 }), false);
  assert.equal(shouldRetryCodexFresh({ ...base, responseText: 'partial' }), false);
  assert.equal(shouldRetryCodexFresh({ ...base, aborted: true }), false);
  assert.equal(shouldRetryCodexFresh({ ...base, agent: 'eureka' }), false);
});

test('outbox health endpoint reflects real websocket state', async () => {
  const { OutboxServer } = await import('../outbox-server.js');
  let state = 'connected';
  const fakeFeishu = { isRunning: () => true } as any;
  const server = new OutboxServer(fakeFeishu, 0, () => ({
    ws: { state } as any,
    activeTasks: 0,
    startedAt: new Date().toISOString(),
    lastInboundEventAt: null,
  }));
  const port = await server.start();
  try {
    const healthy = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthy.status, 200);
    assert.equal((await healthy.json() as any).ok, true);
    state = 'reconnecting';
    const unhealthy = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(unhealthy.status, 503);
    assert.equal((await unhealthy.json() as any).ok, false);
  } finally {
    server.stop();
  }
});

// ── Config ──────────────────────────────────────────────────

describe('config', async () => {
  const { loadConfig, CTI_HOME } = await import('../config.js');

  test('loadConfig returns typed config without requiring private credentials', () => {
    const config = loadConfig();
    assert.equal(typeof config.feishuAppId, 'string');
    assert.equal(typeof config.feishuAppSecret, 'string');
    assert.equal(typeof config.defaultWorkDir, 'string');
    assert.equal(typeof config.defaultMode, 'string');
    assert.equal(typeof config.feishuRequireMention, 'boolean');
  });

  test('CTI_HOME is set', () => {
    assert.ok(CTI_HOME, 'CTI_HOME should be defined');
  });
});

// ── Validators ──────────────────────────────────────────────

describe('validators', async () => {
  const path = await import('node:path');
  const {
    validateWorkingDirectory,
    validateSessionId,
    isDangerousInput,
    sanitizeInput,
    validateMode,
  } = await import('../validators.js');

  test('validateWorkingDirectory accepts absolute paths', () => {
    assert.equal(validateWorkingDirectory('/Users/test'), path.normalize('/Users/test'));
    assert.equal(validateWorkingDirectory('/tmp'), path.normalize('/tmp'));
  });

  test('validateWorkingDirectory rejects relative paths', () => {
    assert.equal(validateWorkingDirectory('relative/path'), null);
  });

  test('validateWorkingDirectory rejects traversal', () => {
    assert.equal(validateWorkingDirectory('/foo/../bar'), null);
  });

  test('validateWorkingDirectory rejects empty', () => {
    assert.equal(validateWorkingDirectory(''), null);
  });

  test('validateSessionId accepts valid UUIDs', () => {
    assert.ok(validateSessionId('a1b2c3d4-e5f6-7890-abcd-ef1234567890'));
    assert.ok(validateSessionId('a1b2c3d4e5f67890abcdef1234567890'));
  });

  test('validateSessionId rejects short strings', () => {
    assert.ok(!validateSessionId('abc'));
    assert.ok(!validateSessionId(''));
  });

  test('isDangerousInput flags null bytes', () => {
    const result = isDangerousInput('hello\x00world');
    assert.ok(result.dangerous);
  });

  test('isDangerousInput flags command substitution', () => {
    const result = isDangerousInput('$(rm -rf /)');
    assert.ok(result.dangerous);
  });

  test('isDangerousInput passes normal text', () => {
    const result = isDangerousInput('Hello Claude, please help me write a function');
    assert.ok(!result.dangerous);
  });

  test('sanitizeInput truncates long input', () => {
    const long = 'a'.repeat(50000);
    const { text, truncated } = sanitizeInput(long, 1000);
    assert.equal(text.length, 1000);
    assert.ok(truncated);
  });

  test('sanitizeInput strips control chars', () => {
    const { text } = sanitizeInput('hello\x00\x01world');
    assert.equal(text, 'helloworld');
  });

  test('validateMode accepts valid modes', () => {
    assert.ok(validateMode('code'));
    assert.ok(validateMode('plan'));
    assert.ok(validateMode('ask'));
  });

  test('validateMode rejects invalid modes', () => {
    assert.ok(!validateMode('invalid'));
    assert.ok(!validateMode(''));
  });
});

// ── Feishu Markdown ─────────────────────────────────────────

describe('feishu-markdown', async () => {
  const {
    hasComplexMarkdown,
    preprocessFeishuMarkdown,
    buildCardContent,
    buildPostContent,
    htmlToFeishuMarkdown,
    buildToolProgressMarkdown,
    formatElapsed,
    formatTokenCount,
    buildStreamingContent,
    buildFinalCardJson,
    buildPermissionButtonCard,
  } = await import('../feishu-markdown.js');

  test('hasComplexMarkdown detects code blocks', () => {
    assert.ok(hasComplexMarkdown('```js\nconst x = 1;\n```'));
    assert.ok(!hasComplexMarkdown('simple text'));
  });

  test('hasComplexMarkdown detects tables', () => {
    assert.ok(hasComplexMarkdown('| A | B |\n|---|---|\n| 1 | 2 |'));
    assert.ok(!hasComplexMarkdown('just | a | pipe'));
  });

  test('preprocessFeishuMarkdown ensures newline before code fences', () => {
    const result = preprocessFeishuMarkdown('text```code```');
    assert.ok(result.includes('text\n```'));
  });

  test('buildCardContent returns valid JSON', () => {
    const json = buildCardContent('hello');
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema, '2.0');
    assert.ok(parsed.body.elements[0].content.includes('hello'));
  });

  test('buildPostContent returns valid post JSON', () => {
    const json = buildPostContent('hello');
    const parsed = JSON.parse(json);
    assert.ok(parsed.zh_cn);
    assert.ok(parsed.zh_cn.content[0][0].text === 'hello');
  });

  test('htmlToFeishuMarkdown converts HTML tags', () => {
    assert.equal(htmlToFeishuMarkdown('<b>bold</b>'), '**bold**');
    assert.equal(htmlToFeishuMarkdown('<i>italic</i>'), '*italic*');
    assert.equal(htmlToFeishuMarkdown('<code>code</code>'), '`code`');
    assert.ok(htmlToFeishuMarkdown('&amp;').includes('&'));
  });

  test('formatElapsed handles milliseconds', () => {
    assert.equal(formatElapsed(500), '500ms');
  });

  test('formatElapsed handles seconds', () => {
    assert.equal(formatElapsed(1500), '1.5s');
  });

  test('formatElapsed handles minutes', () => {
    assert.match(formatElapsed(125000), /2m/);
  });

  test('formatTokenCount formats thousands', () => {
    assert.equal(formatTokenCount(500), '500');
    assert.equal(formatTokenCount(1500), '1.5K');
    assert.equal(formatTokenCount(15000), '15K');
  });

  test('buildToolProgressMarkdown renders tool list', () => {
    const md = buildToolProgressMarkdown([
      { id: '1', name: 'Read', status: 'complete' },
      { id: '2', name: 'Write', status: 'running' },
    ]);
    assert.ok(md.includes('✅'));
    assert.ok(md.includes('🔄'));
    assert.ok(md.includes('Read'));
    assert.ok(md.includes('Write'));
  });

  test('buildStreamingContent returns thinking placeholder when empty', () => {
    assert.equal(buildStreamingContent('', []), '💭 Thinking...');
  });

  test('buildStreamingContent includes text and tools', () => {
    const content = buildStreamingContent('hello', [
      { id: '1', name: 'Read', status: 'running' },
    ]);
    assert.ok(content.includes('hello'));
    assert.ok(content.includes('Read'));
  });

  test('buildFinalCardJson returns valid card JSON', () => {
    const json = buildFinalCardJson('response text', [], {
      status: '✅ Completed',
      elapsed: '2.1s',
      tokens: '↓1K ↑500',
    });
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema, '2.0');
    assert.ok(parsed.body.elements.length >= 1);
  });

  test('buildPermissionButtonCard returns valid card with buttons', () => {
    const json = buildPermissionButtonCard('**Permission**\nTool: `Read`', 'perm-123', 'chat-456');
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema, '2.0');
    assert.ok(parsed.header);
    assert.ok(parsed.body.elements.length > 0);
    // Should contain column_set with buttons
    const columnSet = parsed.body.elements.find((e: any) => e.tag === 'column_set');
    assert.ok(columnSet, 'Should have column_set with buttons');
  });
});

// ── Store ───────────────────────────────────────────────────

describe('store', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');

  // Use a temp directory to avoid touching real data
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  process.env.CTI_HOME = tmpDir;

  // Need to re-import after setting CTI_HOME
  // Actually the store imports CTI_HOME at module load time from config.ts
  // which reads process.env.CTI_HOME. But the module is already cached.
  // Let's test with the real store against a temp config.

  const { loadConfig, CTI_HOME } = await import('../config.js');
  const { JsonFileStore } = await import('../store.js');

  // Create minimal config.env in temp dir
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'data', 'messages'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.env'), 'CTI_DEFAULT_WORKDIR=/tmp\nCTI_DEFAULT_MODE=code\n');

  const config = loadConfig();

  test('JsonFileStore can be constructed', () => {
    const store = new JsonFileStore(config);
    assert.ok(store);
  });

  test('createSession and getSession', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', 'claude-3', undefined, '/tmp');
    assert.ok(session.id);
    assert.equal(session.working_directory, '/tmp');
    assert.equal(session.model, 'claude-3');

    const retrieved = store.getSession(session.id);
    assert.ok(retrieved);
    assert.equal(retrieved!.id, session.id);
  });

  test('upsertChannelBinding and getChannelBinding', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', '', undefined, '/tmp');

    const binding = store.upsertChannelBinding({
      chatId: 'chat-123',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp',
      model: '',
    });

    assert.ok(binding.id);
    assert.equal(binding.chatId, 'chat-123');
    assert.equal(binding.codepilotSessionId, session.id);

    const retrieved = store.getChannelBinding('chat-123');
    assert.ok(retrieved);
    assert.equal(retrieved!.id, binding.id);
  });

  test('updateChannelBinding', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', '', undefined, '/tmp');
    const binding = store.upsertChannelBinding({
      chatId: 'chat-update-test',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp',
      model: '',
    });

    store.updateChannelBinding(binding.id, { mode: 'plan' });
    const updated = store.getChannelBinding('chat-update-test');
    assert.equal(updated!.mode, 'plan');
  });

  test('addMessage and getMessages', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', '', undefined, '/tmp');

    store.addMessage(session.id, 'user', 'hello');
    store.addMessage(session.id, 'assistant', 'hi there');

    const { messages } = store.getMessages(session.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
  });

  test('session lock acquire/release', () => {
    const store = new JsonFileStore(config);
    const ok1 = store.acquireSessionLock('sess-1', 'lock-a', 'bridge', 60);
    assert.ok(ok1);

    // Same lock ID can re-acquire
    const ok2 = store.acquireSessionLock('sess-1', 'lock-a', 'bridge', 60);
    assert.ok(ok2);

    // Different lock ID fails
    const ok3 = store.acquireSessionLock('sess-1', 'lock-b', 'bridge', 60);
    assert.ok(!ok3);

    // After release, different lock can acquire
    store.releaseSessionLock('sess-1', 'lock-a');
    const ok4 = store.acquireSessionLock('sess-1', 'lock-b', 'bridge', 60);
    assert.ok(ok4);
  });

  test('dedup check/insert/cleanup', () => {
    const store = new JsonFileStore(config);
    const key = `test-${Date.now()}-${Math.random()}`;
    assert.ok(!store.checkDedup(key));
    store.insertDedup(key);
    assert.ok(store.checkDedup(key));
    store.cleanupExpiredDedup(); // Shouldn't remove recent dedup
    assert.ok(store.checkDedup(key));
  });

  test('permission links', () => {
    const store = new JsonFileStore(config);
    store.insertPermissionLink({
      permissionRequestId: 'perm-1',
      chatId: 'chat-1',
      messageId: 'msg-1',
      toolName: 'Read',
      suggestions: '',
    });

    const link = store.getPermissionLink('perm-1');
    assert.ok(link);
    assert.equal(link!.chatId, 'chat-1');
    assert.equal(link!.resolved, false);

    const claimed = store.markPermissionLinkResolved('perm-1');
    assert.ok(claimed);

    const claimedAgain = store.markPermissionLinkResolved('perm-1');
    assert.ok(!claimedAgain);

    const pending = store.listPendingPermissionLinksByChat('chat-1');
    assert.equal(pending.length, 0);
  });

  test('audit log', () => {
    const store = new JsonFileStore(config);
    store.insertAuditLog({
      chatId: 'chat-1',
      direction: 'inbound',
      messageId: 'msg-1',
      summary: 'test message',
    });
    const audit = JSON.parse(fs.readFileSync(path.join(CTI_HOME, 'data', 'audit.json'), 'utf8')) as Array<{ summary?: string }>;
    assert.ok(audit.some(entry => entry.summary === 'test message'));
  });

  test('updateSdkSessionId propagates to bindings', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', '', undefined, '/tmp');
    const binding = store.upsertChannelBinding({
      chatId: 'chat-sdk-test',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp',
      model: '',
    });

    store.updateSdkSessionId(session.id, 'sdk-uuid-123');
    const updated = store.getChannelBinding('chat-sdk-test');
    assert.equal(updated!.sdkSessionId, 'sdk-uuid-123');
  });

  // Cleanup
  test('cleanup temp dir', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CTI_HOME;
  });
});

// ── Session Scanner ─────────────────────────────────────────

describe('session-scanner', async () => {
  const { scanCliSessions, formatRelativeTime } = await import('../session-scanner.js');

  test('scanCliSessions returns an array', () => {
    const sessions = scanCliSessions({ limit: 5 });
    assert.ok(Array.isArray(sessions));
    // May or may not find sessions depending on machine state
  });

  test('scanCliSessions returns sessions with expected shape', () => {
    const sessions = scanCliSessions({ limit: 3 });
    for (const s of sessions) {
      assert.ok(typeof s.sdkSessionId === 'string');
      assert.ok(typeof s.project === 'string');
      assert.ok(typeof s.cwd === 'string');
      assert.ok(typeof s.timestamp === 'number');
      assert.ok(typeof s.isOpen === 'boolean');
    }
  });

  test('formatRelativeTime works for recent times', () => {
    assert.ok(formatRelativeTime(Date.now() - 30000).includes('秒前'));
    assert.ok(formatRelativeTime(Date.now() - 300000).includes('分钟前'));
    assert.ok(formatRelativeTime(Date.now() - 7200000).includes('小时前'));
    assert.ok(formatRelativeTime(Date.now() - 172800000).includes('天前'));
  });
});

// ── Delivery (chunking logic) ───────────────────────────────

describe('delivery-chunking', async () => {
  // We can't easily import the private chunkText function, but we can test
  // the exported deliver function with a mock. Instead, let's test
  // the ChatRateLimiter indirectly by accessing it.
  // Actually, let's just verify the module loads without error.
  test('delivery module loads', async () => {
    const mod = await import('../delivery.js');
    assert.ok(typeof mod.deliver === 'function');
  });
});

// ── Claude Provider ─────────────────────────────────────────

describe('claude-provider', async () => {
  const {
    classifyAuthError,
    resolveClaudeCliPath,
    preflightCheck,
    buildSubprocessEnv,
  } = await import('../claude-provider.js');

  test('classifyAuthError detects CLI auth errors', () => {
    assert.equal(classifyAuthError('not logged in'), 'cli');
    assert.equal(classifyAuthError('please run /login'), 'cli');
  });

  test('classifyAuthError detects API auth errors', () => {
    assert.equal(classifyAuthError('unauthorized'), 'api');
    assert.equal(classifyAuthError('invalid api key'), 'api');
    assert.equal(classifyAuthError('401 error'), 'api');
  });

  test('classifyAuthError returns false for normal text', () => {
    assert.equal(classifyAuthError('hello world'), false);
  });

  test('buildSubprocessEnv strips CLAUDECODE', () => {
    process.env.CLAUDECODE = 'test';
    const env = buildSubprocessEnv();
    assert.ok(!('CLAUDECODE' in env));
    delete process.env.CLAUDECODE;
  });

  test('resolveClaudeCliPath finds an installed claude CLI', (t) => {
    const path = resolveClaudeCliPath();
    // Should find it on this machine since claude is installed
    if (!path) { t.skip('optional local Claude CLI is not installed'); return; }
    console.log(`  Found claude CLI at: ${path}`);
  });

  test('preflightCheck passes on found CLI', (t) => {
    const cliPath = resolveClaudeCliPath();
    if (!cliPath) { t.skip('optional local Claude CLI is not installed'); return; }
    const result = preflightCheck(cliPath!);
    assert.ok(result.ok, `Preflight should pass: ${result.error}`);
    console.log(`  Claude CLI version: ${result.version}`);
  });
});

// ── Codex Provider / Session Scanner ──────────────────────

describe('codex-provider', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const {
    DEFAULT_CODEX_MODEL,
    mapCodexEvent,
    preflightCodex,
    resolveCodexLaunchSpec,
    buildSubprocessEnv: buildCodexSubprocessEnv,
    findCodexHomeForThread,
  } = await import('../codex-provider.js');
  const { scanCodexSessions } = await import('../codex-session-scanner.js');

  test('default Codex model is the latest connected GPT-6 Astra id', () => {
    assert.equal(DEFAULT_CODEX_MODEL, 'gpt-6-astra');
  });

  test('maps thread, text, tools, and turn usage to bridge events', () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const emit = (type: string, data: unknown) => events.push({ type, data });
    const state = {
      threadId: undefined as string | undefined,
      model: 'gpt-5.6-luna',
      completed: false,
      sawError: false,
      usage: undefined,
      startedTools: new Set<string>(),
    };
    mapCodexEvent({ type: 'thread.started', thread_id: 'thread-123' }, emit, state);
    mapCodexEvent({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'git status' } }, emit, state);
    mapCodexEvent({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', exit_code: 0, aggregated_output: 'clean' } }, emit, state);
    mapCodexEvent({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '已完成' } }, emit, state);
    mapCodexEvent({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4 } }, emit, state);
    assert.equal(state.threadId, 'thread-123');
    assert.ok(state.completed);
    assert.deepEqual(events.map(event => event.type), ['status', 'tool_use', 'tool_result', 'text', 'result']);
    assert.equal((events[3].data as string), '已完成');
  });

  test('scans Codex rollout sessions from a temporary CODEX_HOME', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    const dir = path.join(home, 'sessions', '2026', '08', '12');
    fs.mkdirSync(dir, { recursive: true });
    const rollout = path.join(dir, 'rollout-2026-08-12T01-02-03-thread-abc.jsonl');
    fs.writeFileSync(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread-abc', cwd: path.join(home, 'demo'), git: { branch: 'main' } } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>\nInjected metadata\n</recommended_plugins>' }] } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '请始终用简体中文回复，除非用户明确要求其他语言。\n\n---\n\n帮我检查项目' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '再修一下测试' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '测试正在修复中' }] } }),
    ].join('\n'));
    const sessions = scanCodexSessions({ codexHome: home, limit: 5 });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sdkSessionId, 'thread-abc');
    assert.equal(sessions[0].backend, 'codex');
    assert.equal(sessions[0].project, 'demo');
    assert.equal(sessions[0].firstPrompt, '帮我检查项目');
    assert.equal(sessions[0].isOpen, true);
    assert.equal(sessions[0].digest?.latestRequest, '再修一下测试');
    assert.equal(sessions[0].digest?.accomplished, '测试正在修复中');
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('isolates inherited Eureka CODEX_HOME and CODEX_THREAD_ID', () => {
    const oldHome = process.env.CODEX_HOME;
    const oldThread = process.env.CODEX_THREAD_ID;
    process.env.CODEX_HOME = 'C:\\inherited-eureka-task';
    process.env.CODEX_THREAD_ID = '00000000-0000-7000-8000-000000000002';
    const env = buildCodexSubprocessEnv('C:\\stable-codex');
    assert.equal(env.CODEX_HOME, 'C:\\stable-codex');
    assert.ok(!('CODEX_THREAD_ID' in env));
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    if (oldThread === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = oldThread;
  });

  test('resolves the reported historical thread to the home containing its rollout', () => {
    const wrongHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wrong-codex-home-'));
    const rightHome = fs.mkdtempSync(path.join(os.tmpdir(), 'right-codex-home-'));
    const threadId = '00000000-0000-7000-8000-000000000002';
    const dir = path.join(rightHome, 'sessions', '2026', '08', '17');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-test-${threadId}.jsonl`), '{}');
    assert.equal(findCodexHomeForThread(threadId, [wrongHome, rightHome]), rightHome);
    assert.equal(findCodexHomeForThread('not-a-thread', [rightHome]), undefined);
    fs.rmSync(wrongHome, { recursive: true, force: true });
    fs.rmSync(rightHome, { recursive: true, force: true });
  });

  test('marks a Codex session historical after task_complete', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-history-'));
    const dir = path.join(home, 'sessions', '2026', '08', '12');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-history.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread-done', cwd: 'C:\\projects\\done' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '完成历史任务' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '已经完成并通过测试' } }),
    ].join('\n'));
    const sessions = scanCodexSessions({ codexHome: home, limit: 5 });
    assert.equal(sessions[0].isOpen, false);
    assert.equal(sessions[0].digest?.accomplished, '已经完成并通过测试');
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('resolves and preflights the installed Codex CLI when available', (t) => {
    const spec = resolveCodexLaunchSpec();
    if (!spec) { t.skip('optional local Codex CLI is not installed'); return; }
    const result = preflightCodex(spec!);
    assert.ok(result.ok, result.error);
    assert.match(result.version || '', /codex/i);
  });
});

// ── Eureka / unified activity scanner ─────────────────────

describe('activity-session-scanner', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const { scanEurekaSessions, scanActivitySessions } = await import('../activity-session-scanner.js');

  test('extracts live Eureka state, digest, and direct deep link', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eureka-root-'));
    const sessionDir = path.join(root, 'workspaces', 'workspace-1', 'sessions', 'session-live');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), [
      JSON.stringify({
        id: 'session-live', name: '修复移动端进度', createdAt: Date.now() - 5000,
        lastUsedAt: Date.now(), todoState: 'in-progress', taskAttentionStatus: 'in_progress',
        engine: 'codex', model: 'gpt-test', workingDirectory: 'C:\\projects\\demo', sdkSessionId: 'thread-live',
      }),
      JSON.stringify({ type: 'user', content: '先让我在手机查看进度' }),
      JSON.stringify({ type: 'assistant', content: '已经接入会话扫描' }),
      JSON.stringify({ type: 'user', content: '再增加摘要和回跳' }),
      JSON.stringify({ type: 'assistant', content: '正在增加摘要与深链' }),
    ].join('\n'));
    const sessions = scanEurekaSessions({ eurekaRoots: [root], limit: 10 });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, 'running');
    assert.equal(sessions[0].digest.requested, '先让我在手机查看进度');
    assert.equal(sessions[0].digest.latestRequest, '再增加摘要和回跳');
    assert.equal(sessions[0].digest.accomplished, '正在增加摘要与深链');
    assert.equal(sessions[0].deepLink, 'eureka://workspaces/workspace-1/sessions/session-live');

    const unified = scanActivitySessions({ eurekaRoots: [root], codexHomes: [path.join(root, 'empty-codex')], limit: 10 });
    assert.ok(unified.some(session => session.id === 'session-live'));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── Permissions ──────────────────────────────────────────────

describe('permissions', async () => {
  const { PendingPermissions } = await import('../permissions.js');

  test('waitFor resolves when resolved', async () => {
    const perms = new PendingPermissions();
    const promise = perms.waitFor('tool-1');
    const resolved = perms.resolve('tool-1', { behavior: 'allow' });
    assert.ok(resolved);
    const result = await promise;
    assert.equal(result.behavior, 'allow');
  });

  test('waitFor resolves deny', async () => {
    const perms = new PendingPermissions();
    const promise = perms.waitFor('tool-2');
    perms.resolve('tool-2', { behavior: 'deny', message: 'nope' });
    const result = await promise;
    assert.equal(result.behavior, 'deny');
    assert.equal(result.message, 'nope');
  });

  test('resolve returns false for unknown ID', () => {
    const perms = new PendingPermissions();
    assert.ok(!perms.resolve('nonexistent', { behavior: 'allow' }));
  });

  test('denyAll resolves all pending', async () => {
    const perms = new PendingPermissions();
    const p1 = perms.waitFor('t1');
    const p2 = perms.waitFor('t2');
    assert.equal(perms.size, 2);
    perms.denyAll();
    assert.equal(perms.size, 0);
    const r1 = await p1;
    const r2 = await p2;
    assert.equal(r1.behavior, 'deny');
    assert.equal(r2.behavior, 'deny');
  });
});
