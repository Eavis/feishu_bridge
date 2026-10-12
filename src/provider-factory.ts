/**
 * Provider abstraction for the bridge's pluggable local agent backends.
 *
 *   - claude  : in-process @anthropic-ai/claude-agent-sdk (ClaudeProvider)
 *   - copilot : spawned `node npm-loader.js -p ...` subprocess (CopilotProvider)
 *
 * All providers expose the same public surface (`streamChat(params) →
 * ReadableStream<string>` of SSE events), so unification is just a shared
 * interface + a lazy factory.
 *
 * The factory:
 *   - Resolves + preflights each backend ON FIRST USE (not at startup), so a
 *     missing Copilot CLI doesn't block a Claude-only user, and vice versa.
 *   - Caches the constructed provider per kind so we don't re-preflight per
 *     message.
 *   - Throws an informative error if the requested backend cannot be started —
 *     the bridge surfaces this to the user via the SSE `error` event.
 */

import type { Config } from './config.js';
import type { PendingPermissions } from './permissions.js';
import type { StreamChatParams } from './types.js';
import {
  ClaudeProvider,
  preflightCheck as preflightClaude,
  resolveClaudeCliPath,
} from './claude-provider.js';
import {
  CopilotProvider,
  preflightCopilot,
  resolveCopilotLoaderPath,
} from './copilot-provider.js';
import {
  CodexProvider,
  preflightCodex,
  resolveCodexLaunchSpec,
} from './codex-provider.js';
import { EurekaProvider } from './eureka-provider.js';

export type AgentKind = 'claude' | 'copilot' | 'codex' | 'eureka';

export const SUPPORTED_AGENTS: readonly AgentKind[] = ['claude', 'copilot', 'codex', 'eureka'] as const;

export function isAgentKind(value: string): value is AgentKind {
  return (SUPPORTED_AGENTS as readonly string[]).includes(value);
}

export interface Provider {
  streamChat(params: StreamChatParams): ReadableStream<string>;
  /** Optional live readiness check for remote/local-service providers. */
  preflight?(): Promise<{ ok: boolean; version?: string; error?: string }>;
}

export type ProviderFactory = (kind: AgentKind) => Provider;

class ProviderUnavailableError extends Error {
  constructor(kind: AgentKind, reason: string) {
    super(`Backend "${kind}" is unavailable: ${reason}`);
    this.name = 'ProviderUnavailableError';
  }
}

interface PreflightResult {
  ok: boolean;
  version?: string;
  error?: string;
}

function buildClaude(
  pendingPerms: PendingPermissions,
  config: Config,
): { provider: Provider; preflight: PreflightResult; path?: string } {
  const cliPath = resolveClaudeCliPath();
  if (!cliPath) {
    return {
      provider: null as unknown as Provider,
      preflight: { ok: false, error: 'Claude Code CLI not found in PATH or CTI_CLAUDE_CODE_EXECUTABLE' },
    };
  }
  const check = preflightClaude(cliPath);
  if (!check.ok) {
    return { provider: null as unknown as Provider, preflight: check, path: cliPath };
  }
  const provider = new ClaudeProvider(pendingPerms, cliPath, config.autoApprove, config.defaultModel);
  return { provider, preflight: check, path: cliPath };
}

function buildCopilot(
  pendingPerms: PendingPermissions,
  config: Config,
): { provider: Provider; preflight: PreflightResult; path?: string } {
  const loaderPath = resolveCopilotLoaderPath();
  if (!loaderPath) {
    return {
      provider: null as unknown as Provider,
      preflight: { ok: false, error: 'GitHub Copilot CLI not found — install with `npm i -g @github/copilot` or set CTI_COPILOT_EXECUTABLE' },
    };
  }
  const check = preflightCopilot(loaderPath);
  if (!check.ok) {
    return { provider: null as unknown as Provider, preflight: check, path: loaderPath };
  }
  const provider = new CopilotProvider(pendingPerms, loaderPath, config.autoApprove, config.defaultModel);
  return { provider, preflight: check, path: loaderPath };
}

function firstPresentEnv(keys: string[]): string | undefined {
  return keys.find(key => Boolean(process.env[key]));
}

function buildCodex(config: Config): { provider: Provider; preflight: PreflightResult; path?: string } {
  const baseUrl = config.codexBaseUrl;
  if (!baseUrl) {
    return {
      provider: null as unknown as Provider,
      preflight: { ok: false, error: 'Codex backend requires a proxy URL. Set CTI_CODEX_BASE_URL (preferred) or OPENAI_BASE_URL. It will not fall back to ChatGPT.' },
    };
  }

  const authEnvKey = config.codexAuthEnvKey || firstPresentEnv(['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  if (!authEnvKey || !process.env[authEnvKey]) {
    return {
      provider: null as unknown as Provider,
      preflight: { ok: false, error: 'Codex backend requires a proxy auth env var. Set CTI_CODEX_AUTH_ENV_KEY to an env var that exists, e.g. ANTHROPIC_AUTH_TOKEN or OPENAI_API_KEY.' },
    };
  }

  const spec = resolveCodexLaunchSpec();
  if (!spec) {
    return {
      provider: null as unknown as Provider,
      preflight: { ok: false, error: 'OpenAI Codex CLI not found - install @openai/codex or set CTI_CODEX_EXECUTABLE' },
    };
  }
  const check = preflightCodex(spec);
  if (!check.ok) return { provider: null as unknown as Provider, preflight: check, path: spec.executable };
  return {
    provider: new CodexProvider(spec, {
      baseUrl,
      authEnvKey,
      providerName: config.codexProviderName,
    }, config.defaultModel),
    preflight: check,
    path: spec.executable,
  };
}

function buildEureka(
  pendingPerms: PendingPermissions,
  config: Config,
): { provider: Provider; preflight: PreflightResult; path?: string } {
  try {
    const provider = new EurekaProvider(pendingPerms, {
      endpoint: config.eurekaMcpUrl,
      callerSessionId: config.eurekaCallerSessionId,
      agentEngine: config.eurekaAgentEngine,
      thinkingLevel: config.eurekaThinkingLevel,
      enabledSourceSlugs: config.eurekaEnabledSourceSlugs,
      turnTimeoutMs: config.eurekaTurnTimeoutMs,
      autoApprove: config.autoApprove,
    });
    return { provider, preflight: { ok: true, version: 'live preflight on switch/first turn' }, path: config.eurekaMcpUrl };
  } catch (err) {
    return { provider: null as unknown as Provider, preflight: { ok: false, error: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * Build a memoized factory that returns the provider for a given AgentKind.
 *
 * Optionally eager-preflight the default backend so startup logs surface a
 * clear error early instead of waiting until first message. The non-default
 * backend always preflights lazily.
 */
export function createProviderFactory(
  config: Config,
  pendingPerms: PendingPermissions,
  opts?: { eagerPreflight?: AgentKind },
): ProviderFactory {
  const cache = new Map<AgentKind, Provider>();
  const failed = new Map<AgentKind, string>();

  function get(kind: AgentKind): Provider {
    const cached = cache.get(kind);
    if (cached) return cached;
    const prevFail = failed.get(kind);
    if (prevFail) throw new ProviderUnavailableError(kind, prevFail);

    const result = kind === 'claude'
      ? buildClaude(pendingPerms, config)
      : kind === 'copilot'
        ? buildCopilot(pendingPerms, config)
        : kind === 'codex'
          ? buildCodex(config)
          : buildEureka(pendingPerms, config);

    if (!result.preflight.ok) {
      const reason = result.preflight.error || 'unknown preflight failure';
      failed.set(kind, reason);
      throw new ProviderUnavailableError(kind, reason);
    }

    console.log(`[provider-factory] ${kind} ready: ${result.path} (${result.preflight.version ?? 'preflight ok'})`);
    cache.set(kind, result.provider);
    return result.provider;
  }

  if (opts?.eagerPreflight) {
    try {
      get(opts.eagerPreflight);
    } catch (err) {
      throw err;
    }
  }

  return get;
}
