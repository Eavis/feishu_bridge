/**
 * Integration test — starts the full FeishuClient + Bridge, verifies WebSocket
 * connects, sends a test message via REST, then cleanly shuts down.
 *
 * This test uses a real Feishu WebSocket connection and sends real messages.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { JsonFileStore } from '../store.js';
import { PendingPermissions } from '../permissions.js';
import { createProviderFactory } from '../provider-factory.js';
import { FeishuClient } from '../feishu.js';
import { deliver } from '../delivery.js';
import type { AppContext } from '../types.js';

let config: ReturnType<typeof loadConfig>;
let store: JsonFileStore;
let feishu: FeishuClient;
let ctx: AppContext;
let chatId: string | null = null;

before(async () => {
  config = loadConfig();
  store = new JsonFileStore(config);
  const permissions = new PendingPermissions();
  // Don't eager-preflight — the integration test runs in CI without either CLI
  // installed; the factory only throws on actual streamChat usage.
  const providerFactory = createProviderFactory(config, permissions);
  feishu = new FeishuClient(config);
  ctx = { config, store, providerFactory, permissions, feishu };

  // Start feishu and wait for WS
  await feishu.start();
  assert.ok(feishu.isRunning(), 'FeishuClient should be running after start()');
  await new Promise(r => setTimeout(r, 3000));

  // Transport-only tests need no destination; sending tests require explicit opt-in.
  chatId = process.env.CTI_TEST_FEISHU_CHAT_ID || null;
});

after(async () => {
  console.log('  Stopping FeishuClient...');
  await feishu.stop();
  assert.ok(!feishu.isRunning(), 'Should not be running after stop()');
  console.log('  FeishuClient stopped cleanly');
});

test('FeishuClient starts and WebSocket connects', () => {
  assert.ok(feishu.isRunning(), 'Should be running after before() hook');
  assert.equal(feishu.getWsConnectionHealth().state, 'connected', 'SDK lifecycle must report connected');
  console.log('  FeishuClient started and WebSocket stable');
});

test('FeishuClient self-heals a forcibly terminated real WebSocket', { timeout: 60_000 }, async () => {
  const wsClient = (feishu as any).wsClient;
  const before = wsClient.getConnectionStatus().lastConnectTime;
  wsClient.wsConfig.getWSInstance().terminate();
  const deadline = Date.now() + 45_000;
  let health = feishu.getWsConnectionHealth();
  while (Date.now() < deadline) {
    health = feishu.getWsConnectionHealth();
    if (health.state === 'connected' && (health.lastConnectTime || 0) > (before || 0)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(health.state, 'connected', `Expected reconnect, got ${JSON.stringify(health)}`);
  assert.ok((health.lastConnectTime || 0) > (before || 0), 'Reconnect must establish a newer socket');
});

test('FeishuClient detects and heals a half-open socket via pong timeout', { timeout: 60_000 }, async () => {
  const wsClient = (feishu as any).wsClient;
  const before = wsClient.getConnectionStatus().lastConnectTime;
  const socket = wsClient.wsConfig.getWSInstance();
  socket._socket.pause(); // keep readyState OPEN while suppressing pong/inbound frames
  // Simulate the state immediately after a ping was sent. Calling pingLoop()
  // directly would create a second recurring timer and keep the test alive.
  wsClient.armLiveness();
  const deadline = Date.now() + 45_000;
  let health = feishu.getWsConnectionHealth();
  while (Date.now() < deadline) {
    health = feishu.getWsConnectionHealth();
    if (health.state === 'connected' && (health.lastConnectTime || 0) > (before || 0)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(health.state, 'connected', `Expected half-open recovery, got ${JSON.stringify(health)}`);
  assert.ok((health.lastConnectTime || 0) > (before || 0), 'Pong timeout must establish a newer socket');
});

test('deliver() sends a test message through the full stack', async () => {
  assert.ok(chatId, 'Set CTI_TEST_FEISHU_CHAT_ID to an explicitly chosen test chat');
  const result = await deliver(ctx, chatId!, '🧪 Integration test: plain text delivery works');
  assert.ok(result.ok, `Delivery should succeed: ${result.error}`);
  console.log(`  Plain text delivered: ${result.messageId}`);
});

test('deliver() sends markdown with code block (card rendering)', async () => {
  assert.ok(chatId, 'Set CTI_TEST_FEISHU_CHAT_ID to an explicitly chosen test chat');
  const codeResponse = [
    '🧪 Integration test: code block card rendering',
    '',
    '```typescript',
    'function hello(name: string): string {',
    '  return `Hello, ${name}!`;',
    '}',
    '```',
  ].join('\n');

  const result = await deliver(ctx, chatId!, codeResponse, { parseMode: 'Markdown' });
  assert.ok(result.ok, `Code block delivery should succeed: ${result.error}`);
  console.log(`  Card (code block) delivered: ${result.messageId}`);
});

test('FeishuClient streaming card lifecycle (create → update → finalize)', async () => {
  assert.ok(chatId, 'Set CTI_TEST_FEISHU_CHAT_ID to an explicitly chosen test chat');
  const created = await (feishu as any).createStreamingCard(chatId!, 'integration-stream-session');
  assert.equal(created, true, 'Real streaming card must be created and sent');
  feishu.onStreamText(chatId!, '🧪 Streaming card test...');
  await new Promise(r => setTimeout(r, 2000));

  feishu.onStreamText(chatId!, '🧪 Streaming card test...\n\nUpdating with more content.');
  await new Promise(r => setTimeout(r, 500));

  // Simulate tool progress
  feishu.onToolEvent(chatId!, [
    { id: 'tool-1', name: 'Read', status: 'complete' },
    { id: 'tool-2', name: 'Write', status: 'running' },
  ]);
  await new Promise(r => setTimeout(r, 500));

  // Finalize the card
  const finalized = await feishu.onStreamEnd(chatId!, 'completed', '🧪 Final card content\n\nThis is the completed response.', {
    input_tokens: 1500,
    output_tokens: 800,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 100,
    cost_usd: 0.0125,
  });

  assert.equal(finalized, true, 'Real streaming card must finalize successfully');
  console.log('  Streaming card lifecycle complete: created → updated → finalized');
});

test('store: session and binding roundtrip', () => {
  const session = store.createSession('integration-test', '', undefined, '/tmp');
  const binding = store.upsertChannelBinding({
    chatId: 'integration-test-chat',
    codepilotSessionId: session.id,
    workingDirectory: '/tmp',
    model: '',
  });

  assert.ok(binding.id);
  const retrieved = store.getChannelBinding('integration-test-chat');
  assert.ok(retrieved);
  assert.equal(retrieved!.codepilotSessionId, session.id);
  console.log('  Session + binding roundtrip OK');
});

test('session scanner finds real CLI sessions', () => {
  const sessions = store.listCliSessions({ limit: 5 });
  console.log(`  Found ${sessions.length} CLI session(s)`);
  if (sessions.length > 0) {
    const s = sessions[0];
    console.log(`    Latest: ${s.project} (${s.sdkSessionId.slice(0, 8)}) — ${s.isOpen ? 'open' : 'closed'}`);
    console.log(`    Prompt: "${s.firstPrompt.slice(0, 60)}..."`);
  }
  assert.ok(Array.isArray(sessions));
});
