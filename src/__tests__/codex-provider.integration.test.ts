import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../config.js';
import {
  CodexProvider,
  DEFAULT_CODEX_MODEL,
  findCodexHomeForThread,
  resolveCodexLaunchSpec,
} from '../codex-provider.js';

// Opt in with an expendable test thread from the default ~/.codex home.
const TEST_THREAD = process.env.CTI_TEST_CODEX_THREAD_ID;

async function collect(stream: ReadableStream<string>): Promise<Array<{ type: string; data: string }>> {
  const events: Array<{ type: string; data: string }> = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of value.split(/\r?\n/)) {
      if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as { type: string; data: string });
    }
  }
  return events;
}

function realProvider(): CodexProvider {
  const config = loadConfig();
  const spec = resolveCodexLaunchSpec();
  assert.ok(spec, 'installed Codex CLI is required');
  assert.ok(config.codexBaseUrl, 'real Codex proxy URL is required');
  const authEnvKey = config.codexAuthEnvKey
    || ['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].find(key => Boolean(process.env[key]));
  assert.ok(authEnvKey && process.env[authEnvKey], 'real Codex proxy credential is required');
  return new CodexProvider(spec, {
    baseUrl: config.codexBaseUrl,
    authEnvKey,
    providerName: config.codexProviderName,
  }, DEFAULT_CODEX_MODEL);
}

function abortAfter(ms: number): { controller: AbortController; stop: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return { controller, stop: () => clearTimeout(timer) };
}

test('real Codex resumes an explicitly configured global-history test thread', { timeout: 180_000 }, async () => {
  assert.ok(TEST_THREAD, 'Set CTI_TEST_CODEX_THREAD_ID to an expendable test thread');
  const owner = findCodexHomeForThread(TEST_THREAD);
  assert.equal(owner, path.join(os.homedir(), '.codex'));

  const provider = realProvider();
  const deadline = abortAfter(150_000);
  const stream = provider.streamChat({
    prompt: '这是 feishu-bridge 的真实恢复回归测试。只回复 CODEX_RESUME_OK，不执行任何工具。',
    sessionId: 'real-codex-resume-test',
    sdkSessionId: TEST_THREAD,
    workingDirectory: process.cwd(),
    model: DEFAULT_CODEX_MODEL,
    abortController: deadline.controller,
  });
  const events = await collect(stream).finally(deadline.stop);
  assert.ok(!events.some(event => event.type === 'error'), JSON.stringify(events));
  assert.ok(events.some(event => event.type === 'text' && event.data.includes('CODEX_RESUME_OK')), JSON.stringify(events));
  assert.ok(events.some(event => event.type === 'result' && event.data.includes(TEST_THREAD)), JSON.stringify(events));
});

test('real Codex replaces a missing parked thread instead of exiting', { timeout: 180_000 }, async () => {
  const missing = '00000000-0000-7000-8000-000000000001';
  const deadline = abortAfter(150_000);
  const events = await collect(realProvider().streamChat({
    prompt: '这是失效 session 的真实回归测试。只回复 CODEX_FRESH_OK，不执行任何工具。',
    sessionId: 'real-codex-fresh-test',
    sdkSessionId: missing,
    workingDirectory: process.cwd(),
    model: DEFAULT_CODEX_MODEL,
    abortController: deadline.controller,
  })).finally(deadline.stop);
  assert.ok(events.some(event => event.type === 'retry_notice' && event.data.includes('No rollout found')), JSON.stringify(events));
  assert.ok(!events.some(event => event.type === 'error'), JSON.stringify(events));
  assert.ok(events.some(event => event.type === 'text' && event.data.includes('CODEX_FRESH_OK')), JSON.stringify(events));
  assert.ok(events.some(event => event.type === 'result' && !event.data.includes(missing)), JSON.stringify(events));
});
