---
name: telegram-copilot-bridge
description: 'Bridge Telegram bot conversations to VS Code Copilot using MCP tools. Use when you need to receive Telegram messages, continue chat history by chat_id and topic, choose or switch Copilot agent profile and model, show model pricing notes, and send Copilot replies back to Telegram.'
argument-hint: 'mode=<manual|auto> chat_id=<id> topic=<name> agent=<profile> model=<id> action=<sync|history|continue|reply>'
user-invocable: true
disable-model-invocation: false
---

# Telegram Copilot Bridge

Use this skill to operate a Telegram bot as a conversation channel for VS Code Copilot.

## Local token setup (VS Code)

1. Open `.vscode/mcp.json` and keep `TELEGRAM_BOT_TOKEN` bound to `${env:TELEGRAM_BOT_TOKEN}`.
2. Set `TELEGRAM_BOT_TOKEN` in local user environment and restart VS Code.
3. Set `GITHUB_TOKEN` or `COPILOT_API_KEY` for automatic model invocation by daemon.
4. Optional proxy variables for restricted networks: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`.

Do not commit real token values into repository files.

## Mandatory environment guardrails

Before executing sync/reply actions, always ensure:

- `TELEGRAM_BOT_TOKEN` is configured and readable by current process.
- At least one of `GITHUB_TOKEN` or `COPILOT_API_KEY` is configured for auto model replies.

If missing variables are detected, you must:

1. Stop normal workflow execution.
2. Tell the user exactly which variable is missing.
3. Provide concrete OS-level setup steps (PowerShell commands on Windows).
4. Instruct user to restart daemon and VS Code window after updating env.

## Commands in Telegram

- `/topic <name>`: switch or create a topic under current `chat_id`.
- `/agent <profile>`: switch Copilot agent profile for current topic.
- `/history <keyword>`: query history (handled by this skill with `session_search`).
- `/models`: show available Copilot models and pricing notes.
- `/model <id>`: select model for current topic.
- `/start`: show welcome message and repository link.
- `发送 PDF 文件`: trigger local paper reading and storage workflow.
- `/paper`: show active paper info in current topic.
- `/ask <question>`: ask questions about the active paper.

## Required MCP tools

- `telegram_fetch_updates`
- `telegram_send_message`
- `session_append`
- `session_get_history`
- `session_search`
- `session_list_threads`
- `session_continue`
- `bridge_prepare_message`
- `bridge_get_start_message`
- `bridge_get_offset`
- `bridge_set_offset`
- `copilot_list_models`
- `copilot_select_model`
- `copilot_get_selected_model`

## Procedure

1. Read last offset using `bridge_get_offset`, then fetch latest updates using `telegram_fetch_updates`.
2. For each update message:
   - Call `bridge_prepare_message` with `chatId`, `text`, and optional `topic`.
   - If command is `/start`, return `bridge_get_start_message` and send via `telegram_send_message`.
   - If command is `/models`, call `copilot_list_models` and send the model list with pricing notes.
   - If command is `/model`, validate and persist through `copilot_select_model`, then send confirmation.
   - If command is `/topic` or `/agent`, persist by writing a system message through `session_append` and send confirmation via `telegram_send_message`.
   - Otherwise append user content with `session_append`.
3. Build context:
   - Use `session_continue` for full continuation in current `chat_id + topic`.
   - Use `session_search` when message asks to query old content.
4. Generate Copilot response using selected `agent` and context summary.
5. Save assistant reply through `session_append` and send it via `telegram_send_message`.
6. Persist next offset using `bridge_set_offset`.

When running in auto daemon mode, treat this as continuous loop behavior and keep consuming new updates without requiring manual slash invocation.

## Continuous running with minimal Copilot token consumption

- Run local daemon `npm run start:daemon` to keep long-polling Telegram updates.
- In daemon standby mode, waiting and command handling (`/start`, `/models`, `/model`, `/topic`, `/agent`, `/history`) are local and do not consume Copilot tokens.
- Only invoke `/telegram-copilot-bridge` in Copilot Chat when you explicitly need model inference replies.

## Mode behavior

- `manual`: draft reply only and wait for user confirmation before sending.
- `auto`: send reply immediately after generation.
- Telegram command `/mode <manual|auto>` changes current execution mode.

## Agent customization

- Keep default agent from environment `DEFAULT_AGENT`.
- Override per topic with `/agent <profile>`.
- Always persist selected profile in session messages for reproducible continuation.

## Model selection and pricing

- Use `copilot_list_models` to show currently configured model catalog with pricing notes.
- Use `copilot_select_model` to bind model choice to `chat_id + topic`.
- Use `copilot_get_selected_model` before generating replies to keep model continuity.
- Treat pricing as informational notes and remind users that official billing may change.

## History and continuation

- Primary session key: `chat_id + topic`.
- Use `session_list_threads` to list existing topics.
- Use `session_get_history` to retrieve recent turns.
- Use `session_continue` to continue an existing thread with summary.

## References

- [Workflow details](./references/workflow.md)
- [Safety and guardrails](./references/safety.md)
- [Troubleshooting](./references/troubleshooting.md)
- [PowerShell runbook](./scripts/runbook.ps1)
