// OpenAI Codex CLI provider. Runs bounded `codex exec --json` turns and maps
// Codex JSONL events to the bridge's SSE vocabulary.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { StreamChatParams, FileAttachment, TokenUsage } from './types.js';

// Verified against the connected Codex provider catalog. The friendly
// `gpt6`/`gpt-6` aliases are normalized by the bridge command handler.
export const DEFAULT_CODEX_MODEL = 'gpt-6-astra';

export interface CodexLaunchSpec {
  executable: string;
  prefixArgs: string[];
}

export interface CodexProxyConfig {
  baseUrl: string;
  authEnvKey: string;
  providerName?: string;
}

function sseEvent(type: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: payload })}\n`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function normalizeOpenAiBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function buildCodexConfigArgs(proxy: CodexProxyConfig): string[] {
  const providerId = 'llmproxy';
  const baseUrl = normalizeOpenAiBaseUrl(proxy.baseUrl);
  const name = proxy.providerName || 'LLM Proxy';
  return [
    '-c', `model_provider=${tomlString(providerId)}`,
    '-c', `model_providers.${providerId}.name=${tomlString(name)}`,
    '-c', `model_providers.${providerId}.base_url=${tomlString(baseUrl)}`,
    '-c', `model_providers.${providerId}.env_key=${tomlString(proxy.authEnvKey)}`,
    '-c', `model_providers.${providerId}.wire_api=${tomlString('responses')}`,
  ];
}
export function buildSubprocessEnv(codexHome?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'CLAUDECODE' || key === 'CLAUDE_CODE_ENTRYPOINT'
      || key === 'CODEX_HOME' || key === 'CODEX_THREAD_ID') continue;
    out[key] = value;
  }
  if (codexHome) out.CODEX_HOME = codexHome;
  return out;
}

function childDirectories(parent: string): string[] {
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(parent, entry.name));
  } catch { return []; }
}

/**
 * Codex stores rollouts underneath the CODEX_HOME that created them. Eureka
 * gives each task a private .codex-home, while standalone Codex uses ~/.codex.
 * A daemon started from inside Eureka can inherit the current task's
 * CODEX_HOME, so never assume that inherited value owns every thread.
 */
export function discoverCodexHomes(): string[] {
  const homes = new Set<string>();
  if (process.env.CTI_CODEX_HOME) homes.add(path.resolve(process.env.CTI_CODEX_HOME));
  if (process.env.CODEX_HOME) homes.add(path.resolve(process.env.CODEX_HOME));
  homes.add(path.join(os.homedir(), '.codex'));

  for (const userRoot of childDirectories(os.homedir())) {
    const name = path.basename(userRoot);
    if (name !== '.eureka' && name !== '.craft-agent' && !name.startsWith('.eureka-')) continue;
    for (const workspace of childDirectories(path.join(userRoot, 'workspaces'))) {
      for (const session of childDirectories(path.join(workspace, 'sessions'))) {
        const candidate = path.join(session, '.codex-home');
        if (fs.existsSync(path.join(candidate, 'sessions'))) homes.add(candidate);
      }
    }
  }
  return [...homes];
}

function containsRollout(dir: string, threadId: string): boolean {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && containsRollout(full, threadId)) return true;
    if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) return true;
  }
  return false;
}

const threadHomeCache = new Map<string, string>();

export function findCodexHomeForThread(threadId: string, homes = discoverCodexHomes()): string | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) return undefined;
  const cached = threadHomeCache.get(threadId);
  if (cached && fs.existsSync(path.join(cached, 'sessions'))) return cached;
  for (const home of homes) {
    if (containsRollout(path.join(home, 'sessions'), threadId)) {
      threadHomeCache.set(threadId, home);
      return home;
    }
  }
  return undefined;
}

function existingFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  try { return fs.statSync(filePath).isFile() ? path.resolve(filePath) : undefined; } catch { return undefined; }
}

function specFor(candidate: string | undefined): CodexLaunchSpec | undefined {
  const file = existingFile(candidate);
  if (!file) return undefined;
  if (/\.m?js$/i.test(file)) return { executable: process.execPath, prefixArgs: [file] };
  if (/\.cmd$/i.test(file)) {
    const js = existingFile(path.join(path.dirname(file), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    if (js) return { executable: process.execPath, prefixArgs: [js] };
  }
  return { executable: file, prefixArgs: [] };
}

function npmRoots(): string[] {
  const roots = new Set<string>();
  for (const value of [process.env.NPM_CONFIG_PREFIX, process.env.npm_config_prefix, process.env.APPDATA && path.join(process.env.APPDATA, 'npm')]) {
    if (value) roots.add(value);
  }
  try {
    const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    if (prefix) roots.add(prefix);
  } catch { /* npm unavailable */ }
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (entry) roots.add(entry);
  }
  return [...roots];
}

export function resolveCodexLaunchSpec(): CodexLaunchSpec | undefined {
  const override = process.env.CTI_CODEX_EXECUTABLE;
  const direct = specFor(override);
  if (direct) return direct;

  const archPackage = process.arch === 'arm64'
    ? '@openai/codex-win32-arm64'
    : '@openai/codex-win32-x64';
  const vendorTriple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';

  for (const root of npmRoots()) {
    const candidates = [
      path.join(root, process.platform === 'win32' ? 'codex.exe' : 'codex'),
      path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
      path.join(root, 'node_modules', '@openai', 'codex', 'vendor', vendorTriple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
      path.join(root, 'node_modules', archPackage, 'vendor', vendorTriple, 'codex', process.platform === 'win32' ? 'codex.exe' : 'codex'),
      path.join(root, 'node_modules', archPackage, 'vendor', vendorTriple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    ];
    for (const candidate of candidates) {
      const spec = specFor(candidate);
      if (spec) return spec;
    }
  }
  return undefined;
}

function probe(spec: CodexLaunchSpec, args: string[]): string {
  return execFileSync(spec.executable, [...spec.prefixArgs, ...args], {
    encoding: 'utf8', timeout: 15_000, env: buildSubprocessEnv(), windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function preflightCodex(spec: CodexLaunchSpec): { ok: boolean; version?: string; error?: string } {
  try {
    const version = probe(spec, ['--version']);
    const help = probe(spec, ['--help']);
    const execHelp = probe(spec, ['exec', '--help']);
    const resumeHelp = probe(spec, ['exec', 'resume', '--help']);
    const missing = [
      !help.includes('exec') && 'exec',
      !execHelp.includes('--json') && '--json',
      !execHelp.includes('--sandbox') && '--sandbox',
      !execHelp.includes('--model') && '--model',
      !execHelp.includes('--skip-git-repo-check') && '--skip-git-repo-check',
      !resumeHelp.toLowerCase().includes('resume') && 'exec resume',
    ].filter(Boolean);
    if (missing.length) return { ok: false, version, error: `Codex CLI is missing required capabilities: ${missing.join(', ')}` };
    return { ok: true, version };
  } catch (err) {
    return { ok: false, error: `Codex CLI preflight failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function attachmentHint(file: FileAttachment): string {
  return `- ${file.name} (${file.type}): ${file.filePath}`;
}

function buildPrompt(params: StreamChatParams): { prompt: string; images: string[] } {
  const files = (params.files || []).filter(file => file.filePath);
  const images = files.filter(file => file.type.startsWith('image/')).map(file => file.filePath!);
  const docs = files.filter(file => !file.type.startsWith('image/'));
  const model = params.model || DEFAULT_CODEX_MODEL;
  const sections = [
    '请始终用简体中文回复，除非用户明确要求其他语言。',
    `运行时身份：你由 OpenAI Codex CLI backend 驱动，本轮实际指定的模型 ID 是 \`${model}\`。当用户询问你正在使用哪个模型时，必须原样回答这个完整模型 ID，不要笼统回答 GPT-5，也不要根据训练数据猜测。`,
    params.systemPrompt?.trim() || '',
    params.prompt,
  ].filter(Boolean);
  if (docs.length) {
    sections.push(`用户上传的附件已保存到本机，请读取后处理：\n${docs.map(attachmentHint).join('\n')}`);
  }
  return { prompt: sections.join('\n\n---\n\n'), images };
}

export interface CodexState {
  threadId?: string;
  model?: string;
  completed: boolean;
  sawError: boolean;
  usage?: TokenUsage;
  startedTools: Set<string>;
}

export function mapCodexEvent(
  event: Record<string, unknown>,
  emit: (type: string, data: unknown) => void,
  state: CodexState,
): void {
  const type = String(event.type || '');
  if (type === 'thread.started') {
    const threadId = typeof event.thread_id === 'string' ? event.thread_id : undefined;
    if (threadId) {
      state.threadId = threadId;
      emit('status', { session_id: threadId, model: state.model || DEFAULT_CODEX_MODEL });
    }
    return;
  }
  if (type === 'turn.completed') {
    const raw = (event.usage || {}) as Record<string, unknown>;
    state.usage = {
      input_tokens: Number(raw.input_tokens || 0),
      output_tokens: Number(raw.output_tokens || 0),
      cache_read_input_tokens: Number(raw.cached_input_tokens || 0),
      cache_creation_input_tokens: Number(raw.cache_write_input_tokens || 0),
    };
    state.completed = true;
    emit('result', { session_id: state.threadId, usage: state.usage, is_error: false });
    return;
  }
  if (type === 'turn.failed' || type === 'error') {
    const error = (event.error || {}) as Record<string, unknown>;
    const message = String(error.message || event.message || 'Codex turn failed');
    state.sawError = true;
    emit('error', message);
    return;
  }
  if (!type.startsWith('item.')) return;

  const item = (event.item || {}) as Record<string, unknown>;
  const itemType = String(item.type || '');
  const id = String(item.id || `${itemType || 'item'}-${state.startedTools.size + 1}`);
  if (itemType === 'agent_message' && type === 'item.completed') {
    const text = String(item.text || '');
    if (text) emit('text', text);
    return;
  }
  if (itemType === 'reasoning') return;

  const toolLike = ['command_execution', 'mcp_tool_call', 'file_change', 'web_search', 'collab_tool_call', 'todo_list'].includes(itemType);
  if (!toolLike) return;
  const name = itemType === 'command_execution' ? 'powershell'
    : itemType === 'mcp_tool_call' ? `${String(item.server || 'mcp')}.${String(item.tool || 'tool')}`
      : itemType;
  if ((type === 'item.started' || type === 'item.updated') && !state.startedTools.has(id)) {
    state.startedTools.add(id);
    emit('tool_use', { id, name, input: item.arguments || { command: item.command, changes: item.changes } });
  }
  if (type === 'item.completed') {
    if (!state.startedTools.has(id)) emit('tool_use', { id, name, input: item.arguments || { command: item.command, changes: item.changes } });
    const result = item.result as Record<string, unknown> | undefined;
    const content = String(item.aggregated_output || result?.content || item.status || 'completed');
    const failed = Number(item.exit_code || 0) !== 0 || Boolean(item.error) || item.status === 'failed';
    emit('tool_result', { tool_use_id: id, content, is_error: failed });
  }
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  // Windows can lose the child `close` event after taskkill, while inherited
  // stdio handles keep this Node process alive. Release our handles eagerly;
  // taskkill continues independently in the background.
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.unref();
    } catch { child.kill(); }
  } else {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
  }
}

export class CodexProvider {
  constructor(
    private spec: CodexLaunchSpec,
    private proxy: CodexProxyConfig,
    private defaultModel = DEFAULT_CODEX_MODEL,
    private codexHomes?: string[],
  ) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const spec = this.spec;
    const defaultModel = this.defaultModel;
    const configArgs = buildCodexConfigArgs(this.proxy);
    const codexHomes = this.codexHomes;
    return new ReadableStream<string>({
      start(controller) {
        let finished = false;
        const state: CodexState = {
          model: params.model || defaultModel,
          completed: false,
          sawError: false,
          startedTools: new Set(),
        };
        const emit = (type: string, data: unknown) => {
          if (!finished) controller.enqueue(sseEvent(type, data));
        };
        const finish = () => {
          if (finished) return;
          finished = true;
          controller.close();
        };
        const { prompt, images } = buildPrompt(params);
        const args = [...spec.prefixArgs, ...configArgs, 'exec', '--json'];
        const resumeHome = params.sdkSessionId && !params.forkSession
          ? findCodexHomeForThread(params.sdkSessionId, codexHomes || discoverCodexHomes())
          : undefined;
        const stableHome = process.env.CTI_CODEX_HOME
          ? path.resolve(process.env.CTI_CODEX_HOME)
          : path.join(os.homedir(), '.codex');
        if (params.sdkSessionId && !params.forkSession && resumeHome) {
          args.push('resume', '--skip-git-repo-check', params.sdkSessionId);
        } else {
          if (params.sdkSessionId && !params.forkSession) {
            emit('retry_notice', {
              reason: 'saved Codex thread is not present in any known CODEX_HOME; starting a fresh thread',
              attempt: 1,
              total: 1,
              originalError: `No rollout found for thread ${params.sdkSessionId}`,
            });
          }
          args.push('--skip-git-repo-check', '--sandbox', 'workspace-write', '--color', 'never');
          if (params.workingDirectory) args.push('-C', params.workingDirectory);
        }
        args.push('--model', params.model || defaultModel);
        for (const image of images) args.push('--image', image);
        args.push('-');

        let stderr = '';
        let lineBuffer = '';
        const child = spawn(spec.executable, args, {
          cwd: params.workingDirectory || process.cwd(), env: buildSubprocessEnv(resumeHome || stableHome),
          stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
        });
        const abort = () => {
          if (finished) return;
          if (signal) signal.removeEventListener('abort', abort);
          // Detach provider listeners before destroying the pipes. Keeping a
          // `close` listener on a Windows child whose close notification was
          // lost can keep Node's test worker (and occasionally the daemon
          // shutdown path) alive after the bridge stream has already closed.
          child.stdout.removeAllListeners('data');
          child.stderr.removeAllListeners('data');
          child.removeAllListeners('close');
          child.removeAllListeners('error');
          child.on('error', () => {});
          terminateChild(child);
          emit('error', 'Task stopped by user');
          // Never wait for Windows child-process `close`: it can be lost when
          // taskkill terminates a process tree. Closing now releases the bridge
          // session lock; terminateChild continues cleanup independently.
          finish();
        };
        const signal = params.abortController?.signal;
        if (signal) {
          if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        }
        child.stdin.end(prompt, 'utf8');
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          lineBuffer += chunk;
          let newline: number;
          while ((newline = lineBuffer.indexOf('\n')) >= 0) {
            const line = lineBuffer.slice(0, newline).trim();
            lineBuffer = lineBuffer.slice(newline + 1);
            if (!line) continue;
            try { mapCodexEvent(JSON.parse(line), emit, state); } catch { /* tolerate future/malformed events */ }
          }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
        child.on('error', err => {
          if (finished) return;
          if (signal) signal.removeEventListener('abort', abort);
          emit('error', `Codex failed to start: ${err.message}`);
          finish();
        });
        child.on('close', code => {
          if (finished) return;
          if (signal) signal.removeEventListener('abort', abort);
          const tail = lineBuffer.trim();
          if (tail) { try { mapCodexEvent(JSON.parse(tail), emit, state); } catch { /* ignore */ } }
          if (signal?.aborted) emit('error', 'Task stopped by user');
          else if (!state.completed && !state.sawError) emit('error', `Codex exited with code ${code}${stderr.trim() ? `\n\nCodex stderr:\n${stderr.trim()}` : ''}`);
          finish();
        });
      },
    });
  }
}
