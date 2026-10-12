# 飞书 Bridge 使用指南

通过飞书连接本机的 Claude Code、GitHub Copilot、Codex 或 Eureka。
每个聊天可以分别选择后端、工作目录和会话。

## 安装和启动

需要 Node.js 20 以上版本、飞书自建应用，以及至少一个可用的代理后端。
飞书应用权限和事件配置见 [README](README.md)。

```powershell
git clone https://github.com/Eavis/feishu_bridge.git
cd feishu_bridge
npm ci
Copy-Item config.env.example config.env
# 编辑 config.env，填写自己的飞书应用凭据和工作目录。
npm run typecheck
npm test
npm run build
npm start
```

不要把 `config.env`、密钥、聊天记录、日志或代理的登录信息提交到 Git。
仓库只提供配置模板。运行数据默认保存在被忽略的 `.bridge/` 目录。

## 连接 Codex

本项目的 Codex 后端使用配置好的 Responses API 代理，需要自己的代理地址和凭据。
在本机 `config.env` 中设置：

```dotenv
CTI_DEFAULT_AGENT=codex
CTI_CODEX_BASE_URL=https://api.example.com/v1
CTI_CODEX_AUTH_ENV_KEY=OPENAI_API_KEY
OPENAI_API_KEY=replace-with-your-own-key
```

先确认本机能运行 `codex --version`，再在飞书发送 `/agent codex`。
配置中的示例地址不能直接使用；凭据只保存在本机。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看完整命令列表 |
| `/status` | 查看当前会话和后端状态 |
| `/agent claude`、`/agent copilot`、`/agent codex`、`/agent eureka` | 切换当前聊天的后端 |
| `/cwd C:\projects\demo` | 设置工作目录 |
| `/model <name>`、`/model default` | 设置模型或恢复默认 |
| `/new` | 创建新会话 |
| `/list`、`/resume <编号或会话 ID>` | 查找和恢复本机代理会话 |
| `/sessions` | 查看机器人管理的聊天会话 |
| `/tasks` | 查看本机任务状态 |
| `/stop` | 中止当前任务 |

群聊默认需要 @机器人。直接发送消息后，回复通过流式卡片显示。
附件、文件回传、定时任务和群管理命令请查看 `/help`。

Claude 的工具调用可通过权限卡片确认；Copilot 的非交互运行模式会自动放行工具。
只允许可信用户访问机器人，并在 `CTI_FEISHU_ALLOWED_USERS` 中配置访问名单。

## 无人值守和故障恢复

```powershell
npm install -g pm2
pm2 start ecosystem.config.cjs --only feishu-bridge
pm2 save
```

在运行代理的同一 Windows 用户下，以管理员身份打开 PowerShell：

```powershell
powershell.exe -NoProfile -File scripts/install-windows-watchdog.ps1
```

这会配置开机、登录和每五分钟一次的健康检查。只希望登录后运行时，可显式加上
`-AtLogonOnly`。详见 [恢复机制与验证记录](RELIABILITY.md)。

出门前确认电脑接通电源、保持联网、不进入睡眠，代理服务和登录状态仍然可用。
自动恢复需要机器本身在运行；请在出发前实际测试计划使用的开机和登录方式。

如果飞书没有回复：

1. 在同一会话发送 `/status`，群聊请 @机器人。
2. 在电脑上运行 `Invoke-RestMethod http://127.0.0.1:59991/health`。
3. 查看 `pm2 status` 和本机 `.bridge/logs/`。
4. 若连接正常但代理失败，检查对应后端的登录、代理和模型配置。

`/health` 同时检查飞书连接和命令是否卡住；异常时返回 HTTP 503。
看板地址为 `http://127.0.0.1:59991/dashboard`，仅在本机访问。
主动停机维护前应先禁用 Windows 看门狗，否则它会重新启动服务。

## 验证

```powershell
npm run typecheck
npm test
npm run test:watchdog
npm run build
```

这些检查不需要真实账号。实时连接测试需要本机私有配置；运行前先停生产桥接进程和看门狗，
避免同一机器人被两个消费者同时连接，结束后恢复服务。
发送消息的集成测试必须设置 `CTI_TEST_FEISHU_CHAT_ID` 为专用测试聊天。
Codex 恢复测试必须设置 `CTI_TEST_CODEX_THREAD_ID` 为可以用于测试的会话。
真实模型测试可能产生费用，不在默认测试或 GitHub Actions 中运行。
