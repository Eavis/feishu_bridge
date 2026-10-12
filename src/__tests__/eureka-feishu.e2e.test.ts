/**
 * Real end-to-end: Bridge conversation engine → Eureka desktop task → Feishu.
 * Requires the local Eureka app and configured Feishu credentials.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('real Bridge → Eureka → Feishu flow', async () => {
  const chatId = process.env.CTI_TEST_FEISHU_CHAT_ID;
  assert.ok(chatId, 'Set CTI_TEST_FEISHU_CHAT_ID to an explicitly chosen test chat');
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-eureka-e2e-'));
  process.env.CTI_HOME = tempHome;

  const { loadConfig } = await import('../config.js');
  const { JsonFileStore } = await import('../store.js');
  const { PendingPermissions } = await import('../permissions.js');
  const { createProviderFactory } = await import('../provider-factory.js');
  const { FeishuClient } = await import('../feishu.js');
  const { processMessage } = await import('../conversation.js');
  const { deliver } = await import('../delivery.js');
  const { EurekaMcpClient } = await import('../eureka-provider.js');

  const config = loadConfig();
  const store = new JsonFileStore(config);
  const permissions = new PendingPermissions();
  const providerFactory = createProviderFactory(config, permissions);
  const provider = providerFactory('eureka');
  const live = await provider.preflight?.();
  assert.ok(live?.ok, live?.error);

  const feishu = new FeishuClient(config);
  let taskId = '';
  const client = new EurekaMcpClient(config.eurekaMcpUrl, config.eurekaCallerSessionId);
  try {
    await feishu.start();
    const bridgeSession = store.createSession('Eureka Feishu E2E', '', undefined, process.cwd());
    const binding = store.upsertChannelBinding({
      chatId: `e2e:${Date.now()}`,
      codepilotSessionId: bridgeSession.id,
      workingDirectory: process.cwd(),
      model: '',
      mode: 'code',
    });
    store.updateChannelBinding(binding.id, { agent: 'eureka', sdkSessionId: '' });
    const activeBinding = store.getChannelBinding(binding.chatId)!;
    const marker = `EUREKA_FEISHU_E2E_OK_${Date.now()}`;
    const result = await processMessage(ctx(), activeBinding, `只回复 ${marker}，不要输出其他内容。`);
    assert.equal(result.hasError, false, result.errorMessage);
    assert.match(result.responseText, new RegExp(marker));
    assert.ok(result.sdkSessionId, 'Conversation engine must capture Eureka task ID');
    taskId = result.sdkSessionId!;
    const persisted = store.getChannelBinding(binding.chatId);
    assert.equal(persisted?.sdkSessionId, taskId);
    const storedMessages = store.getMessages(bridgeSession.id).messages;
    assert.ok(storedMessages.some(message => message.role === 'user' && message.content.includes(marker)));
    assert.ok(storedMessages.some(message => message.role === 'assistant' && message.content.includes(marker)));

    const sent = await deliver(ctx(), chatId, [
      '🧪 **Eureka provider 真实端到端测试通过**',
      '',
      result.responseText,
      '',
      `Test task: ${taskId}`,
    ].join('\n'), { parseMode: 'Markdown' });
    assert.ok(sent.ok, sent.error);
    assert.ok(sent.messageId);

    const transcript = await client.callTool<{ turns?: Array<{ role?: string; text?: string }> }>('get_conversation', { agent_id: taskId, limit: 20 });
    assert.ok(transcript.turns?.some(turn => turn.role === 'assistant' && turn.text?.includes(marker)));

    function ctx() {
      return { config, store, providerFactory, permissions, feishu };
    }
  } finally {
    try {
      if (taskId) {
        const closed = await client.callTool<{ ok?: boolean }>('close_task', { task_id: taskId });
        assert.equal(closed.ok, true, 'E2E Eureka task must be archived');
      }
    } finally {
      await feishu.stop();
      permissions.denyAll();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }
});
