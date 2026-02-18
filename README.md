# Dialogue-Research

> Dialogue-Research is a Telegram-based conversational research assistant for paper analysis and development workflows.

## Setup Guide

### 1) Prerequisites

- Node.js 20+
- VS Code (Insiders recommended) + Copilot Chat with MCP support
- Telegram bot token (from `@BotFather`)
- Either `GITHUB_TOKEN` or `COPILOT_API_KEY` for automatic model calls

### 2) Install dependencies

```powershell
npm install
npm run build
```

### 3) Prepare tokens

#### 3.1 Telegram token

1. Open `@BotFather` in Telegram
2. Run `/newbot`
3. Copy the bot token (for example: `123456:ABC...`)

#### 3.2 Model credential (choose one)

- `GITHUB_TOKEN` (with `models` access)
- `COPILOT_API_KEY`

If you see `The models permission is required to access this endpoint`, your token does not have model access. Use a token with proper permissions.

### 4) Configure environment variables (Windows PowerShell)

```powershell
[Environment]::SetEnvironmentVariable('TELEGRAM_BOT_TOKEN','<your_telegram_bot_token>','User')
[Environment]::SetEnvironmentVariable('GITHUB_TOKEN','<your_github_token>','User')
# Or:
# [Environment]::SetEnvironmentVariable('COPILOT_API_KEY','<your_copilot_api_key>','User')
```

Optional:

```powershell
[Environment]::SetEnvironmentVariable('HTTP_PROXY','http://127.0.0.1:7890','User')
[Environment]::SetEnvironmentVariable('HTTPS_PROXY','http://127.0.0.1:7890','User')
[Environment]::SetEnvironmentVariable('NO_PROXY','localhost,127.0.0.1','User')
[Environment]::SetEnvironmentVariable('DEV_WORKSPACE_ROOT','E:\\project\\bot_ws','User')
```

After setting variables, reload VS Code (`Developer: Reload Window`).

### 5) MCP configuration

Make sure [ .vscode/mcp.json](.vscode/mcp.json) contains `telegram-copilot-bridge` and uses `${env:TELEGRAM_BOT_TOKEN}`.

Then run in command palette:

- `MCP: Start Server`
- Select `telegram-copilot-bridge`

### 6) Start daemon mode

```powershell
npm run daemon:start
```

Stop daemon:

```powershell
npm run daemon:stop
```

## Usage

### 1) Chat directly in Telegram

Send messages directly to your bot. The daemon polls updates and replies automatically.

Recommended first step:

`/devworkspace E:\project\bot_ws`

### 2) Commands

- `/start` show welcome message
- `/menu` refresh interactive main menu
- `/topic <name>` switch topic thread
- `/agent <profile>` switch agent profile
- `/models` list available models
- `/modelsync` refresh available models from endpoint
- `/model <id>` set model for current topic
- `/language <zh|en>` or `/lang <zh|en>` set interaction language for current topic
- `/history <keyword>` search history
- `/paper` show current paper
- `/paperadd <arXiv-link|arXiv-id|paper-title>` add paper
- `/paperlist` list/select recent papers
- `/papermode <organize|brainstorm> <cot|tot|got>` set paper reasoning mode
- `/paperorganize [cot|tot|got]` organize paper information
- `/paperbrainstorm [--mode cot|tot|got] <question>` run 5-role brainstorming
- `/ask <question>` ask about current paper
- `/askm <model-id> <question>` ask with per-request model override

Development mode commands:

- `/devworkspace <path>` set workspace root
- `/devprojects` list projects
- `/devcreate <project-name>` create project and set current
- `/devselect <project-name>` select current project
- `/devclone <repo-url> [project-name]` clone and set current
- `/devstatus` show dev mode state
- `/devls [dir]` list files in current project
- `/devcat <file-path>` read file from current project
- `/devrun <command>` run whitelisted command (`git status|branch|log`, `npm/pnpm/yarn test`)
- `/devgit [status|branch|log]` shortcut for Git query actions

Language behavior:

- `zh` => bot system messages and model outputs follow Chinese
- `en` => bot system messages and model outputs follow English
- language setting is stored per `chat_id + topic`

## Verification

1. Send `/start`
2. Send a normal message and confirm automatic reply
3. Check [data/copilot-usage.log](data/copilot-usage.log) for usage records

## Troubleshooting

### MCP stuck on startup

1. Run `npm run build`
2. Run `Developer: Reload Window`
3. Start MCP server again

### Bot does not auto-reply

1. Ensure daemon is running (`npm run daemon:start`)
2. Check `TELEGRAM_BOT_TOKEN`
3. Check `GITHUB_TOKEN` or `COPILOT_API_KEY`
4. If permission error appears, use token with `models` access
5. Restart daemon and VS Code after environment updates

### Development project operations fail

1. Confirm `DEV_WORKSPACE_ROOT` or run `/devworkspace <path>`
2. Confirm path permissions
3. Run `/devstatus` to inspect current workspace/project
4. Ensure `git` is installed for clone operations

### `getUpdates` 409 conflict

Only one daemon instance should poll the same bot token.

### Cost / retry logs

- Log file: [data/copilot-usage.log](data/copilot-usage.log)
- One JSON record per line with tokens, estimated cost, retries, and errors

