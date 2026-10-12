/**
 * Feishu API connectivity tests.
 *
 * Tests actual Feishu REST API calls using the bridge's configured credentials.
 * Requires valid CTI_FEISHU_APP_ID and CTI_FEISHU_APP_SECRET in config.env.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from '../config.js';
import { createFeishuHttpClient } from '../feishu-http.js';

let appId: string;
let appSecret: string;
let domain: lark.Domain;
let client: lark.Client;

describe('feishu-api-connectivity', () => {
  before(() => {
    const config = loadConfig();
    appId = config.feishuAppId;
    appSecret = config.feishuAppSecret;
    domain = config.feishuDomain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

    assert.ok(appId, 'CTI_FEISHU_APP_ID must be configured');
    assert.ok(appSecret, 'CTI_FEISHU_APP_SECRET must be configured');

    client = new lark.Client({ appId, appSecret, domain, httpInstance: createFeishuHttpClient() });
  });

  test('can obtain tenant_access_token', async () => {
    const baseUrl = domain === lark.Domain.Lark
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';

    const res = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    });

    const data: any = await res.json();
    assert.ok(data.tenant_access_token, `Should get token, got: ${JSON.stringify(data)}`);
    console.log(`  Token obtained (code: ${data.code})`);
  });

  test('can resolve bot identity', async () => {
    const baseUrl = domain === lark.Domain.Lark
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';

    // Get token first
    const tokenRes = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenData: any = await tokenRes.json();
    assert.ok(tokenData.tenant_access_token);

    // Get bot info
    const botRes = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const botData: any = await botRes.json();
    assert.ok(botData?.bot?.open_id, `Should get bot open_id, got: ${JSON.stringify(botData)}`);
    console.log(`  Bot open_id: ${botData.bot.open_id}`);
    console.log(`  Bot name: ${botData.bot.app_name || 'unknown'}`);
  });

  test('can list bot chats', async () => {
    const res = await client.im.chat.list({ params: { page_size: 5 } });
    const items = res?.data?.items || [];
    assert.ok(items.length > 0, 'Bot must have at least one chat for integration/E2E tests');
    console.log(`  Bot is in ${items.length}+ chat(s)`);
    for (const chat of items.slice(0, 3)) {
      console.log(`    - ${chat.name || 'unnamed'} (${chat.chat_id})`);
    }
  });

  test('CardKit v2 card creation works', async () => {
    const cardBody = {
      schema: '2.0',
      config: { streaming_mode: true, wide_screen_mode: true },
      body: { elements: [{ tag: 'markdown', content: '🧪 Test card', element_id: 'streaming_content' }] },
    };
    const createResp = await (client as any).cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(cardBody) },
    });
    const cardId = createResp?.data?.card_id;
    assert.ok(cardId, `Should create card, got: ${JSON.stringify(createResp?.data || createResp)}`);
    console.log(`  CardKit v2 card created: ${cardId}`);
  });

  test('can send a test message to an explicitly chosen test chat', async () => {
    const chatId = process.env.CTI_TEST_FEISHU_CHAT_ID;
    assert.ok(chatId, 'Set CTI_TEST_FEISHU_CHAT_ID to an explicitly chosen test chat');
    const res = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: '🧪 Bridge v2 API test — please ignore' }),
      },
    });
    assert.ok(res?.data?.message_id, `Real send must return message_id: ${JSON.stringify(res)}`);
    console.log(`  Message sent: ${res.data.message_id} to ${chatId}`);
  });
});
