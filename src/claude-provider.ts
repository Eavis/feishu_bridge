/**
 * Claude Provider — wraps @anthropic-ai/claude-agent-sdk query() function.
 *
 * Converts SDK stream events into SSE format consumed by the conversation engine.
 * Stripped of Codex logic, non-Claude model guard, strict env mode, and multi-candidate
 * preflight scanning.
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { PendingPermissions } from './permissions.js';
import type { StreamChatParams, FileAttachment } from './types.js';

// ── SSE helper ──

function sseEvent(type: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: payload })}\n`;
}

// ── Environment isolation ──

const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

export function buildSubprocessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_ALWAYS_STRIP.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// ── Auth error detection ──

const CLI_AUTH_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /loggedIn['":\s]*false/i,
];

const API_AUTH_PATTERNS = [
  /unauthorized/i,
  /invalid.*api.?key/i,
  /authentication.*failed/i,
  /does not have access/i,
  /401\b/,
];

export type AuthErrorKind = 'cli' | 'api' | false;

export function classifyAuthError(text: string): AuthErrorKind {
  if (CLI_AUTH_PATTERNS.some(re => re.test(text))) return 'cli';
  if (API_AUTH_PATTERNS.some(re => re.test(text))) return 'api';
  return false;
}

// ── Retryable error classification ──
//
// We retry once on transient errors that may resolve on a second attempt.
// Returns a short tag string identifying the category (used for user-facing
// messages and logging), or null if the error should NOT be retried.

const RETRY_PATTERNS: Array<[RegExp, string]> = [
  // Anthropic policy refusal — often a false positive; retry-once is worth trying.
  [/violates? our Usage Policy/i, 'usage_policy'],
  [/unable to respond to this request/i, 'usage_policy'],

  // Rate limit — short backoff then retry.
  [/\brate.?limit/i, 'rate_limit'],
  [/\b429\b/, 'rate_limit'],
  [/too many requests/i, 'rate_limit'],

  // Server-side transient.
  [/\b50[234]\b/, 'server_5xx'],
  [/internal server error/i, 'server_5xx'],
  [/service unavailable/i, 'server_5xx'],
  [/gateway timeout/i, 'server_5xx'],
  [/upstream/i, 'server_5xx'],
  [/overloaded/i, 'server_5xx'],

  // Network transport issues.
  [/ECONNRESET/i, 'network'],
  [/ETIMEDOUT/i, 'network'],
  [/ECONNREFUSED/i, 'network'],
  [/EAI_AGAIN/i, 'network'],
  [/socket hang up/i, 'network'],
  [/fetch failed/i, 'network'],
  [/network.*error/i, 'network'],
];

export function classifyRetryableError(message: string, stderr: string): string | null {
  const combined = `${message}\n${stderr}`;
  for (const [re, tag] of RETRY_PATTERNS) {
    if (re.test(combined)) return tag;
  }
  return null;
}

const CLI_AUTH_USER_MESSAGE =
  'Claude CLI is not logged in. Run `claude auth login`, then restart the bridge.';

const API_AUTH_USER_MESSAGE =
  'API credential error. Check your ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in config.env, ' +
  'or verify your organization has access to the requested model.';

// ── Claude CLI path resolution ──

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseCliMajorVersion(versionOutput: string): number | undefined {
  const m = versionOutput.match(/(\d+)\.\d+/);
  return m ? parseInt(m[1], 10) : undefined;
}

function getCliVersion(cliPath: string, env?: Record<string, string>): string | undefined {
  try {
    return execSync(`"${cliPath}" --version`, {
      encoding: 'utf-8',
      timeout: 10_000,
      env: env || buildSubprocessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

const MIN_CLI_MAJOR = 2;
const REQUIRED_CLI_FLAGS = ['output-format', 'input-format', 'permission-mode', 'setting-sources'];

function checkRequiredFlags(cliPath: string, env?: Record<string, string>): string[] {
  let helpText: string;
  try {
    helpText = execSync(`"${cliPath}" --help`, {
      encoding: 'utf-8',
      timeout: 10_000,
      env: env || buildSubprocessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return [];
  }
  return REQUIRED_CLI_FLAGS.filter(flag => !helpText.includes(flag));
}

function checkCliCompatibility(cliPath: string, env?: Record<string, string>): {
  compatible: boolean;
  version: string;
  major: number | undefined;
  missingFlags?: string[];
} | undefined {
  const version = getCliVersion(cliPath, env);
  if (!version) return undefined;
  const major = parseCliMajorVersion(version);
  if (major === undefined || major < MIN_CLI_MAJOR) {
    return { compatible: false, version, major };
  }
  const missing = checkRequiredFlags(cliPath, env);
  return {
    compatible: missing.length === 0,
    version,
    major,
    missingFlags: missing.length > 0 ? missing : undefined,
  };
}

export function preflightCheck(cliPath: string): { ok: boolean; version?: string; error?: string } {
  const cleanEnv = buildSubprocessEnv();
  const compat = checkCliCompatibility(cliPath, cleanEnv);
  if (!compat) {
    return { ok: false, error: `claude CLI at "${cliPath}" failed to execute` };
  }
  if (compat.major !== undefined && compat.major < MIN_CLI_MAJOR) {
    return {
      ok: false,
      version: compat.version,
      error: `claude CLI version ${compat.version} is too old (need >= ${MIN_CLI_MAJOR}.x).`,
    };
  }
  if (compat.missingFlags) {
    return {
      ok: false,
      version: compat.version,
      error: `claude CLI ${compat.version} is missing required flags: ${compat.missingFlags.join(', ')}.`,
    };
  }
  return { ok: true, version: compat.version };
}

function findAllInPath(): string[] {
  if (process.platform === 'win32') {
    try {
      return execSync('where claude', { encoding: 'utf-8', timeout: 3000 })
        .trim().split('\n').map(s => s.trim()).filter(Boolean);
    } catch { return []; }
  }
  try {
    return execSync('which -a claude', { encoding: 'utf-8', timeout: 3000 })
      .trim().split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

export function resolveClaudeCliPath(): string | undefined {
  const fromEnv = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  const pathCandidates = findAllInPath();
  const wellKnown = [
    `${process.env.HOME}/.claude/local/claude`,
    `${process.env.HOME}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];

  const seen = new Set<string>();
  const allCandidates: string[] = [];
  for (const p of [...pathCandidates, ...wellKnown]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      allCandidates.push(p);
    }
  }

  let firstUnverifiable: string | undefined;
  for (const p of allCandidates) {
    if (!isExecutable(p)) continue;
    const compat = checkCliCompatibility(p);
    if (compat?.compatible) {
      if (p !== pathCandidates[0] && pathCandidates.length > 0) {
        console.log(`[claude-provider] Skipping incompatible CLI at "${pathCandidates[0]}", using "${p}" (${compat.version})`);
      }
      return p;
    }
    if (compat) {
      console.warn(`[claude-provider] CLI at "${p}" is version ${compat.version} (need >= ${MIN_CLI_MAJOR}.x), skipping`);
    } else if (!firstUnverifiable) {
      firstUnverifiable = p;
    }
  }

  return firstUnverifiable;
}

// ── Multi-modal prompt builder ──

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

/**
 * Build a per-format hint that tells Claude how to read the attached document.
 * Returns a code-block snippet the model can copy/adapt, not a fully-formed
 * command — Claude knows uv / pip / python.
 */
function attachmentReadHint(filePath: string, fileName: string): string {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const escaped = JSON.stringify(filePath); // safe string literal for python
  switch (ext) {
    case 'docx':
      return `用 \`python -c "import docx; print('\\n'.join(p.text for p in docx.Document(${escaped}).paragraphs))"\` 读取（需 python-docx，可 \`uv pip install python-docx\`）`;
    case 'xlsx':
      return `用 \`python -c "import openpyxl; wb=openpyxl.load_workbook(${escaped}, data_only=True); ..."\` 读取（需 openpyxl）`;
    case 'pptx':
      return `用 \`python -c "from pptx import Presentation; ..."\` 读取（需 python-pptx）`;
    case 'pdf':
      return `用 \`python -c "import pypdf; r=pypdf.PdfReader(${escaped}); print('\\n'.join(p.extract_text() for p in r.pages))"\` 读取（需 pypdf）`;
    case 'doc':
    case 'xls':
    case 'ppt':
      return `**旧格式**（${ext}）Python 没好库，需要 \`libreoffice --headless --convert-to ${ext === 'doc' ? 'docx' : ext === 'xls' ? 'xlsx' : 'pptx'} ${escaped}\` 先转换；如本机无 LibreOffice，请提示用户另存为新格式`;
    case 'csv':
    case 'tsv':
    case 'txt':
    case 'md':
    case 'json':
    case 'yaml':
    case 'yml':
    case 'xml':
    case 'html':
    case 'log':
      return `用 Read 工具直接读取（纯文本格式）`;
    default:
      return `未知格式 \`.${ext}\`，先用 \`file ${escaped}\` 探测类型再决定怎么读`;
  }
}

function buildPrompt(
  text: string,
  files?: FileAttachment[],
): string | AsyncIterable<{ type: 'user'; message: { role: 'user'; content: unknown[] }; parent_tool_use_id: null; session_id: string }> {
  const imageFiles = files?.filter(f => SUPPORTED_IMAGE_TYPES.has(f.type)) || [];
  const docFiles = files?.filter(f => !SUPPORTED_IMAGE_TYPES.has(f.type) && f.filePath) || [];

  // Append a "📎 附件" section for non-image files. We do this whether or
  // not images are present, so a single message can mix both.
  let augmentedText = text;
  if (docFiles.length > 0) {
    const lines: string[] = ['', '---', '📎 **用户上传的附件**（已下载到本机，请按提示读取后处理）:'];
    for (const f of docFiles) {
      const kb = (f.size / 1024).toFixed(1);
      lines.push('');
      lines.push(`- **${f.name}** (${kb} KB, \`${f.type}\`)`);
      lines.push(`  - 路径: \`${f.filePath}\``);
      lines.push(`  - ${attachmentReadHint(f.filePath!, f.name)}`);
    }
    lines.push('');
    lines.push('**生成新文档发回用户**：写到 `CTI_DEFAULT_WORKDIR` 内，调 `mcp__feishu-outbox__send_to_feishu(path)` 即可发回飞书。');
    augmentedText = (text || '').trim() + '\n' + lines.join('\n');
  }

  if (imageFiles.length === 0) return augmentedText;

  const contentBlocks: unknown[] = [];
  for (const file of imageFiles) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: (file.type === 'image/jpg' ? 'image/jpeg' : file.type) as ImageMediaType,
        data: file.data,
      },
    });
  }
  if (augmentedText.trim()) {
    contentBlocks.push({ type: 'text', text: augmentedText });
  }

  const msg = {
    type: 'user' as const,
    message: { role: 'user' as const, content: contentBlocks },
    parent_tool_use_id: null,
    session_id: '',
  };
  return (async function* () { yield msg; })();
}

// ── Stream state ──

interface StreamState {
  hasReceivedResult: boolean;
  hasStreamedText: boolean;
  lastAssistantText: string;
}

// ── ClaudeProvider ──

/**
 * Build a "current date/time" system-prompt addition.
 *
 * Why: the SDK's default system prompt does NOT inject a reliable "today" anchor
 * in our setup. Without it, the model falls back to training-cutoff memory and
 * any date-derived calculation (gestational week, "what day is today", session
 * time-classification for stock broadcasts) silently drifts by 10+ days.
 *
 * Appended via `systemPrompt: { append: ... }` so it stacks on top of the
 * default Claude Code system prompt rather than replacing it.
 */
function buildCurrentDateInjection(): string {
  const now = new Date();
  const tz = 'Asia/Shanghai';
  const dateTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(now); // "2026-05-16 12:47:32"
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
  }).format(now); // "Saturday"
  return `# Current Date/Time (injected by feishu-claude-bridge)

Today is ${dateTime} ${weekday} (${tz}).

Use this as ground truth for any "today", "now", or "current" reference.
DO NOT estimate the current date from training memory — your training cutoff
is months/years in the past. Any date-derived calculation (gestational age,
session time classification, file paths like state/{date}/, "is it Friday?")
must use this date or a fresh \`Bash date\` call, NOT your internal guess.`;
}

export class ClaudeProvider {
  private cliPath: string | undefined;
  private autoApprove: boolean;
  private pinnedModel: string | undefined;

  constructor(private pendingPerms: PendingPermissions, cliPath?: string, autoApprove = false, pinnedModel?: string) {
    this.cliPath = cliPath;
    this.autoApprove = autoApprove;
    this.pinnedModel = pinnedModel;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const pendingPerms = this.pendingPerms;
    const cliPath = this.cliPath;
    const autoApprove = this.autoApprove;
    const pinnedModel = this.pinnedModel;

    return new ReadableStream({
      start(controller) {
        (async () => {
          const MAX_STDERR = 4096;
          const MAX_RETRIES = 1; // one extra attempt after the original

          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            let stderrBuf = '';
            const state: StreamState = { hasReceivedResult: false, hasStreamedText: false, lastAssistantText: '' };

            try {
              const cleanEnv = buildSubprocessEnv();

              let model = params.model;
              if (pinnedModel) {
                // pinnedModel (config.env CTI_DEFAULT_MODEL) is authoritative —
                // it overrides any stale model stored on the binding/session so
                // every request runs exactly this model (old chats included).
                if (model !== pinnedModel) {
                  console.log(`[claude-provider] Pinning model "${pinnedModel}" (binding had "${model ?? 'CLI default'}")`);
                }
                model = pinnedModel;
              } else if (model) {
                console.log(`[claude-provider] Skipping model "${model}", using CLI default`);
                model = undefined;
              }

              const queryOptions: Record<string, unknown> = {
                cwd: params.workingDirectory,
                model,
                resume: params.sdkSessionId || undefined,
                forkSession: params.forkSession || undefined,
                abortController: params.abortController,
                permissionMode: (params.permissionMode as 'default' | 'acceptEdits' | 'plan') || undefined,
                includePartialMessages: true,
                env: cleanEnv,
                // Inject current date/time as a system-prompt addition so the model
                // doesn't fall back to training-memory dates. Append mode preserves
                // the default Claude Code system prompt; only adds our section.
                systemPrompt: params.systemPrompt
                  ? `${params.systemPrompt}\n\n${buildCurrentDateInjection()}`
                  : { append: buildCurrentDateInjection() },
                stderr: (data: string) => {
                  stderrBuf += data;
                  if (stderrBuf.length > MAX_STDERR) {
                    stderrBuf = stderrBuf.slice(-MAX_STDERR);
                  }
                },
                canUseTool: async (
                  toolName: string,
                  input: Record<string, unknown>,
                  opts: { toolUseID: string; suggestions?: string[] },
                ): Promise<PermissionResult> => {
                  if (autoApprove) {
                    return { behavior: 'allow' as const, updatedInput: input };
                  }
                  controller.enqueue(
                    sseEvent('permission_request', {
                      permissionRequestId: opts.toolUseID,
                      toolName,
                      toolInput: input,
                      suggestions: opts.suggestions || [],
                    }),
                  );
                  const result = await pendingPerms.waitFor(opts.toolUseID);
                  if (result.behavior === 'allow') {
                    return { behavior: 'allow' as const, updatedInput: input };
                  }
                  return {
                    behavior: 'deny' as const,
                    message: result.message || 'Denied by user',
                  };
                },
              };
              if (cliPath) {
                queryOptions.pathToClaudeCodeExecutable = cliPath;
              }
              if (params.extraMcpServers && Object.keys(params.extraMcpServers).length > 0) {
                queryOptions.mcpServers = params.extraMcpServers;
              }

              const prompt = buildPrompt(params.prompt, params.files);
              const q = query({
                prompt: prompt as Parameters<typeof query>[0]['prompt'],
                options: queryOptions as Parameters<typeof query>[0]['options'],
              });

              for await (const msg of q) {
                handleMessage(msg, controller, state);
              }

              controller.close();
              return;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.error('[claude-provider] SDK query error (attempt ' + (attempt + 1) + '):', err instanceof Error ? err.stack || err.message : err);
              if (stderrBuf) {
                console.error('[claude-provider] stderr from CLI:', stderrBuf.trim());
              }

              const isTransportExit = message.includes('process exited with code');

              if (state.hasReceivedResult && isTransportExit) {
                console.log('[claude-provider] Suppressing transport error — result already received');
                controller.close();
                return;
              }

              if (state.lastAssistantText && classifyAuthError(state.lastAssistantText)) {
                controller.enqueue(sseEvent('text', state.lastAssistantText));
                controller.close();
                return;
              }

              const authKind = classifyAuthError(message) || classifyAuthError(stderrBuf);

              // ── Retry decision ──
              // Auth errors are never retryable (won't fix itself). Otherwise check the message.
              const retryable = !authKind && classifyRetryableError(message, stderrBuf);
              if (retryable && attempt < MAX_RETRIES) {
                console.log(`[claude-provider] Retryable error (${retryable}), retrying attempt ${attempt + 2}/${MAX_RETRIES + 1}...`);
                controller.enqueue(sseEvent('retry_notice', {
                  reason: retryable,
                  attempt: attempt + 1,
                  total: MAX_RETRIES + 1,
                  originalError: message.slice(0, 400),
                }));
                // Brief backoff for rate-limit / transient transport. Usage-policy retry can be immediate.
                if (retryable !== 'usage_policy') {
                  await new Promise((r) => setTimeout(r, 1500));
                }
                continue; // outer for-loop → re-run query()
              }

              let userMessage: string;
              if (authKind === 'cli') {
                userMessage = CLI_AUTH_USER_MESSAGE;
              } else if (authKind === 'api') {
                userMessage = API_AUTH_USER_MESSAGE;
              } else if (isTransportExit) {
                const stderrSummary = stderrBuf.trim();
                const lines = [message];
                if (stderrSummary) {
                  lines.push('', 'CLI stderr:', stderrSummary.slice(-1024));
                }
                lines.push(
                  '',
                  'Possible causes:',
                  '• Claude CLI not authenticated — run: claude auth login',
                  '• Claude CLI version too old (need >= 2.x) — run: claude --version',
                  '• Missing ANTHROPIC_* env vars in daemon — check config.env',
                );
                userMessage = lines.join('\n');
              } else {
                userMessage = message;
              }

              // If we already retried, prefix the user-facing error so they know.
              if (attempt > 0) {
                userMessage = `[已自动重试 ${attempt} 次仍失败]\n\n${userMessage}`;
              }

              controller.enqueue(sseEvent('error', userMessage));
              controller.close();
              return;
            }
          }
        })();
      },
    });
  }
}

function handleMessage(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<string>,
  state: StreamState,
): void {
  switch (msg.type) {
    case 'stream_event': {
      const event = msg.event;
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        controller.enqueue(sseEvent('text', event.delta.text));
        state.hasStreamedText = true;
      }
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use'
      ) {
        controller.enqueue(
          sseEvent('tool_use', {
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          }),
        );
      }
      break;
    }

    case 'assistant': {
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            state.lastAssistantText += (state.lastAssistantText ? '\n' : '') + block.text;
          } else if (block.type === 'tool_use') {
            controller.enqueue(
              sseEvent('tool_use', {
                id: block.id,
                name: block.name,
                input: block.input,
              }),
            );
          }
        }
      }
      break;
    }

    case 'user': {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const rb = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
            const text = typeof rb.content === 'string'
              ? rb.content
              : JSON.stringify(rb.content ?? '');
            controller.enqueue(
              sseEvent('tool_result', {
                tool_use_id: rb.tool_use_id,
                content: text,
                is_error: rb.is_error || false,
              }),
            );
          }
        }
      }
      break;
    }

    case 'result': {
      state.hasReceivedResult = true;
      if (msg.subtype === 'success') {
        controller.enqueue(
          sseEvent('result', {
            session_id: msg.session_id,
            is_error: msg.is_error,
            usage: {
              input_tokens: msg.usage.input_tokens,
              output_tokens: msg.usage.output_tokens,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
              cost_usd: msg.total_cost_usd,
            },
          }),
        );
      } else {
        const errors =
          'errors' in msg && Array.isArray(msg.errors)
            ? msg.errors.join('; ')
            : 'Unknown error';
        controller.enqueue(sseEvent('error', errors));
      }
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        controller.enqueue(
          sseEvent('status', {
            session_id: msg.session_id,
            model: msg.model,
          }),
        );
      }
      break;
    }

    default:
      break;
  }
}
