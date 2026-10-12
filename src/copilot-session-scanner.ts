/**
 * Copilot CLI Session Scanner — discovers local GitHub Copilot CLI sessions.
 *
 * Reads ~/.copilot/session-state/<uuid>/workspace.yaml directly. We avoid
 * adding a YAML dependency because the file is shallow and we only need a
 * handful of well-known keys (id, cwd, name, created_at, updated_at).
 *
 * The `name:` field, when present, is Copilot's auto-derived first-prompt
 * digest — perfect for the same role as Claude's `firstPrompt`.
 *
 * Override the session root with CTI_COPILOT_SESSION_DIR if Copilot's home
 * differs (must match the path used by cloneCopilotSession in bridge.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CliSessionInfo } from './types.js';

function copilotSessionDir(): string {
  return process.env.CTI_COPILOT_SESSION_DIR
    || path.join(os.homedir(), '.copilot', 'session-state');
}

/**
 * Tiny YAML extractor — handles the subset Copilot writes:
 *   key: value                        (single-line)
 *   key: |-                           (literal block, dedented)
 *     line 1
 *     line 2
 *   key: "value"                      (quoted)
 *
 * Returns a flat map. Lines we don't recognize are ignored, not raised —
 * a future Copilot release that adds new keys must not break this scanner.
 */
function parseWorkspaceYaml(content: string): Record<string, string> {
  const lines = content.split(/\r?\n/);
  const result: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    let val = m[2];

    // Literal block scalar: subsequent indented lines, dedented by the leading
    // indent of the first content line.
    if (val === '|-' || val === '|' || val === '>') {
      i++;
      const collected: string[] = [];
      let indent: number | null = null;
      while (i < lines.length) {
        const next = lines[i];
        if (!/^\s/.test(next) && next !== '') break;
        if (indent === null) {
          const im = next.match(/^(\s+)/);
          indent = im ? im[1].length : 0;
        }
        collected.push(next.slice(indent));
        i++;
      }
      val = collected.join('\n').replace(/\n+$/, '');
    } else {
      i++;
      // Strip surrounding quotes if present.
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
    }
    result[key] = val;
  }
  return result;
}

interface ScanOptions {
  limit?: number;
  maxAgeDays?: number;
}

export function scanCopilotSessions(opts?: ScanOptions): CliSessionInfo[] {
  const limit = opts?.limit ?? 20;
  const maxAgeDays = opts?.maxAgeDays ?? 30;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const base = copilotSessionDir();

  let entries: string[];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return [];
  }

  const results: CliSessionInfo[] = [];
  for (const entry of entries) {
    const dir = path.join(base, entry);
    const yamlPath = path.join(dir, 'workspace.yaml');
    let dirStat: fs.Stats;
    try {
      dirStat = fs.statSync(dir);
    } catch { continue; }
    if (!dirStat.isDirectory()) continue;

    let yamlStat: fs.Stats;
    try {
      yamlStat = fs.statSync(yamlPath);
    } catch { continue; }

    // Use the latest activity timestamp from either workspace.yaml or the
    // session db file (the db gets written on every turn).
    let activityMs = yamlStat.mtimeMs;
    try {
      const dbStat = fs.statSync(path.join(dir, 'session.db'));
      if (dbStat.mtimeMs > activityMs) activityMs = dbStat.mtimeMs;
    } catch { /* no db yet */ }

    if (activityMs < cutoff) continue;

    let yaml: Record<string, string>;
    try {
      yaml = parseWorkspaceYaml(fs.readFileSync(yamlPath, 'utf-8'));
    } catch { continue; }

    const sdkSessionId = yaml.id || entry;
    const cwd = yaml.cwd || '';
    const project = cwd ? path.basename(cwd) : '';
    // Copilot's `name` is the auto-derived first-prompt digest. Strip the
    // bridge's persistent language directive prefix so the listed prompt
    // shows the user's actual question, not the boilerplate.
    let firstPrompt = (yaml.name || '').trim();
    const directiveEnd = firstPrompt.indexOf('---');
    if (directiveEnd > 0 && firstPrompt.startsWith('【输出语言】')) {
      firstPrompt = firstPrompt.slice(directiveEnd + 3).trim();
    }

    // "Open" means the session had activity in the last 5 minutes — Copilot
    // doesn't write a `last-prompt` marker the way Claude does.
    const isOpen = (Date.now() - activityMs) < 5 * 60 * 1000;

    results.push({
      sdkSessionId,
      project,
      cwd,
      firstPrompt: firstPrompt.slice(0, 200) || '(Copilot session — no prompt captured)',
      slug: '',
      timestamp: activityMs,
      isOpen,
      backend: 'copilot',
    });
  }

  results.sort((a, b) => b.timestamp - a.timestamp);
  return results.slice(0, limit);
}
