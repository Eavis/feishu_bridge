# Reliability checks and recovery

## Changes verified on 2026-10-12

- Feishu REST/token requests and download streams have deadlines. A hung HTTP
  request no longer waits indefinitely.
- Commands remain ordered within a chat without stopping the global inbox.
  Stop and permission controls bypass the command queue. Stalled commands make
  `/health` return 503 and trigger the process watchdog; pending work defers
  hourly idle maintenance.
- Windows recovery starts or restarts only this application from its ecosystem
  configuration. It handles missing/stopped/errored PM2 entries, validates the
  health PID, and fails visibly on duplicate instances or failed PM2 commands.
- Dependencies are locked, the Feishu SDK is pinned to 1.74.0, and automated
  checks run on Windows and Ubuntu through GitHub Actions.
- Codex terminal turn events finalize the bridge response immediately. A CLI
  process that lingers after completion gets a two-second shutdown grace period
  and bounded cleanup. Genuine stream timeouts retain partial text and usage.
  See the [Codex JSON event format](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable).

Verification on Windows, Node 24:

| Check | Result |
| --- | --- |
| Fresh `npm ci` without private config | Passed |
| TypeScript + production build | Passed |
| Unit and local HTTP/process regression tests | 97 passed |
| Isolated Windows watchdog scenarios | 9 passed |
| Live Feishu initial connection | Passed |
| Forced WebSocket disconnect | Recovered in about 12 seconds |
| Half-open socket with suppressed incoming frames | Recovered in about 21 seconds |
| Real scheduled watchdog with a stopped PM2 entry | Restored a new healthy process |
| Terminal Codex success/failure with a CLI that never exits | Reply preserved; subprocess cleaned up |
| Final JSON line without newline and genuine silent-turn timeout | Passed; partial text preserved |
| Real Codex short request through configured proxy | Completed in about 18 seconds, no tool calls |
| `npm audit` for the locked dependency tree | 0 known vulnerabilities at check time |

No live Feishu messages were sent by these connectivity tests. The live tests
cover Feishu transport. A separate short Codex request verified one successful
model turn through the configured proxy; it did not send a Feishu message.
Windows and Ubuntu CI run without private credentials or real model calls.

## Remaining Windows setup

The existing watchdog runs every five minutes in a logged-in user session.
Changing it to S4U boot recovery was rejected by Windows with `Access is denied`
in the non-elevated repair session. The existing task was preserved.

From an **administrator PowerShell as the same user that owns the agent
configuration**, run:

```powershell
cd <path-to-feishu-bridge>
powershell.exe -NoProfile -File scripts/install-windows-watchdog.ps1
```

If `CTI_OUTBOX_PORT` is customized, pass the same value as `-HealthPort`. The
installer backs up an existing task's XML in `.bridge/runtime/`. S4U cannot use
Windows network credentials or encrypted files. Verify a planned reboot with
the actual proxy and agent credentials; no machine reboot was performed during
this repair. `-AtLogonOnly` explicitly retains the login requirement.

For intentional maintenance, disable the scheduled watchdog before stopping
PM2 and re-enable it afterward. Otherwise it will restore the stopped app.

## Checks to rerun

```powershell
npm ci
npm run typecheck
npm test
npm run test:watchdog
npm run build
```

To check live reconnection without sending test messages, briefly stop the
production bridge and disable its watchdog, then run:

```powershell
node --import tsx --test --test-name-pattern="FeishuClient (starts|self-heals|detects)" src/__tests__/integration.test.ts
```

Restore PM2 and its watchdog afterward, including when a test fails. Do not run
a second live WebSocket consumer alongside production: incoming Feishu events
can be distributed across consumers. Other live integration tests may send real
messages and require an explicitly chosen test destination.
