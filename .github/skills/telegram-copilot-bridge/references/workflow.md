# Workflow

## End-to-end loop

1. Pull updates from Telegram using `telegram.fetch_updates`.
2. Parse message and derive effective topic/agent using `bridge.prepare_message`.
3. Handle command fast paths:
	- `/start` -> call `bridge.get_start_message` and send directly.
	- `/models` -> call `copilot.list_models` and send list with pricing notes.
	- `/model <id>` -> call `copilot.select_model` and confirm selection.
4. Save inbound message with `session.append`.
5. Get continuation context using `session.continue`.
6. Read selected model via `copilot.get_selected_model`.
7. Generate response in Copilot chat using selected agent profile and selected model.
8. Save outbound response with `session.append`.
9. Deliver response via `telegram.send_message`.

## Continuation rules

- Session identity is `chat_id + topic`.
- Topic default is `default` unless changed by `/topic <name>`.
- Agent profile default is `DEFAULT_AGENT` unless changed by `/agent <profile>`.
- Keep message window bounded by retention config.

## History query rules

- Use `session.search` when user asks for old facts.
- Use `session.get_history` for recent timeline playback.
- Return concise summaries when history is long.
