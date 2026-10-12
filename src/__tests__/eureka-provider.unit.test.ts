import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PendingPermissions } from '../permissions.js';
import {
  EurekaMcpClient,
  EurekaProvider,
  buildEurekaAttachments,
  mapEurekaPermissionMode,
} from '../eureka-provider.js';
import type { StreamChatParams } from '../types.js';
import type { AppContext, ChannelBinding, InboundMessage } from '../types.js';

type ToolHandler = (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>;

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function startMcpServer(handler: ToolHandler): Promise<{ url: string; calls: Array<{ name: string; args: Record<string, unknown> }> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
    res.setHeader('Content-Type', 'text/event-stream');
    if (body.method === 'initialize') {
      res.setHeader('mcp-session-id', 'unit-mcp-session');
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'eureka', version: 'unit' }, capabilities: { tools: {} } } })}\n\n`);
      return;
    }
    if (req.headers['mcp-session-id'] !== 'unit-mcp-session') {
      res.statusCode = 400;
      res.end('missing session');
      return;
    }
    const name = String(body.params?.name || '');
    const args = (body.params?.arguments || {}) as Record<string, unknown>;
    calls.push({ name, args });
    try {
      const structuredContent = await handler(name, args);
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } })}\n\n`);
    } catch (err) {
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] } })}\n\n`);
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls };
}

function baseParams(overrides?: Partial<StreamChatParams>): StreamChatParams {
  return {
    prompt: '请完成真实任务',
    sessionId: 'bridge-session',
    workingDirectory: 'C:\\projects\\demo',
    permissionMode: 'acceptEdits',
    ...overrides,
  };
}

async function collectEvents(stream: ReadableStream<string>, onEvent?: (event: { type: string; data: string }) => void): Promise<Array<{ type: string; data: string }>> {
  const events: Array<{ type: string; data: string }> = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of value.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6)) as { type: string; data: string };
      events.push(event);
      onEvent?.(event);
    }
  }
  return events;
}

describe('eureka-provider helpers', () => {
  test('maps bridge permission modes without bypassing explicit ask/plan', () => {
    assert.equal(mapEurekaPermissionMode('plan', true), 'safe');
    assert.equal(mapEurekaPermissionMode('default', true), 'ask');
    assert.equal(mapEurekaPermissionMode('acceptEdits', true), 'allow-all');
    assert.equal(mapEurekaPermissionMode('acceptEdits', false), 'ask');
  });

  test('preserves real attachment bytes and MIME metadata', () => {
    const attachments = buildEurekaAttachments([{
      id: 'file-1', name: 'sample.txt', type: 'text/plain', size: 5, data: 'aGVsbG8=',
    }]);
    assert.deepEqual(attachments, [{ name: 'sample.txt', mime_type: 'text/plain', data_base64: 'aGVsbG8=' }]);
  });
});

describe('eureka-provider MCP flow', () => {
  test('renegotiates an expired MCP session once and retries the tool call', async () => {
    let initializes = 0;
    let toolAttempts = 0;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
      if (body.method === 'initialize') {
        initializes++;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('mcp-session-id', `session-${initializes}`);
        res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { version: 'unit' } } })}\n\n`);
        return;
      }
      toolAttempts++;
      if (toolAttempts === 1) {
        res.statusCode = 400;
        res.end('MCP session expired');
        return;
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { ok: true } } })}\n\n`);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const client = new EurekaMcpClient(`http://127.0.0.1:${address.port}/mcp`);
    const result = await client.callTool<{ ok?: boolean }>('list_engines', {});
    assert.equal(result.ok, true);
    assert.equal(initializes, 2);
    assert.equal(toolAttempts, 2);
  });

  test('backs off and retries a rate-limited MCP call', async () => {
    let toolAttempts = 0;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
      if (body.method === 'initialize') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('mcp-session-id', 'rate-session');
        res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { version: 'unit' } } })}\n\n`);
        return;
      }
      toolAttempts++;
      if (toolAttempts === 1) {
        res.statusCode = 429;
        res.setHeader('Retry-After', '0');
        res.end('rate_limited');
        return;
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { ok: true } } })}\n\n`);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const client = new EurekaMcpClient(`http://127.0.0.1:${address.port}/mcp`);
    const result = await client.callTool<{ ok?: boolean }>('list_engines', {});
    assert.equal(result.ok, true);
    assert.equal(toolAttempts, 2);
  });

  test('creates a task, reports tools, returns assistant text, and persists task id', async () => {
    let statusCalls = 0;
    const fake = await startMcpServer((name, args) => {
      if (name === 'create_task') return { task: { id: 'task-new', model: 'model-real' } };
      if (name === 'send_message') return { turn_id: 'user-turn' };
      if (name === 'get_agent_status') {
        statusCalls++;
        if (statusCalls === 1) return {
          status: 'running', turns: [{ id: 'tool-turn', role: 'tool', toolUseId: 'tool-1', toolName: 'Read', toolInput: { path: 'a.txt' }, toolResult: 'ok' }], pending_permissions: [],
        };
        if (statusCalls === 2) return { status: 'idle', turns: [{ id: 'answer-turn', role: 'assistant', text: 'EUREKA_DONE', isIntermediate: false }], pending_permissions: [] };
        return { status: 'idle', turns: [], pending_permissions: [] };
      }
      throw new Error(`unexpected tool ${name} ${JSON.stringify(args)}`);
    });
    const provider = new EurekaProvider(new PendingPermissions(), { endpoint: fake.url, pollIntervalMs: 1, autoApprove: true });
    const events = await collectEvents(provider.streamChat(baseParams({ files: [{ id: 'f', name: 'a.txt', type: 'text/plain', size: 1, data: 'YQ==' }] })));
    assert.ok(events.some(event => event.type === 'status' && event.data.includes('task-new')));
    assert.ok(events.some(event => event.type === 'tool_use' && event.data.includes('Read')));
    assert.ok(events.some(event => event.type === 'tool_result' && event.data.includes('ok')));
    assert.ok(events.some(event => event.type === 'text' && event.data === 'EUREKA_DONE'));
    assert.ok(events.some(event => event.type === 'result' && event.data.includes('task-new')));
    const create = fake.calls.find(call => call.name === 'create_task');
    const send = fake.calls.find(call => call.name === 'send_message');
    assert.equal(create?.args.working_dir, 'C:\\projects\\demo');
    assert.equal(create?.args.permission_mode, 'allow-all');
    assert.deepEqual((send?.args.attachments as any[])[0], { name: 'a.txt', mime_type: 'text/plain', data_base64: 'YQ==' });
  });

  test('resumes an existing Eureka task without creating another', async () => {
    let statusCalls = 0;
    const fake = await startMcpServer(name => {
      if (name === 'get_task') return { task: { id: 'task-existing', status: 'idle' } };
      if (name === 'send_message') return { turn_id: 'user-turn' };
      if (name === 'get_agent_status') {
        statusCalls++;
        return statusCalls === 1
          ? { status: 'running', turns: [], pending_permissions: [] }
          : statusCalls === 2
            ? { status: 'idle', turns: [{ id: 'answer', role: 'assistant', text: 'RESUMED' }], pending_permissions: [] }
            : { status: 'idle', turns: [], pending_permissions: [] };
      }
      throw new Error(`unexpected tool ${name}`);
    });
    const provider = new EurekaProvider(new PendingPermissions(), { endpoint: fake.url, pollIntervalMs: 1 });
    const events = await collectEvents(provider.streamChat(baseParams({ sdkSessionId: 'task-existing' })));
    assert.ok(events.some(event => event.type === 'text' && event.data === 'RESUMED'));
    assert.equal(fake.calls.filter(call => call.name === 'create_task').length, 0);
    assert.equal(fake.calls.filter(call => call.name === 'get_task').length, 1);
  });

  test('replaces a missing parked Eureka task with a new real task', async () => {
    let statusCalls = 0;
    const fake = await startMcpServer(name => {
      if (name === 'get_task') return { task: null };
      if (name === 'create_task') return { task: { id: '260828-fresh-task', model: 'gpt-test' } };
      if (name === 'send_message') return { turn_id: 'user-turn' };
      if (name === 'get_agent_status') {
        statusCalls++;
        return statusCalls === 1
          ? { status: 'running', turns: [], pending_permissions: [] }
          : statusCalls === 2
            ? { status: 'idle', turns: [{ id: 'answer', role: 'assistant', text: 'FRESH_TASK_OK' }], pending_permissions: [] }
            : { status: 'idle', turns: [], pending_permissions: [] };
      }
      throw new Error(`unexpected tool ${name}`);
    });
    const provider = new EurekaProvider(new PendingPermissions(), { endpoint: fake.url, pollIntervalMs: 1 });
    const events = await collectEvents(provider.streamChat(baseParams({ sdkSessionId: '00000000-0000-7000-8000-000000000002' })));
    assert.ok(events.some(event => event.type === 'retry_notice' && event.data.includes('no longer exists')));
    assert.ok(events.some(event => event.type === 'status' && event.data.includes('260828-fresh-task')));
    assert.ok(events.some(event => event.type === 'text' && event.data === 'FRESH_TASK_OK'));
    assert.equal(fake.calls.filter(call => call.name === 'create_task').length, 1);
  });

  test('forwards permission decisions including Allow Session', async () => {
    const permissions = new PendingPermissions();
    let statusCalls = 0;
    let responded = '';
    const fake = await startMcpServer((name, args) => {
      if (name === 'create_task') return { task: { id: 'task-perm' } };
      if (name === 'send_message') return { turn_id: 'user-turn' };
      if (name === 'respond_permission') { responded = String(args.decision); return { ok: true }; }
      if (name === 'get_agent_status') {
        statusCalls++;
        if (statusCalls === 1) return { status: 'running', turns: [], pending_permissions: [{ request_id: 'perm-1', tool_name: 'Write', tool_input: { path: 'x' } }] };
        if (statusCalls === 2) return { status: 'idle', turns: [{ id: 'answer', role: 'assistant', text: 'PERMISSION_OK' }], pending_permissions: [] };
        return { status: 'idle', turns: [], pending_permissions: [] };
      }
      throw new Error(`unexpected tool ${name}`);
    });
    const provider = new EurekaProvider(permissions, { endpoint: fake.url, pollIntervalMs: 1 });
    const events = await collectEvents(provider.streamChat(baseParams()), event => {
      if (event.type === 'permission_request') permissions.resolve('perm-1', { behavior: 'allow', allowAlways: true });
    });
    assert.equal(responded, 'allow_always');
    assert.ok(events.some(event => event.type === 'text' && event.data === 'PERMISSION_OK'));
  });

  test('interrupts the real task path on abort and surfaces an error', async () => {
    let interrupted = false;
    const fake = await startMcpServer(name => {
      if (name === 'create_task') return { task: { id: 'task-abort' } };
      if (name === 'send_message') return { turn_id: 'user-turn' };
      if (name === 'get_agent_status') return { status: 'running', turns: [], pending_permissions: [] };
      if (name === 'interrupt_agent') { interrupted = true; return { ok: true }; }
      throw new Error(`unexpected tool ${name}`);
    });
    const abort = new AbortController();
    const provider = new EurekaProvider(new PendingPermissions(), { endpoint: fake.url, pollIntervalMs: 5 });
    setTimeout(() => abort.abort(), 20);
    const events = await collectEvents(provider.streamChat(baseParams({ abortController: abort })));
    assert.ok(interrupted);
    assert.ok(events.some(event => event.type === 'error' && /stopped|abort/i.test(event.data)));
  });

  test('preflight fails explicitly when the desktop endpoint is unavailable', async () => {
    const client = new EurekaMcpClient('http://127.0.0.1:1/mcp', undefined, fetch, 100);
    const provider = new EurekaProvider(new PendingPermissions(), {}, client);
    const result = await provider.preflight();
    assert.equal(result.ok, false);
    assert.match(result.error || '', /Cannot reach Eureka desktop MCP/);
  });

  test('surfaces repeated status failures instead of silently hanging', async () => {
    let pollAttempts = 0;
    const fake = await startMcpServer(name => {
      if (name === 'create_task') return { task: { id: 'task-poll-fail' } };
      if (name === 'send_message') return { turn_id: 'user-turn' };
      if (name === 'get_agent_status') { pollAttempts++; throw new Error('status backend unavailable'); }
      throw new Error(`unexpected tool ${name}`);
    });
    const provider = new EurekaProvider(new PendingPermissions(), { endpoint: fake.url, pollIntervalMs: 1 });
    const events = await collectEvents(provider.streamChat(baseParams()));
    assert.equal(pollAttempts, 3);
    assert.ok(events.some(event => event.type === 'error' && /polling failed 3 times/i.test(event.data)));
  });

  test('interrupts and reports a turn timeout', async () => {
    let interrupted = false;
    const fake = await startMcpServer(name => {
      if (name === 'create_task') return { task: { id: 'task-timeout' } };
      if (name === 'send_message') return { turn_id: 'user-turn' };
      if (name === 'get_agent_status') return { status: 'running', turns: [], pending_permissions: [] };
      if (name === 'interrupt_agent') { interrupted = true; return { ok: true }; }
      throw new Error(`unexpected tool ${name}`);
    });
    const provider = new EurekaProvider(new PendingPermissions(), { endpoint: fake.url, pollIntervalMs: 2, turnTimeoutMs: 10 });
    const events = await collectEvents(provider.streamChat(baseParams()));
    assert.ok(interrupted);
    assert.ok(events.some(event => event.type === 'error' && /timed out/i.test(event.data)));
  });
});

describe('/agent eureka command wiring', () => {
  function commandContext(preflightOk = true): { ctx: AppContext; binding: ChannelBinding; sent: string[] } {
    const sent: string[] = [];
    const binding: ChannelBinding = {
      id: 'binding-1', chatId: 'chat-1', codepilotSessionId: 'bridge-1', sdkSessionId: 'codex-old',
      agent: 'codex', agentSessions: { eureka: '260827-old-task' }, agentModels: { eureka: 'eureka-model' },
      workingDirectory: 'C:\\projects', model: 'codex-model', mode: 'code', active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const session = { id: 'bridge-1', name: 'test', model: '', permission_mode: 'code', working_directory: 'C:\\projects', created_at: '', updated_at: '' };
    const fakeStore: any = {
      getChannelBinding: () => binding,
      getSession: () => session,
      updateChannelBinding: (_id: string, patch: Partial<ChannelBinding>) => Object.assign(binding, patch),
      insertAuditLog: () => {},
    };
    const fakeProvider = {
      streamChat: () => new ReadableStream<string>(),
      preflight: async () => preflightOk ? { ok: true } : { ok: false, error: 'Eureka desktop offline' },
    };
    const ctx = {
      config: { defaultAgent: 'codex', defaultWorkDir: 'C:\\projects', defaultMode: 'code', feishuAppId: '', feishuAppSecret: '', feishuDomain: 'feishu', feishuRequireMention: true, autoApprove: false, eurekaMcpUrl: 'http://127.0.0.1:21900/mcp', eurekaTurnTimeoutMs: 1000 },
      store: fakeStore,
      providerFactory: () => fakeProvider,
      permissions: new PendingPermissions(),
      feishu: { send: async (_chat: string, text: string) => { sent.push(text); return { ok: true, messageId: 'msg-1' }; } },
    } as unknown as AppContext;
    return { ctx, binding, sent };
  }

  const message = { chatId: 'chat-1', userId: 'user-1', messageId: 'incoming-1', text: '/agent eureka', attachments: [], timestamp: Date.now() } as unknown as InboundMessage;

  test('switches to Eureka and restores its parked task/model', async () => {
    const { handleCommand } = await import('../bridge.js');
    const { ctx, binding, sent } = commandContext(true);
    await handleCommand(ctx, message, '/agent eureka');
    assert.equal(binding.agent, 'eureka');
    assert.equal(binding.sdkSessionId, '260827-old-task');
    assert.equal(binding.model, 'eureka-model');
    assert.equal(binding.agentSessions?.codex, 'codex-old');
    assert.match(sent[0], /Agent switched to \*\*eureka\*\*/);
  });

  test('does not switch when the real Eureka preflight fails', async () => {
    const { handleCommand } = await import('../bridge.js');
    const { ctx, binding, sent } = commandContext(false);
    await handleCommand(ctx, message, '/agent eureka');
    assert.equal(binding.agent, 'codex');
    assert.match(sent[0], /Cannot switch to \*\*eureka\*\*/);
    assert.match(sent[0], /offline/);
  });

  test('normalizes /model gpt6 to the latest Codex model id', async () => {
    const { handleCommand } = await import('../bridge.js');
    const { ctx, binding, sent } = commandContext(true);
    await handleCommand(ctx, { ...message, text: '/model gpt6' }, '/model gpt6');
    assert.equal(binding.model, 'gpt-6-astra');
    assert.equal(binding.agentModels?.codex, 'gpt-6-astra');
    assert.match(sent[0], /gpt-6-astra/);
  });
});
