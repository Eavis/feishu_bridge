/**
 * Copilot Provider — drives the GitHub Copilot CLI as a non-interactive
 * subprocess and adapts its JSONL event stream into the same SSE format the
 * conversation engine consumes.
 *
 * This is the Copilot-backed replacement for ClaudeProvider. It keeps the exact
 * same public surface (`streamChat(params): ReadableStream<string>` plus the SSE
 * event vocabulary in conversation.ts) so the rest of the bridge is unchanged.
 *
 * Why a subprocess instead of an SDK: Copilot CLI ships no embeddable SDK like
 * @anthropic-ai/claude-agent-sdk. We spawn `node npm-loader.js -p <prompt>
 * --output-format json` and parse the JSONL it prints, one event per line.
 *
 * Mapping (copilot JSONL → bridge SSE):
 *   assistant.message_delta   → text         (streaming deltas)
 *   assistant.message         → text (if not already streamed) + tool_use[]
 *   tool.execution_complete   → tool_result
 *   session.tools_updated     → status (model only)
 *   result                    → result (session_id for resume + usage)
 *
 * Differences from the Claude backend (documented, intentional):
 *   - Permissions: Copilot CLI non-interactive mode requires --allow-all-tools,
 *     so per-tool permission gating (canUseTool) is not available. Effectively
 *     always auto-approve. The pendingPerms gateway is accepted for signature
 *     parity but never drives a prompt here.
 *   - forkSession: Copilot has no fork primitive. A forked turn runs as a fresh
 *     session (no --resume), so it does not mutate the original but also does
 *     not inherit its context.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import type { PendingPermissions } from './permissions.js';
import type { StreamChatParams, FileAttachment } from './types.js';

// ── SSE helper (byte-for-byte identical to claude-provider) ──

function sseEvent(type: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: payload })}\n`;
}

// ── Environment isolation ──
//
// CLAUDECODE leaks "I'm running inside Claude Code" into the child; strip it so
// the spawned Copilot CLI behaves as a clean top-level invocation.
const ENV_ALWAYS_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

export function buildSubprocessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_ALWAYS_STRIP.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// ── Auth / transient error detection ──

const CLI_AUTH_PATTERNS = [
  /not logged in/i,
  /please (run|log ?in)/i,
  /gh auth login/i,
  /authentication required/i,
  /no (github )?token/i,
  /unauthor/i,
];

export function isAuthError(text: string): boolean {
  return CLI_AUTH_PATTERNS.some(re => re.test(text));
}

const RETRY_PATTERNS: Array<[RegExp, string]> = [
  [/\brate.?limit/i, 'rate_limit'],
  [/\b429\b/, 'rate_limit'],
  [/too many requests/i, 'rate_limit'],
  [/\b50[234]\b/, 'server_5xx'],
  [/internal server error/i, 'server_5xx'],
  [/service unavailable/i, 'server_5xx'],
  [/gateway timeout/i, 'server_5xx'],
  [/overloaded/i, 'server_5xx'],
  [/ECONNRESET/i, 'network'],
  [/ETIMEDOUT/i, 'network'],
  [/ECONNREFUSED/i, 'network'],
  [/EAI_AGAIN/i, 'network'],
  [/socket hang up/i, 'network'],
  [/fetch failed/i, 'network'],
];

export function classifyRetryableError(text: string): string | null {
  for (const [re, tag] of RETRY_PATTERNS) {
    if (re.test(text)) return tag;
  }
  return null;
}

const CLI_AUTH_USER_MESSAGE =
  'Copilot CLI 未登录。在终端运行 `copilot`（交互模式）完成 GitHub 登录后，重启 bridge。';

// ── Copilot CLI entrypoint resolution ──
//
// `copilot` on disk is a shell shim / .cmd that ultimately runs
//   node <pkg>/node_modules/@github/copilot/npm-loader.js
// We resolve that loader .js and spawn it with `node` directly. Spawning the
// real JS entrypoint (rather than the .cmd) lets us pass argv as an array with
// shell:false — no Windows quoting hell for arbitrary prompt text.

const LOADER_SUFFIX = path.join('node_modules', '@github', 'copilot', 'npm-loader.js');

function loaderFromBinDir(binDir: string): string {
  return path.join(binDir, LOADER_SUFFIX);
}

function whichCopilot(): string[] {
  const cmd = process.platform === 'win32' ? 'where copilot' : 'which -a copilot';
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 4000 })
      .trim().split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolve the absolute path to Copilot's npm-loader.js entrypoint.
 * Honors CTI_COPILOT_EXECUTABLE (may point at the loader.js, the copilot.cmd,
 * or the bin directory), then falls back to `where/which copilot`.
 */
export function resolveCopilotLoaderPath(): string | undefined {
  const candidates: string[] = [];

  const fromEnv = process.env.CTI_COPILOT_EXECUTABLE;
  if (fromEnv) {
    if (fromEnv.endsWith('npm-loader.js')) candidates.push(fromEnv);
    else candidates.push(loaderFromBinDir(path.dirname(fromEnv)));
  }

  for (const bin of whichCopilot()) {
    // bin is .../copilot, .../copilot.cmd, or .../copilot.exe — its directory
    // is the npm-global bin dir that also holds node_modules/@github/copilot.
    candidates.push(loaderFromBinDir(path.dirname(bin)));
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return undefined;
}

export function preflightCopilot(loaderPath: string): { ok: boolean; version?: string; error?: string } {
  try {
    const out = execSync(`"${process.execPath}" "${loaderPath}" --version`, {
      encoding: 'utf-8',
      timeout: 15_000,
      env: buildSubprocessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!/copilot/i.test(out)) {
      return { ok: false, version: out, error: `Unexpected --version output: ${out}` };
    }
    return { ok: true, version: out };
  } catch (err) {
    return { ok: false, error: `Copilot loader at "${loaderPath}" failed to execute: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Attachment handling ──

const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

// Prepended to every prompt so Copilot answers (including the short narration it
// writes before each tool call) in Chinese, instead of leaking English reasoning.
const RESPONSE_LANG_DIRECTIVE =
  '【输出语言】请始终用简体中文回复，包括工具调用前后的简短过程说明。除非用户明确要求改用其他语言。';

/** Per-format hint telling Copilot how to read a non-image document with its shell/python tools. */
function attachmentReadHint(filePath: string, fileName: string): string {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const escaped = JSON.stringify(filePath);
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
    default:
      return `用 shell/python 直接读取 \`${filePath}\``;
  }
}

/**
 * Split files into image attachments (passed natively via --attachment) and doc
 * attachments (appended to the prompt as read-hints, since native document
 * parsing support varies). Returns the augmented prompt text and the list of
 * file paths to pass as --attachment.
 */
function buildPromptAndAttachments(
  text: string,
  systemPrompt: string | undefined,
  files: FileAttachment[] | undefined,
): { prompt: string; attachmentPaths: string[] } {
  const imageFiles = (files || []).filter(f => SUPPORTED_IMAGE_TYPES.has(f.type) && f.filePath);
  const docFiles = (files || []).filter(f => !SUPPORTED_IMAGE_TYPES.has(f.type) && f.filePath);

  let augmented = text || '';

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
    lines.push('**生成新文档发回用户**：写到工作目录内，调 `mcp__feishu-outbox__send_to_feishu(path)` 即可发回飞书。');
    augmented = augmented.trim() + '\n' + lines.join('\n');
  }

  // Copilot has no --system-prompt flag; prepend any session system prompt,
  // then a language directive so intermediate narration stays in Chinese too.
  if (systemPrompt && systemPrompt.trim()) {
    augmented = `${systemPrompt.trim()}\n\n---\n\n${augmented}`;
  }
  augmented = `${RESPONSE_LANG_DIRECTIVE}\n\n---\n\n${augmented}`;

  const attachmentPaths = imageFiles.map(f => f.filePath!).filter(Boolean);
  return { prompt: augmented, attachmentPaths };
}

// ── MCP config (feishu-outbox so Copilot can send files back) ──
//
// Copilot's --additional-mcp-config wants a discriminated-union shape keyed on
// `type`. A local stdio server is `{type:"local", command, args, env, tools}`.
// Paths must be valid JSON strings — JSON.stringify handles backslash escaping,
// but we normalize the script path to forward slashes (node accepts them on
// Windows) to dodge any escaping edge cases observed with the CLI parser.
function buildMcpConfigArg(
  extra: StreamChatParams['extraMcpServers'],
): string | undefined {
  if (!extra || Object.keys(extra).length === 0) return undefined;
  const mcpServers: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(extra)) {
    mcpServers[name] = {
      type: 'local',
      command: def.command,
      args: (def.args || []).map(a => a.replace(/\\/g, '/')),
      env: def.env || {},
      tools: ['*'],
    };
  }
  return JSON.stringify({ mcpServers });
}

// ── Stream state ──

interface StreamState {
  hasReceivedResult: boolean;
  hasStreamedText: boolean;
  lastAssistantText: string;
  totalOutputTokens: number;
}

function newState(): StreamState {
  return {
    hasReceivedResult: false,
    hasStreamedText: false,
    lastAssistantText: '',
    totalOutputTokens: 0,
  };
}

// ── CopilotProvider ──

export class CopilotProvider {
  private loaderPath: string;
  private pinnedModel: string | undefined;

  // pendingPerms & autoApprove accepted for signature parity with ClaudeProvider.
  // Copilot non-interactive mode is always --allow-all-tools, so they are unused.
  constructor(
    _pendingPerms: PendingPermissions,
    loaderPath: string,
    _autoApprove = false,
    pinnedModel?: string,
  ) {
    this.loaderPath = loaderPath;
    this.pinnedModel = pinnedModel;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const loaderPath = this.loaderPath;
    const pinnedModel = this.pinnedModel;

    return new ReadableStream({
      start(controller) {
        (async () => {
          const MAX_RETRIES = 1; // one extra attempt after the original
          const MAX_STDERR = 4096;

          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const state = newState();
            let stderrBuf = '';
            let lineBuf = '';

            // Build argv. We spawn `node npm-loader.js ...` so the prompt is a
            // single argv element — no shell quoting concerns.
            const { prompt, attachmentPaths } = buildPromptAndAttachments(
              params.prompt,
              params.systemPrompt,
              params.files,
            );

            const args: string[] = [
              loaderPath,
              '-p', prompt,
              '--output-format', 'json',
              '--allow-all-tools',
              '--no-color',
              '--no-auto-update',
            ];

            if (params.workingDirectory) {
              args.push('-C', params.workingDirectory);
            }
            // Model priority: per-chat override (via `/model` slash command,
            // stored in binding.model → params.model) beats config-level pin.
            // Both are opt-in; falling through means Copilot uses its CLI default.
            const effectiveModel = params.model || pinnedModel;
            if (effectiveModel) {
              args.push('--model', effectiveModel);
            }
            // Resume keeps Copilot session context. Skip on fork so we never
            // mutate the original session.
            if (params.sdkSessionId && !params.forkSession) {
              args.push(`--resume=${params.sdkSessionId}`);
            }
            for (const p of attachmentPaths) {
              args.push('--attachment', p);
            }
            const mcpArg = buildMcpConfigArg(params.extraMcpServers);
            if (mcpArg) {
              args.push('--additional-mcp-config', mcpArg);
            }

            let resolved = false;
            try {
              await new Promise<void>((resolve, reject) => {
                const child = spawn(process.execPath, args, {
                  cwd: params.workingDirectory || process.cwd(),
                  env: buildSubprocessEnv(),
                  stdio: ['ignore', 'pipe', 'pipe'],
                  shell: false,
                  windowsHide: true,
                });

                const onAbort = () => {
                  try { child.kill('SIGTERM'); } catch { /* ignore */ }
                };
                const signal = params.abortController?.signal;
                if (signal) {
                  if (signal.aborted) onAbort();
                  else signal.addEventListener('abort', onAbort, { once: true });
                }

                child.stdout.setEncoding('utf-8');
                child.stdout.on('data', (chunk: string) => {
                  lineBuf += chunk;
                  let idx: number;
                  while ((idx = lineBuf.indexOf('\n')) >= 0) {
                    const line = lineBuf.slice(0, idx).trim();
                    lineBuf = lineBuf.slice(idx + 1);
                    if (!line) continue;
                    let evt: Record<string, unknown>;
                    try { evt = JSON.parse(line); } catch { continue; }
                    handleCopilotEvent(evt, controller, state);
                  }
                });

                child.stderr.setEncoding('utf-8');
                child.stderr.on('data', (chunk: string) => {
                  stderrBuf += chunk;
                  if (stderrBuf.length > MAX_STDERR) stderrBuf = stderrBuf.slice(-MAX_STDERR);
                });

                child.on('error', (err) => {
                  if (signal) signal.removeEventListener('abort', onAbort);
                  reject(err);
                });
                child.on('close', (code) => {
                  if (signal) signal.removeEventListener('abort', onAbort);
                  // Flush any trailing buffered line.
                  const tail = lineBuf.trim();
                  if (tail) {
                    try { handleCopilotEvent(JSON.parse(tail), controller, state); } catch { /* ignore */ }
                  }
                  if (code === 0 || state.hasReceivedResult) {
                    resolve();
                  } else if (signal?.aborted) {
                    // User stop — surface as an error the engine maps to "stopped".
                    reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
                  } else {
                    reject(new Error(`copilot exited with code ${code}`));
                  }
                });
              });

              resolved = true;
              controller.close();
              return;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.error(`[copilot-provider] subprocess error (attempt ${attempt + 1}):`, message);
              if (stderrBuf) console.error('[copilot-provider] stderr:', stderrBuf.trim());

              if (state.hasReceivedResult) {
                // We already streamed a full answer; the non-zero exit is noise.
                controller.close();
                return;
              }

              const combined = `${message}\n${stderrBuf}`;
              const isAbort = (err as { name?: string })?.name === 'AbortError' || params.abortController?.signal.aborted;

              // Retry transient errors once.
              const retryable = !isAbort && !isAuthError(combined) && classifyRetryableError(combined);
              if (retryable && attempt < MAX_RETRIES) {
                console.log(`[copilot-provider] retryable (${retryable}), retrying ${attempt + 2}/${MAX_RETRIES + 1}...`);
                controller.enqueue(sseEvent('retry_notice', {
                  reason: retryable,
                  attempt: attempt + 1,
                  total: MAX_RETRIES + 1,
                  originalError: message.slice(0, 400),
                }));
                if (retryable !== 'usage_policy') await new Promise(r => setTimeout(r, 1500));
                continue;
              }

              let userMessage: string;
              if (isAbort) {
                // Let the engine's catch path label this; emit nothing fancy.
                userMessage = 'Task stopped by user';
              } else if (isAuthError(combined)) {
                userMessage = CLI_AUTH_USER_MESSAGE;
              } else {
                const lines = [message];
                const s = stderrBuf.trim();
                if (s) { lines.push('', 'Copilot stderr:', s.slice(-1024)); }
                userMessage = lines.join('\n');
              }
              if (attempt > 0) userMessage = `[已自动重试 ${attempt} 次仍失败]\n\n${userMessage}`;

              controller.enqueue(sseEvent('error', userMessage));
              controller.close();
              return;
            } finally {
              if (resolved) { /* already closed */ }
            }
          }
        })();
      },
    });
  }
}

// ── Event mapping ──

function handleCopilotEvent(
  evt: Record<string, unknown>,
  controller: ReadableStreamDefaultController<string>,
  state: StreamState,
): void {
  const type = evt.type as string;
  const data = (evt.data ?? {}) as Record<string, unknown>;

  switch (type) {
    case 'assistant.message_delta': {
      // Live tokens drive the streaming card preview ONLY — they are never
      // saved. A message that Copilot abandons mid-stream (e.g. after a tool
      // timeout) leaves orphaned partial deltas; routing them to a preview-only
      // channel keeps those orphans out of the committed/rendered content.
      const delta = data.deltaContent as string | undefined;
      if (delta) {
        controller.enqueue(sseEvent('text_preview', delta));
        state.hasStreamedText = true;
      }
      break;
    }

    case 'assistant.message': {
      // `content` is the authoritative, complete text for this message. We
      // commit it as the saved `text` (instead of accumulating raw deltas), so
      // a restarted/abandoned message contributes nothing stale.
      const content = (data.content as string | undefined) || '';
      const outputTokens = data.outputTokens as number | undefined;
      if (typeof outputTokens === 'number') state.totalOutputTokens += outputTokens;

      if (content) {
        controller.enqueue(sseEvent('text', content));
        state.lastAssistantText += (state.lastAssistantText ? '\n' : '') + content;
      }

      const toolRequests = data.toolRequests as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(toolRequests)) {
        for (const tr of toolRequests) {
          controller.enqueue(sseEvent('tool_use', {
            id: tr.toolCallId,
            name: tr.name,
            input: tr.arguments ?? {},
          }));
        }
      }
      break;
    }

    case 'tool.execution_complete': {
      const result = (data.result ?? {}) as Record<string, unknown>;
      const success = data.success as boolean | undefined;
      const contentText = (result.content as string | undefined)
        ?? (result.detailedContent as string | undefined)
        ?? '';
      controller.enqueue(sseEvent('tool_result', {
        tool_use_id: data.toolCallId,
        content: contentText,
        is_error: success === false,
      }));
      break;
    }

    case 'session.tools_updated': {
      // First model signal — forward as status so the engine can persist the
      // model name. No session_id is available until the final result event.
      const model = data.model as string | undefined;
      if (model) {
        controller.enqueue(sseEvent('status', { model }));
      }
      break;
    }

    case 'result': {
      state.hasReceivedResult = true;
      const sessionId = evt.sessionId as string | undefined;
      const exitCode = evt.exitCode as number | undefined;
      controller.enqueue(sseEvent('result', {
        session_id: sessionId,
        is_error: exitCode !== undefined && exitCode !== 0,
        usage: {
          input_tokens: 0,
          output_tokens: state.totalOutputTokens,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }));
      break;
    }

    case 'error': {
      const msg = (data.message as string | undefined)
        || (typeof evt.message === 'string' ? evt.message : undefined)
        || 'Copilot error';
      controller.enqueue(sseEvent('error', msg));
      break;
    }

    default:
      break;
  }
}
