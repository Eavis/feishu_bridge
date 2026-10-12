/** Real Eureka desktop integration test. Creates and cleans up one real task. */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { PendingPermissions } from '../permissions.js';
import { EurekaMcpClient, EurekaProvider } from '../eureka-provider.js';
import type { StreamChatParams } from '../types.js';

const config = loadConfig();
const client = new EurekaMcpClient(config.eurekaMcpUrl, config.eurekaCallerSessionId);
const provider = new EurekaProvider(new PendingPermissions(), {
  endpoint: config.eurekaMcpUrl,
  callerSessionId: config.eurekaCallerSessionId,
  agentEngine: config.eurekaAgentEngine,
  thinkingLevel: 'off',
  pollIntervalMs: 1_500,
  turnTimeoutMs: 180_000,
  autoApprove: true,
});

let taskId = '';
const taskIds = new Set<string>();

after(async () => {
  for (const id of taskIds) {
    const closed = await client.callTool<{ ok?: boolean }>('close_task', { task_id: id });
    assert.equal(closed.ok, true, 'Real Eureka test task must be archived after the suite');
  }
});

async function collect(stream: ReadableStream<string>): Promise<Array<{ type: string; data: string }>> {
  const events: Array<{ type: string; data: string }> = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of value.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      events.push(JSON.parse(line.slice(6)) as { type: string; data: string });
    }
  }
  return events;
}

function params(overrides?: Partial<StreamChatParams>): StreamChatParams {
  return {
    prompt: '读取随消息上传的文本附件，只回复附件里的完整内容；可以使用读取附件所需的工具。',
    sessionId: 'real-integration-bridge-session',
    workingDirectory: process.cwd(),
    permissionMode: 'acceptEdits',
    files: [{
      id: 'real-attachment', name: 'real-eureka-sample.txt', type: 'text/plain',
      size: 24, data: Buffer.from('ATTACHMENT_REAL_SENTINEL', 'utf8').toString('base64'),
    }],
    ...overrides,
  };
}

test('real preflight reaches Eureka desktop and finds an engine', async () => {
  const result = await provider.preflight();
  assert.ok(result.ok, result.error);
  assert.match(result.version || '', /Eureka MCP/);
});

test('real create → attachment send → status → transcript flow', async () => {
  const events = await collect(provider.streamChat(params()));
  const errors = events.filter(event => event.type === 'error');
  assert.deepEqual(errors, [], `Unexpected provider errors: ${JSON.stringify(errors)}`);
  const status = events.find(event => event.type === 'status' && JSON.parse(event.data).session_id);
  assert.ok(status, 'Provider must emit the created Eureka task ID');
  taskId = JSON.parse(status!.data).session_id;
  taskIds.add(taskId);
  assert.match(taskId, /^\d{6}-[a-z]+-[a-z]+$/);
  const text = events.filter(event => event.type === 'text').map(event => event.data).join('\n');
  assert.match(text, /ATTACHMENT_REAL_SENTINEL/);
  assert.ok(events.some(event => event.type === 'result' && JSON.parse(event.data).session_id === taskId));

  const task = await client.callTool<{ task?: { id?: string; tag?: string; workingDirectory?: string } }>('get_task', { task_id: taskId });
  assert.equal(task.task?.id, taskId);
  assert.equal(task.task?.tag, 'feishu-bridge');
  const conversation = await client.callTool<{ turns?: Array<{ role?: string; text?: string }> }>('get_conversation', { agent_id: taskId, limit: 20 });
  assert.ok(conversation.turns?.some(turn => turn.role === 'user' && turn.text?.includes('读取随消息上传')));
  assert.ok(conversation.turns?.some(turn => turn.role === 'assistant' && turn.text?.includes('ATTACHMENT_REAL_SENTINEL')));
});

test('real second turn resumes the same Eureka task', async () => {
  assert.ok(taskId, 'create test must run first');
  const events = await collect(provider.streamChat(params({
    prompt: '这是续接验证。只回复 EUREKA_BRIDGE_RESUME_OK，不使用工具。',
    sdkSessionId: taskId,
    files: undefined,
  })));
  const text = events.filter(event => event.type === 'text').map(event => event.data).join('\n');
  assert.match(text, /EUREKA_BRIDGE_RESUME_OK/);
  assert.ok(events.some(event => event.type === 'result' && JSON.parse(event.data).session_id === taskId));
});

test('real invalid parked task is replaced and the replacement completes', async () => {
  const events = await collect(provider.streamChat(params({ sdkSessionId: '000000-missing-task', files: undefined })));
  assert.ok(events.some(event => event.type === 'retry_notice' && /no longer exists/i.test(event.data)));
  const status = events.find(event => event.type === 'status' && JSON.parse(event.data).session_id);
  assert.ok(status, 'replacement Eureka task ID must be emitted');
  const replacementId = JSON.parse(status!.data).session_id;
  assert.notEqual(replacementId, '000000-missing-task');
  taskIds.add(replacementId);
  assert.ok(events.some(event => event.type === 'result' && JSON.parse(event.data).session_id === replacementId));
});
