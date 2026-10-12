#!/usr/bin/env node
/**
 * feishu-outbox MCP server (stdio transport).
 *
 * Exposes a single tool `send_to_feishu(path, caption?, reply?)` which calls
 * back into the bridge daemon over loopback HTTP. The bridge holds Feishu
 * credentials and knows the current chat; this server is a thin proxy.
 *
 * Env (set by bridge when spawning Claude):
 *   FEISHU_OUTBOX_URL    — http://127.0.0.1:PORT
 *   FEISHU_OUTBOX_TOKEN  — session-scoped bearer
 *   FEISHU_OUTBOX_WORKDIR — informational, shown in tool description
 *
 * No external dependencies — implements the JSON-RPC framing of MCP directly
 * over stdio so it works without bundling.
 */

import { createInterface } from 'node:readline';
import http from 'node:http';
import { URL } from 'node:url';

const BRIDGE_URL = process.env.FEISHU_OUTBOX_URL || '';
const TOKEN = process.env.FEISHU_OUTBOX_TOKEN || '';
const WORKDIR = process.env.FEISHU_OUTBOX_WORKDIR || '';

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const SEND_TOOL = {
  name: 'send_to_feishu',
  description:
    `Upload a local file from the working directory and send it back to the user in the current Feishu chat. ` +
    `Images (.png .jpg .jpeg .gif .webp .bmp) are sent as image messages; everything else is sent as a file. ` +
    `Path MUST be an absolute path inside the working directory (${WORKDIR || 'configured per session'}). ` +
    `Max size 30 MB.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the file to send. Must be inside the working directory.' },
      caption: { type: 'string', description: 'Optional text caption sent as a follow-up message.' },
      reply: { type: 'boolean', description: 'Reply to the user\'s last message instead of sending standalone. Default true.' },
    },
    required: ['path'],
  },
};

const CRON_ADD_TOOL = {
  name: 'feishu_cron_add',
  description:
    `Schedule a recurring Claude prompt to fire on a cron schedule. The fired prompt is processed exactly ` +
    `as if the user had typed it in the target chat (with full Claude tools, MCP servers, streaming card). ` +
    `IMPORTANT: This sends a confirmation card with ✅/❌ buttons to the current chat — the task is NOT ` +
    `active until the user clicks confirm. ` +
    `Use this tool whenever the user asks for any time-based recurring action: "every weekday at 9am do X", ` +
    `"remind me daily to Y", "every 30 minutes check Z". Translate the natural-language schedule into a ` +
    `5-field cron expression (CST timezone). Examples: ` +
    `"every weekday morning at 9" → "0 9 * * 1-5"; "every 5 minutes" → "*/5 * * * *"; ` +
    `"daily at 14:30" → "30 14 * * *"; "lunch market close" → "32 11 * * 1-5".`,
  inputSchema: {
    type: 'object',
    properties: {
      cron: { type: 'string', description: '5-field cron expression in local time (minute hour dom month dow). Quote-style not needed.' },
      prompt: { type: 'string', description: 'The full prompt to run when the schedule fires. Should be self-contained — no chat context is carried.' },
      chatId: { type: 'string', description: 'Optional Feishu chat_id to post results to. Defaults to the current chat.' },
      name: { type: 'string', description: 'Optional human-readable label for the task.' },
    },
    required: ['cron', 'prompt'],
  },
};

const CRON_LIST_TOOL = {
  name: 'feishu_cron_list',
  description: `List all scheduled cron tasks for this bridge instance, with id, cron expression, target chat, enabled state, and next fire time.`,
  inputSchema: { type: 'object', properties: {} },
};

const CRON_DEL_TOOL = {
  name: 'feishu_cron_del',
  description: `Delete a scheduled cron task by its id. Use feishu_cron_list first to find the id.`,
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Task id (8-hex-char string from feishu_cron_list).' } },
    required: ['id'],
  },
};

const CRON_PAUSE_TOOL = {
  name: 'feishu_cron_pause',
  description: `Pause a scheduled cron task (does not fire until resumed).`,
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Task id.' } },
    required: ['id'],
  },
};

const CRON_RESUME_TOOL = {
  name: 'feishu_cron_resume',
  description: `Resume a paused cron task.`,
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Task id.' } },
    required: ['id'],
  },
};

const ALL_TOOLS = [SEND_TOOL, CRON_ADD_TOOL, CRON_LIST_TOOL, CRON_DEL_TOOL, CRON_PAUSE_TOOL, CRON_RESUME_TOOL];

async function callBridge(endpoint, payload) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(endpoint, BRIDGE_URL); }
    catch (e) { reject(new Error(`Invalid FEISHU_OUTBOX_URL: ${BRIDGE_URL}`)); return; }
    const body = JSON.stringify({ token: TOKEN, ...payload });
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let parsed;
          try { parsed = JSON.parse(text); } catch { parsed = { ok: false, error: `Non-JSON response: ${text.slice(0, 200)}` }; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'feishu-outbox', version: '0.1.0' },
    });
    return;
  }

  if (method === 'notifications/initialized') return; // notification — no reply

  if (method === 'tools/list') {
    reply(id, { tools: ALL_TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};
    if (!BRIDGE_URL || !TOKEN) {
      reply(id, {
        content: [{ type: 'text', text: 'feishu-outbox is not configured (missing bridge URL/token).' }],
        isError: true,
      });
      return;
    }

    try {
      let endpoint, payload, successText;
      switch (toolName) {
        case 'send_to_feishu':
          endpoint = '/send-file';
          payload = { path: args.path, caption: args.caption, reply: args.reply };
          successText = (b) => `Sent ${b.kind || 'file'} to Feishu (message_id=${b.messageId || '?'}).`;
          break;
        case 'feishu_cron_add':
          endpoint = '/cron-add';
          payload = { cron: args.cron, prompt: args.prompt, chatId: args.chatId, name: args.name };
          successText = (b) => `Confirmation card sent. Task is PENDING until the user clicks ✅. ` +
            `Next fire would be: ${b.nextFireAt}. (pendingId: ${b.pendingId})`;
          break;
        case 'feishu_cron_list':
          endpoint = '/cron-list';
          payload = {};
          successText = (b) => {
            if (!b.tasks || b.tasks.length === 0) return 'No scheduled tasks.';
            return 'Scheduled tasks:\n' + b.tasks.map((t) =>
              `- [${t.enabled ? 'on' : 'off'}] ${t.id} cron="${t.cron}" → ${t.chatId} next=${t.nextFireAt || '—'}\n  prompt: ${t.prompt.slice(0, 100)}`,
            ).join('\n');
          };
          break;
        case 'feishu_cron_del':
          endpoint = '/cron-del';
          payload = { id: args.id };
          successText = () => `Deleted task ${args.id}.`;
          break;
        case 'feishu_cron_pause':
          endpoint = '/cron-pause';
          payload = { id: args.id };
          successText = () => `Paused task ${args.id}.`;
          break;
        case 'feishu_cron_resume':
          endpoint = '/cron-resume';
          payload = { id: args.id };
          successText = () => `Resumed task ${args.id}.`;
          break;
        default:
          replyError(id, -32602, `Unknown tool: ${toolName}`);
          return;
      }

      const r = await callBridge(endpoint, payload);
      if (r.status === 200 && r.body?.ok) {
        reply(id, { content: [{ type: 'text', text: successText(r.body) }] });
      } else {
        reply(id, {
          content: [{ type: 'text', text: `Failed (HTTP ${r.status}): ${r.body?.error || 'unknown error'}` }],
          isError: true,
        });
      }
    } catch (e) {
      reply(id, {
        content: [{ type: 'text', text: `Bridge unreachable: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      });
    }
    return;
  }

  // Unknown method
  if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); }
  catch { return; }
  Promise.resolve(handle(msg)).catch((e) => {
    if (msg?.id !== undefined) replyError(msg.id, -32000, e instanceof Error ? e.message : String(e));
  });
});

rl.on('close', () => process.exit(0));
