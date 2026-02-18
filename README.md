# Telegram ↔ VS Code Copilot Bridge Skill

一个符合 GitHub 开源 Skills 规范的技能与本地 MCP 服务，用于把 Telegram Bot 对话接入 VS Code Copilot 工作流。

## 功能概览

- Telegram 消息拉取与回发（Bot HTTP API）
- 会话持久化（默认 SQLite）
- 历史查询与继续对话（按 `chat_id + topic`）
- Copilot 智能体配置选择与切换（按 topic 维度）
- 读取可用 Copilot 大模型列表，展示各模型收费说明，并支持按话题选择模型
- 回复模式切换：`manual` / `auto`
- Telegram `/start` 欢迎语（含技能介绍与 GitHub 仓库地址）
- MCP 工具化接口，便于在 Copilot Chat 中编排

## 项目结构

- `.github/skills/telegram-copilot-bridge/SKILL.md`：技能定义（slash 可调用）
- `.github/skills/telegram-copilot-bridge/references/`：流程/安全/排障文档
- `.github/skills/telegram-copilot-bridge/scripts/runbook.ps1`：本地运行脚本
- `.vscode/mcp.json`：VS Code MCP 服务配置示例
- `src/`：MCP server、Telegram 客户端、会话存储
- `tests/`：单元测试

## 前置条件

- Node.js 20+
- VS Code + Copilot Chat（支持 MCP）
- 一个 Telegram Bot Token（来自 `@BotFather`）

## 安装与启动

1. 安装依赖

```powershell
npm install
```

2. 构建服务

```powershell
npm run build
```

3. 配置环境变量（任选）

- 方式 A：使用 `.vscode/mcp.json` 启动时弹窗输入 token
- 方式 B：复制 `.env.example` 为 `.env` 并注入环境（你自己的运行方式）

4. 重载 VS Code 窗口，确保 MCP server 已连接

5. 在 Copilot Chat 中通过 `/telegram-copilot-bridge` 调用技能

## 配置项说明

- `TELEGRAM_BOT_TOKEN`：必填，Telegram Bot token
- `REPLY_MODE`：`manual`（默认）或 `auto`
- `SESSION_RETENTION_MESSAGES`：每条线程保留消息上限（默认 200）
- `SESSION_RETENTION_DAYS`：保留天数（默认 30）
- `DEFAULT_TOPIC`：默认话题（默认 `default`）
- `DEFAULT_AGENT`：默认智能体标识（默认 `default`）
- `DEFAULT_MODEL`：默认模型 ID（默认 `gpt-5.3-codex`）
- `MODEL_CATALOG_PATH`：模型目录文件路径（默认 `./config/models.catalog.json`）
- `GITHUB_REPO_URL`：`/start` 欢迎语中展示的仓库地址

## Telegram 对话命令

- `/topic <name>`：切换当前 chat 下的话题线程
- `/agent <profile>`：切换当前话题使用的 Copilot 智能体配置
- `/history <keyword>`：触发历史查询流程
- `/mode <manual|auto>`：切换回复模式
- `/models`：显示可用模型及收费说明
- `/model <id>`：为当前 `chat_id + topic` 选择模型
- `/start`：显示欢迎语、功能说明和 GitHub 仓库地址

## MCP 工具接口

- `telegram.fetch_updates`
- `telegram.send_message`
- `session.append`
- `session.get_history`
- `session.search`
- `session.list_threads`
- `session.continue`
- `bridge.prepare_message`
- `bridge.get_offset`
- `bridge.set_offset`
- `bridge.get_start_message`
- `copilot.list_models`
- `copilot.select_model`
- `copilot.get_selected_model`

## 推荐编排流程（在 Skill 内）

1. 读取 `bridge.get_offset`
2. 使用 `telegram.fetch_updates` 拉取新消息
3. 对每条消息调用 `bridge.prepare_message`
4. 写入 `session.append`
5. 用 `session.continue` 构建续聊上下文
6. 使用 `copilot.get_selected_model` 读取当前话题绑定模型
7. 由 Copilot 生成回复（使用当前 topic 的 agent + model）
8. 回复写入 `session.append`
9. 调用 `telegram.send_message` 回发
10. 更新 `bridge.set_offset`

## 模型收费说明

- 本项目通过 `config/models.catalog.json` 读取可用模型清单与收费说明。
- 默认收费说明为“按 GitHub Copilot 订阅计划计费”，用于会话内展示。
- 若你组织有更精确的内部结算规则，可直接更新 `config/models.catalog.json` 中每个模型的 `pricing` 字段。

## 安全建议

- 不要把 token 提交到仓库
- `.env` 必须在 `.gitignore` 中
- 对 Telegram 输入按不可信文本处理
- 默认 `manual` 模式，避免误发送

## 测试

```powershell
npm run test
```

## 本地开发

```powershell
npm run dev
```

## 限制与说明

- 本项目通过 Skill + MCP 提供桥接能力，不直接调用私有 Copilot 后端 API。
- “与 Copilot 对话”由 VS Code Copilot Chat 在技能编排中完成。
- 若需完全无人值守后台机器人，请再增加守护进程/队列调度层。

## 许可证

MIT
