/**
 * Configuration loader.
 *
 * Reads ./config.env from the project root directory.
 * Runtime data (sessions, logs, PID files) lives in .bridge/ under the project root.
 */

import fs from 'node:fs';
import path from 'node:path';

import { isAgentKind, type AgentKind } from './provider-factory.js';

export interface Config {
  defaultWorkDir: string;
  defaultModel?: string;
  defaultMode: string;
  defaultAgent: AgentKind;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuDomain: string;
  feishuAllowedUsers?: string[];
  feishuRequireMention: boolean;
  feishuRequestTimeoutMs: number;
  autoApprove: boolean;
  codexBaseUrl?: string;
  codexAuthEnvKey?: string;
  codexProviderName?: string;
  eurekaMcpUrl: string;
  eurekaCallerSessionId?: string;
  eurekaAgentEngine?: 'claude' | 'codex' | 'copilot' | 'pi';
  eurekaThinkingLevel?: 'off' | 'think' | 'max';
  eurekaEnabledSourceSlugs?: string[];
  eurekaTurnTimeoutMs: number;
  outboxPort: number;
  agentFirstEventTimeoutMs: number;
  agentIdleTimeoutMs: number;
  agentMaxTurnTimeoutMs: number;
}

/**
 * Project root — launchd sets WorkingDirectory to the project dir,
 * and `npm run dev` also runs from the project dir, so cwd() is reliable.
 */
const PROJECT_DIR = process.cwd();

/** All data lives under the project directory by default. Override with CTI_HOME env var. */
export const CTI_HOME = process.env.CTI_HOME || path.join(PROJECT_DIR, '.bridge');
export const CONFIG_PATH = path.join(PROJECT_DIR, 'config.env');

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function positiveInt(value: string | undefined, fallback: number, minimum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

export function loadConfig(): Config {
  let env = new Map<string, string>();
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    env = parseEnvFile(content);
    for (const [key, value] of env) {
      process.env[key] = value;
    }
  } catch {
    // Config file doesn't exist yet — use defaults
  }

  const get = (key: string): string | undefined => env.get(key) || process.env[key];
  const has = (key: string): boolean => env.has(key) || process.env[key] !== undefined;
  const rawAgent = (get('CTI_DEFAULT_AGENT') || 'claude').toLowerCase();
  const defaultAgent: AgentKind = isAgentKind(rawAgent) ? rawAgent : 'claude';
  if (rawAgent !== defaultAgent) {
    console.warn(`[config] CTI_DEFAULT_AGENT="${rawAgent}" is not supported — falling back to "claude"`);
  }

  const rawEurekaEngine = get('CTI_EUREKA_AGENT_ENGINE')?.toLowerCase();
  const eurekaAgentEngine = rawEurekaEngine && ['claude', 'codex', 'copilot', 'pi'].includes(rawEurekaEngine)
    ? rawEurekaEngine as Config['eurekaAgentEngine']
    : undefined;
  if (rawEurekaEngine && !eurekaAgentEngine) console.warn(`[config] Ignoring invalid CTI_EUREKA_AGENT_ENGINE="${rawEurekaEngine}"`);
  const rawThinking = get('CTI_EUREKA_THINKING_LEVEL')?.toLowerCase();
  const eurekaThinkingLevel = rawThinking && ['off', 'think', 'max'].includes(rawThinking)
    ? rawThinking as Config['eurekaThinkingLevel']
    : undefined;
  if (rawThinking && !eurekaThinkingLevel) console.warn(`[config] Ignoring invalid CTI_EUREKA_THINKING_LEVEL="${rawThinking}"`);

  return {
    defaultWorkDir: get('CTI_DEFAULT_WORKDIR') || process.cwd(),
    defaultModel: get('CTI_DEFAULT_MODEL') || undefined,
    defaultMode: get('CTI_DEFAULT_MODE') || 'code',
    defaultAgent,
    feishuAppId: get('CTI_FEISHU_APP_ID') || '',
    feishuAppSecret: get('CTI_FEISHU_APP_SECRET') || '',
    feishuDomain: get('CTI_FEISHU_DOMAIN') || 'feishu',
    feishuAllowedUsers: splitCsv(get('CTI_FEISHU_ALLOWED_USERS')),
    feishuRequireMention: has('CTI_FEISHU_REQUIRE_MENTION')
      ? get('CTI_FEISHU_REQUIRE_MENTION') !== 'false'
      : true,
    autoApprove: get('CTI_AUTO_APPROVE') === 'true',
    feishuRequestTimeoutMs: positiveInt(get('CTI_FEISHU_REQUEST_TIMEOUT_MS'), 30_000, 1_000),
    codexBaseUrl: get('CTI_CODEX_BASE_URL') || get('OPENAI_BASE_URL') || get('ANTHROPIC_BASE_URL'),
    codexAuthEnvKey: get('CTI_CODEX_AUTH_ENV_KEY'),
    codexProviderName: get('CTI_CODEX_PROVIDER_NAME') || 'LLM Proxy',
    eurekaMcpUrl: get('CTI_EUREKA_MCP_URL') || 'http://127.0.0.1:21900/mcp',
    eurekaCallerSessionId: get('CTI_EUREKA_CALLER_SESSION_ID'),
    eurekaAgentEngine,
    eurekaThinkingLevel,
    eurekaEnabledSourceSlugs: splitCsv(get('CTI_EUREKA_ENABLED_SOURCES')),
    eurekaTurnTimeoutMs: positiveInt(get('CTI_EUREKA_TURN_TIMEOUT_MS'), 1_800_000, 30_000),
    outboxPort: positiveInt(get('CTI_OUTBOX_PORT'), 59_991, 1_024),
    agentFirstEventTimeoutMs: positiveInt(get('CTI_AGENT_FIRST_EVENT_TIMEOUT_MS'), 120_000, 10_000),
    agentIdleTimeoutMs: positiveInt(get('CTI_AGENT_IDLE_TIMEOUT_MS'), 600_000, 30_000),
    agentMaxTurnTimeoutMs: positiveInt(get('CTI_AGENT_MAX_TURN_TIMEOUT_MS'), 7_200_000, 60_000),
  };
}
