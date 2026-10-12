# Feishu Bridge — Claude Code / Copilot / Codex / Eureka

A Node daemon that connects a Feishu (Lark) bot to a **switchable** local coding-agent backend:

- **`claude`** — in-process [@anthropic-ai/claude-agent-sdk](https://docs.anthropic.com/en/docs/claude-code) (per-tool permission gating, native `forkSession`)
- **`copilot`** — spawned [GitHub Copilot CLI](https://github.com/github/copilot-cli) subprocess (`--allow-all-tools` always; file-level `--resume` session continuity)
- **`codex`** — spawned OpenAI Codex CLI using structured `exec --json`, forced through your configured OpenAI-compatible LLM proxy; defaults to `gpt-6-astra` and supports durable `exec resume`
- **`eureka`** — creates and resumes real Eureka desktop tasks through its local Streamable HTTP MCP, including progress, attachments, permissions, cancellation, and deep links

Each chat picks its backend independently via `/agent claude|copilot|codex|eureka`; the default is `CTI_DEFAULT_AGENT` in `config.env`. The bridge delegates to local agent runtimes; the Codex backend is explicitly configured to use your LLM proxy instead of ChatGPT account quota.

This is a unification of two earlier forks (`feishu-claude-bridge` + `feishu-copilot-bridge`) behind a shared `Provider` interface.

---

## 1. Prerequisites

| Dependency | Notes |
|---|---|
| **Node.js ≥ 20** | `node --version` (22 recommended) |
| **At least one agent CLI** | Pick the one(s) you want — see below |
| **Feishu enterprise self-built app** | See "Feishu App Setup" below |

Install whichever agent CLI you want to use:

```bash
# Claude Code (one or both)
npm install -g @anthropic-ai/claude-code
claude            # one-time login

# GitHub Copilot CLI
npm install -g @github/copilot
copilot           # one-time GitHub auth
copilot --version # confirm it works

# OpenAI Codex CLI
npm install -g @openai/codex
codex --version
# Configure CTI_CODEX_BASE_URL / CTI_CODEX_AUTH_ENV_KEY in config.env
```

At startup the bridge preflights only the **default** agent. Switching via `/agent` preflights the selected backend lazily; `/agent eureka` performs a live desktop MCP check before saving the switch.

---

## 2. Install & Build

```bash
cd feishu-bridge
npm ci
npm run build      # esbuild bundles src/ → dist/daemon.mjs
```

The committed lockfile pins the dependency tree used by the regression tests.

---

## 3. Configure `config.env`

```bash
cp config.env.example config.env
```

Key fields (see `config.env.example` for the full annotated reference):

```bash
# ── Required ──
CTI_FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
CTI_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
CTI_DEFAULT_WORKDIR=C:\projects                  # agent working dir; file send-backs land here

# ── Backend ──
CTI_DEFAULT_AGENT=claude                       # claude | copilot | codex | eureka

# ── Common optional ──
CTI_FEISHU_DOMAIN=feishu                       # feishu (default) or lark
CTI_FEISHU_REQUIRE_MENTION=false               # reply in groups without @ (needs im:message.group_msg scope)
CTI_DEFAULT_MODE=code                          # code / plan / ask
# CTI_DEFAULT_MODEL=                           # blank = each backend's default
# CTI_FEISHU_ALLOWED_USERS=ou_xxx,ou_yyy       # access allowlist (open_id/chatId; empty = all)
# CTI_CLAUDE_CODE_EXECUTABLE=                  # override claude CLI path
# CTI_COPILOT_EXECUTABLE=                      # override copilot CLI path
# CTI_CODEX_EXECUTABLE=                        # override codex CLI path

# ── Codex proxy (required when using /agent codex) ──
CTI_CODEX_BASE_URL=http://localhost:5000        # OpenAI-compatible proxy; /v1 is added if omitted
CTI_CODEX_AUTH_ENV_KEY=ANTHROPIC_AUTH_TOKEN     # env var containing the proxy credential
CTI_CODEX_PROVIDER_NAME=LLM Proxy               # label shown in Codex provider config
CTI_AUTO_APPROVE=true                          # see note below
```

### About Codex proxy configuration

The `codex` backend does not use the Codex CLI ChatGPT account/quota path. The bridge injects a temporary Codex provider config on every `codex exec --json` call:

```bash
CTI_CODEX_BASE_URL=http://localhost:5000
CTI_CODEX_AUTH_ENV_KEY=ANTHROPIC_AUTH_TOKEN
CTI_CODEX_PROVIDER_NAME=LLM Proxy
```

If `CTI_CODEX_BASE_URL` or the configured auth env var is missing, `/agent codex` fails fast instead of falling back to ChatGPT.

### About `CTI_AUTO_APPROVE`

`copilot` non-interactive mode **forces `--allow-all-tools`** (tools always auto-approved), so this flag is effectively true in copilot mode regardless. For the `claude` backend it gates per-tool permission cards — set `true` to skip the Allow/Allow-Session/Deny prompts.



---

## 4. Feishu App Setup

In the [Feishu Open Platform](https://open.feishu.cn/app), create an **enterprise self-built app**:

1. Enable the **Bot** capability
2. **Events & Callbacks** → choose **Use persistent connection** (WebSocket — no public callback URL needed)
3. Subscribe to event: `im.message.receive_v1`
4. Add permission scopes:

   | Scope | Purpose |
   |---|---|
   | `im:message` / `im:message.receive_v1` / `im:message:readonly` | send / receive / read messages |
   | `im:resource` | upload / download file attachments |
   | `im:chat:readonly` | read chat info |
   | `im:message.reactions:write_only` | typing reaction indicator |
   | `cardkit:card` | CardKit v2 streaming cards |
   | `im:chat` | create groups (`/spawn-chat`, `/fork-chat`) |
   | `im:chat.members:write` | invite users into groups |

5. **Publish an app version** (scope changes only take effect after publishing)

> **Want replies in groups without an @?** By default Feishu only pushes group messages that **@mention the bot**. To receive all group messages, additionally request **`im:message.group_msg`** ("read group messages" — a sensitive scope that may need admin approval) and re-publish. Otherwise the bot only responds in groups when **@mentioned** (`CTI_FEISHU_REQUIRE_MENTION=false` only applies once the event actually arrives).

---

## 5. Start

```bash
npm start            # = node dist/daemon.mjs (foreground)
```

### Persistent daemon

- **Windows**: PM2 plus the project watchdog
  ```bash
  npm install -g pm2
  pm2 start ecosystem.config.cjs
  pm2 save
  powershell.exe -NoProfile -File scripts/install-windows-watchdog.ps1
  pm2 logs feishu-bridge         # tail
  pm2 restart feishu-bridge
  pm2 stop feishu-bridge
  ```
  Run the installer from an elevated PowerShell **as the same Windows account
  that owns your agent configuration**. It registers boot, logon and five-minute
  checks using S4U, without storing a Windows password. S4U cannot use Windows
  network credentials or encrypted files; verify a planned reboot with your
  proxy/agent setup. If policy denies registration, the installer fails and
  preserves the existing task. `-AtLogonOnly` is an explicit fallback that
  requires you to log in after a reboot. Stop/disable the scheduled task before
  intentionally stopping the daemon for maintenance, or it will bring it back.
- **Linux**: pm2 + systemd
  ```bash
  npm install -g pm2
  pm2 start ecosystem.config.cjs
  pm2 save
  pm2 startup systemd            # prints a sudo command — run it
  ```
- **macOS**: `bash scripts/daemon.sh start | status | logs | stop` (launchd, auto-restarts on crash). pm2 with `pm2 startup launchd` also works.
- **Debug**: `npm run dev` (runs the TypeScript source via tsx; no build needed)

## 6. Verify

`http://127.0.0.1:59991/health` reports WebSocket state and command-processing
health. Feishu HTTP requests have a 30-second deadline (configurable with
`CTI_FEISHU_REQUEST_TIMEOUT_MS`). Commands stay ordered within each chat without
blocking other chats; stop and permission controls bypass that queue. A command
stalled for five minutes makes health return 503 and triggers daemon recovery.
Idle maintenance also waits for pending messages/commands to finish.

Offline checks: `npm run typecheck`, `npm test`, `npm run build`, and on Windows
`npm run test:watchdog`. Live integration tests use real credentials and some
send real messages; select the intended tests and chat explicitly.

Check the log (`.bridge/logs/bridge.log`) for these lines in order:

```
[feishu-bridge] Starting (run_id: ..., default agent: claude)
[provider-factory] claude ready: .../claude (Claude Code x.x.x)
[feishu] Started (botOpenId: ou_xxx)
[feishu-bridge] Bridge started (PID: xxxxx)
```

(If `CTI_DEFAULT_AGENT=copilot` or `codex`, the second line will show that backend instead; for Codex, missing proxy settings fail fast during preflight.)

Then **send the bot a message** in Feishu (direct message works as-is; in groups follow the @ / `group_msg` rules above). A card should appear and stream in. Verify:

```
/status              # shows current Agent + Mode + CWD
/agent copilot       # switch this chat to copilot (preflights lazily)
/agent claude        # switch back
/agent codex         # switch to Codex; a fresh chat starts on gpt-6-astra
/agent eureka        # create/resume a Eureka desktop task from this Feishu chat
/model gpt6          # alias for gpt-6-astra
/list                # includes local Codex sessions from ~/.codex/sessions
/resume 1            # resumes the listed backend's durable session
/tasks running       # mobile view of live Eureka/Codex work
/tasks history       # recent completed/waiting sessions
/summary 1           # request + follow-up changes + result/progress + deep link
```


---

## 7. Commands (send `/help` in Feishu to see them)

| Command | What it does |
|---|---|
| `/new` `/bind` `/list` `/resume` `/cwd` `/mode` `/status` `/stop` `/perm` | session & permission management |
| `/agent eureka` | switch the chat to Eureka; the first message creates a task and later messages resume the same task ID |
| `/tasks [all\|running\|history\|eureka\|codex]` | read live and historical local Eureka/Codex sessions from Feishu mobile; combined views deduplicate Eureka's underlying Codex rollout |
| `/summary <number-or-id>` | compact “original request / later change / accomplished” digest; Eureka entries include a clickable `eureka://` link back to the original task |
| `/whoami` | returns your open_id and current chatId (handy for debugging) |
| `/spawn-chat [name]` | create a group + invite you + @greet you |
| `/fork-chat` | **file-level true fork** of the current session into a new group: clones copilot's `session-state/<id>/` dir, inherits full context losslessly, **leaves the source session untouched** |
| `/cron <add\|list\|del\|pause\|resume>` | scheduled tasks (see below) |
| `1` `2` `3` | quick reply to a single pending permission request |

`/tasks` reads durable local session state; it does not inject prompts or consume model tokens. Eureka roots are auto-discovered from `~/.eureka`, `~/.eureka-*`, and legacy `~/.craft-agent`. Set `CTI_EUREKA_ROOTS` (path-delimiter separated) only when the data lives elsewhere. Codex sessions are discovered from `CODEX_HOME`, `~/.codex`, and the per-task `.codex-home` directories used by Eureka.

Codex resume resolves each thread back to the `CODEX_HOME` that actually contains its rollout. This prevents a bridge launched from inside Eureka from incorrectly using that one task's private `.codex-home` for global Codex history. Set `CTI_CODEX_HOME` only when new bridge-created Codex threads should use a stable non-default home.

### Unattended Windows operation

- PM2 owns the daemon and `pm2 save` persists the process list.
- `scripts/windows-watchdog.ps1` probes `http://127.0.0.1:59991/health`; it resurrects a missing PM2 process and restarts a process whose real Feishu WebSocket health fails twice.
- The bridge bounds every agent turn: 120 seconds to the first event, 10 minutes of stream silence, and 2 hours total by default. These are configurable with `CTI_AGENT_FIRST_EVENT_TIMEOUT_MS`, `CTI_AGENT_IDLE_TIMEOUT_MS`, and `CTI_AGENT_MAX_TURN_TIMEOUT_MS`.
- A missing Codex rollout starts a fresh thread. A resume that fails before producing any text/tool output is retried once as a fresh thread; output-producing failures are never replayed automatically.
- The daemon performs an idle hourly recycle, deferred while a task is active, to clear stale SDK/process state.

For travel, the PC must stay powered, online, and in a logged-in or locked Windows user session. The installed Scheduled Task uses an interactive principal; after a power loss/reboot that stops at the login screen it cannot start until that user logs in.

### `/cron` scheduled tasks

```bash
/cron add "<5-field cron>" <prompt>           # defaults to the current chat
/cron add "<5-field cron>" --to <chatId> <prompt>
/cron list | /cron del <id> | /cron pause <id> | /cron resume <id>
```

- Standard 5-field cron (min hour day month weekday), local timezone; runs in fork mode so it doesn't pollute the target session
- Persisted in `.bridge/data/scheduled.json`; **auto-loaded on bridge restart, never expires**
- Prerequisite: the target chat must have talked to the bot at least once first (a binding must exist)

> ⚠️ **Lesson learned**: a high-frequency cron expression (e.g. `* * * * *`) repeatedly spins up Copilot and can **spike usage/cost**. Double-check the frequency before adding one.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot start: missing appId or appSecret` | `config.env` missing or credentials not filled in |
| `Cannot find the GitHub Copilot CLI entrypoint` | Copilot CLI not installed, or set `CTI_COPILOT_EXECUTABLE` to point at it |
| Copilot preflight failed | `copilot --version` doesn't run / not logged in — run `copilot` in a terminal to complete GitHub login |
| WebSocket won't connect | Enable "Use persistent connection" in the Feishu console |
| No reply in groups | @mention the bot; or request `im:message.group_msg` and publish (see Feishu App Setup) |
| Permission / 403 | Missing scope — add it and **re-publish the app version** |
| Card rendering fails | Add the `cardkit:card` scope and publish |
| `npm install` → `Invalid Version` | Use `npm install --no-package-lock` |
| Very long reply card looks "frozen" | Handled automatically: when content exceeds the Feishu card limit, the card shows a short pointer and the full text is delivered as follow-up message(s) below |
| Bot process is online but mobile gets no reply | Check `http://127.0.0.1:59991/health`; `ok` is false/503 unless the Feishu WebSocket is really connected. The Windows watchdog retries and restarts automatically. |
| Codex proxy is overloaded | The turn exits within the configured deadlines and may safely retry a pre-output resume once; upstream capacity errors cannot be eliminated locally. |

---

## 9. How it works (one line)

Each Feishu message → the bridge builds `node <copilot entrypoint> -p "<message>" --output-format json --allow-all-tools [--resume=<sessionId>] [-C <workdir>] [--additional-mcp-config ...]` → it parses Copilot's JSONL events line by line, maps them to internal SSE (`text` / `tool_use` / `tool_result` / `result`), and drives the CardKit streaming card; `result.sessionId` is stored on the binding and the next message uses `--resume` to continue the context.

**Directory layout**: config lives at the project root in `config.env`; all runtime data lives under `.bridge/` (session bindings, message history, logs, scheduled tasks) and is gitignored.

---

## Security notes

- **Never commit `config.env`** (contains the App Secret) or `.bridge/` (contains session data / logs) — both are gitignored by default; do not force-add them with `git add -f`.
- Reply language is forced to Simplified Chinese by default (`RESPONSE_LANG_DIRECTIVE` in `src/copilot-provider.ts` — editable).

---

> Deeper architecture & gotcha notes are in `ARCHITECTURE.md` (note: some of it still describes the older Claude backend, but the mechanisms are largely the same).
