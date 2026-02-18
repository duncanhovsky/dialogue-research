import fs from 'node:fs';
import { loadConfig } from './config.js';
import { ModelCatalog } from './modelCatalog.js';
import { SessionStore } from './sessionStore.js';
import { TelegramClient } from './telegram.js';
import { parseTelegramText } from './topic.js';

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

type RpcTransportMode = 'framed' | 'jsonl';
type RpcPayload = RpcRequest | RpcRequest[];

const tools = [
  {
    name: 'telegram_fetch_updates',
    description: 'Fetch Telegram updates from bot API',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'number' }
      }
    }
  },
  {
    name: 'telegram_send_message',
    description: 'Send text message to Telegram chat',
    inputSchema: {
      type: 'object',
      required: ['chatId', 'text'],
      properties: {
        chatId: { type: 'number' },
        text: { type: 'string' }
      }
    }
  },
  {
    name: 'session_append',
    description: 'Append a message into session store',
    inputSchema: {
      type: 'object',
      required: ['chatId', 'topic', 'role', 'content'],
      properties: {
        chatId: { type: 'number' },
        topic: { type: 'string' },
        role: { type: 'string' },
        content: { type: 'string' },
        agent: { type: 'string' }
      }
    }
  },
  {
    name: 'session_get_history',
    description: 'Read historical messages for chat and topic',
    inputSchema: {
      type: 'object',
      required: ['chatId'],
      properties: {
        chatId: { type: 'number' },
        topic: { type: 'string' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'session_search',
    description: 'Search historical messages by keyword',
    inputSchema: {
      type: 'object',
      required: ['chatId', 'keyword'],
      properties: {
        chatId: { type: 'number' },
        keyword: { type: 'string' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'session_list_threads',
    description: 'List historical conversation threads',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'number' }
      }
    }
  },
  {
    name: 'session_continue',
    description: 'Build continue context with summary',
    inputSchema: {
      type: 'object',
      required: ['chatId', 'topic'],
      properties: {
        chatId: { type: 'number' },
        topic: { type: 'string' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'bridge_prepare_message',
    description: 'Parse Telegram command and derive topic/agent for current message',
    inputSchema: {
      type: 'object',
      required: ['chatId', 'text'],
      properties: {
        chatId: { type: 'number' },
        text: { type: 'string' },
        topic: { type: 'string' },
        mode: { type: 'string' }
      }
    }
  },
  {
    name: 'bridge_get_start_message',
    description: 'Get standard /start welcome message with repository link',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'copilot_list_models',
    description: 'List available Copilot models and pricing notes',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'copilot_select_model',
    description: 'Select model for a chat_id + topic thread',
    inputSchema: {
      type: 'object',
      required: ['chatId', 'topic', 'modelId'],
      properties: {
        chatId: { type: 'number' },
        topic: { type: 'string' },
        modelId: { type: 'string' }
      }
    }
  },
  {
    name: 'copilot_get_selected_model',
    description: 'Get selected model for a chat_id + topic thread',
    inputSchema: {
      type: 'object',
      required: ['chatId', 'topic'],
      properties: {
        chatId: { type: 'number' },
        topic: { type: 'string' }
      }
    }
  },
  {
    name: 'bridge_get_offset',
    description: 'Get last processed Telegram update offset',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'bridge_set_offset',
    description: 'Persist last processed Telegram update offset',
    inputSchema: {
      type: 'object',
      required: ['offset'],
      properties: {
        offset: { type: 'number' }
      }
    }
  }
];

export async function runMcpServer(): Promise<void> {
  const config = loadConfig({ requireTelegramToken: false });
  const modelCatalog = new ModelCatalog(config.modelCatalogPath);
  const telegram = new TelegramClient(config);
  const sessions = new SessionStore(config);
  const mcpDebugLogPath = process.env.MCP_DEBUG_LOG_PATH ?? './data/mcp-debug.log';

  if (!config.telegramBotToken) {
    process.stderr.write('[telegram-copilot-bridge] TELEGRAM_BOT_TOKEN is empty; telegram.* tools are disabled until token is set.\n');
  }

  writeMcpDebugLog(mcpDebugLogPath, `server_start pid=${process.pid} cwd=${process.cwd()}`);

  let inputBuffer = Buffer.alloc(0);
  let processing = false;
  let loggedNoSeparatorSample = false;

  const drainInputBuffer = async (): Promise<void> => {
    if (processing) {
      return;
    }
    processing = true;

    try {
      while (true) {
        const separator = findHeaderSeparator(inputBuffer);
        if (!separator) {
          const bare = tryReadBareJsonRequest(inputBuffer);
          if (!bare) {
            if (!loggedNoSeparatorSample && inputBuffer.byteLength >= 64) {
              writeMcpDebugLog(mcpDebugLogPath, `no_separator_sample=${sanitizeForLog(inputBuffer.subarray(0, 160).toString('utf8'))}`);
              loggedNoSeparatorSample = true;
            }
            break;
          }

          inputBuffer = inputBuffer.subarray(bare.consumedBytes);
          await handleIncomingPayload(
            bare.payload,
            'jsonl',
            mcpDebugLogPath,
            telegram,
            sessions,
            modelCatalog,
            config
          );
          continue;
        }

        loggedNoSeparatorSample = false;

        const header = inputBuffer.subarray(0, separator.index).toString('utf8');
        const contentLengthMatch = header
          .split(/\r?\n/)
          .map((line) => line.match(/^\s*content-length\s*:\s*(\d+)\s*$/i))
          .find((match) => Boolean(match));

        if (!contentLengthMatch) {
          writeMcpDebugLog(mcpDebugLogPath, 'missing_content_length_header');
          inputBuffer = inputBuffer.subarray(separator.index + separator.length);
          continue;
        }

        const length = Number(contentLengthMatch[1] ?? '0');
        const bodyStart = separator.index + separator.length;
        const bodyEnd = bodyStart + length;
        if (inputBuffer.byteLength < bodyEnd) {
          break;
        }

        const body = inputBuffer.subarray(bodyStart, bodyEnd).toString('utf8');
        inputBuffer = inputBuffer.subarray(bodyEnd);

        const payload = JSON.parse(body) as RpcPayload;
        await handleIncomingPayload(
          payload,
          'framed',
          mcpDebugLogPath,
          telegram,
          sessions,
          modelCatalog,
          config
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeMcpDebugLog(mcpDebugLogPath, `drain_error ${message}`);
    } finally {
      processing = false;
    }
  };

  process.stdin.on('data', (chunk) => {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    inputBuffer = Buffer.concat([inputBuffer, chunkBuffer]);
    writeMcpDebugLog(mcpDebugLogPath, `stdin_chunk bytes=${chunkBuffer.byteLength} buffer=${inputBuffer.byteLength}`);
    void drainInputBuffer();
  });

  process.stdin.on('end', () => {
    writeMcpDebugLog(mcpDebugLogPath, 'stdin_end');
  });

  process.on('SIGINT', () => {
    writeMcpDebugLog(mcpDebugLogPath, 'sigint');
    sessions.close();
    process.exit(0);
  });
}

function writeMcpDebugLog(filePath: string, message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.appendFileSync(filePath, line, 'utf8');
  } catch {
    // ignore debug logging errors
  }
}

function findHeaderSeparator(buffer: Buffer): { index: number; length: 2 | 4 } | null {
  const text = buffer.toString('utf8');
  const separatorMatch = /\r?\n\r?\n/.exec(text);
  if (separatorMatch) {
    const length = separatorMatch[0].length === 4 ? 4 : 2;
    return { index: separatorMatch.index, length };
  }

  return null;
}

function tryReadBareJsonRequest(buffer: Buffer): { payload: RpcPayload; consumedBytes: number } | null {
  const text = buffer.toString('utf8');
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const parseCandidate = (candidate: string, consumedBytes: number): { payload: RpcPayload; consumedBytes: number } | null => {
    try {
      const parsed = JSON.parse(candidate) as RpcPayload;
      if (!isRpcPayload(parsed)) {
        return null;
      }
      return { payload: parsed, consumedBytes };
    } catch {
      return null;
    }
  };

  const wholeMatch = parseCandidate(trimmed, Buffer.byteLength(text, 'utf8'));
  if (wholeMatch) {
    return wholeMatch;
  }

  const lineBreakIndex = text.indexOf('\n');
  if (lineBreakIndex !== -1) {
    const firstLine = text.slice(0, lineBreakIndex).trim();
    if (firstLine) {
      const lineMatch = parseCandidate(firstLine, Buffer.byteLength(text.slice(0, lineBreakIndex + 1), 'utf8'));
      if (lineMatch) {
        return lineMatch;
      }
    }
  }

  return null;
}

function sanitizeForLog(input: string): string {
  return input.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').slice(0, 160);
}

function isRpcRequest(value: unknown): value is RpcRequest {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const item = value as Partial<RpcRequest>;
  return item.jsonrpc === '2.0' && typeof item.method === 'string';
}

function isRpcPayload(value: unknown): value is RpcPayload {
  if (Array.isArray(value)) {
    return value.every((item) => isRpcRequest(item));
  }

  return isRpcRequest(value);
}

async function handleIncomingPayload(
  payload: RpcPayload,
  mode: RpcTransportMode,
  mcpDebugLogPath: string,
  telegram: TelegramClient,
  sessions: SessionStore,
  modelCatalog: ModelCatalog,
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  const requests = Array.isArray(payload) ? payload : [payload];
  const responses: RpcResponse[] = [];

  for (const request of requests) {
    writeMcpDebugLog(
      mcpDebugLogPath,
      `request method=${request.method} id=${String(request.id ?? 'null')} transport=${mode}`
    );
    const response = await handleRequest(request, telegram, sessions, modelCatalog, config);
    if (response) {
      writeMcpDebugLog(
        mcpDebugLogPath,
        `response id=${String(response.id)} hasError=${String(Boolean(response.error))} transport=${mode}`
      );
      responses.push(response);
    }
  }

  if (responses.length === 0) {
    return;
  }

  if (Array.isArray(payload) && responses.length > 1) {
    writeResponse(responses, mode);
    return;
  }

  writeResponse(responses[0], mode);
}

async function handleRequest(
  request: RpcRequest,
  telegram: TelegramClient,
  sessions: SessionStore,
  modelCatalog: ModelCatalog,
  config: ReturnType<typeof loadConfig>
): Promise<RpcResponse | null> {
  if (request.method === 'notifications/initialized') {
    return null;
  }

  try {
    if (request.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: {
            name: 'telegram-copilot-bridge',
            version: '0.1.0'
          },
          capabilities: {
            tools: {}
          }
        }
      };
    }

    if (request.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result: {
          tools
        }
      };
    }

    if (request.method === 'tools/call') {
      const params = (request.params ?? {}) as { name: string; arguments?: Record<string, unknown> };
      const result = await callTool(params.name, params.arguments ?? {}, telegram, sessions, modelCatalog, config);
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }]
        }
      };
    }

    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: {
        code: -32601,
        message: `Method not found: ${request.method}`
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: {
        code: -32000,
        message
      }
    };
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  telegram: TelegramClient,
  sessions: SessionStore,
  modelCatalog: ModelCatalog,
  config: ReturnType<typeof loadConfig>
): Promise<unknown> {
  switch (name) {
    case 'telegram_fetch_updates':
    case 'telegram.fetch_updates': {
      assertTelegramTokenConfigured(config);
      const offset = typeof args.offset === 'number' ? args.offset : undefined;
      return telegram.getUpdates(offset);
    }
    case 'telegram_send_message':
    case 'telegram.send_message': {
      assertTelegramTokenConfigured(config);
      const chatId = Number(args.chatId);
      const text = String(args.text ?? '');
      const messageId = await telegram.sendMessage(chatId, text);
      return { ok: true, messageId };
    }
    case 'session_append':
    case 'session.append': {
      const result = sessions.append({
        chatId: Number(args.chatId),
        topic: String(args.topic ?? config.defaultTopic),
        role: (args.role as 'user' | 'assistant' | 'system') ?? 'user',
        content: String(args.content ?? ''),
        agent: String(args.agent ?? config.defaultAgent)
      });
      return result;
    }
    case 'session_get_history':
    case 'session.get_history': {
      return sessions.getHistory({
        chatId: Number(args.chatId),
        topic: args.topic ? String(args.topic) : undefined,
        limit: args.limit ? Number(args.limit) : undefined
      });
    }
    case 'session_search':
    case 'session.search': {
      return sessions.search({
        chatId: Number(args.chatId),
        keyword: String(args.keyword ?? ''),
        limit: args.limit ? Number(args.limit) : undefined
      });
    }
    case 'session_list_threads':
    case 'session.list_threads': {
      const chatId = typeof args.chatId === 'number' ? args.chatId : undefined;
      return sessions.listThreads(chatId);
    }
    case 'session_continue':
    case 'session.continue': {
      return sessions.continueContext(
        Number(args.chatId),
        String(args.topic ?? config.defaultTopic),
        args.limit ? Number(args.limit) : 20
      );
    }
    case 'bridge_prepare_message':
    case 'bridge.prepare_message': {
      const chatId = Number(args.chatId);
      const topic = args.topic ? String(args.topic) : config.defaultTopic;
      const mode = args.mode === 'auto' ? 'auto' : 'manual';
      const profile = sessions.getCurrentProfile(chatId, topic);
      const selectedModel = sessions.getSelectedModel(chatId, topic);
      return parseTelegramText(String(args.text ?? ''), {
        telegramBotToken: 'hidden',
        telegramApiBase: 'hidden',
        httpProxy: undefined,
        httpsProxy: undefined,
        noProxy: undefined,
        replyMode: mode,
        pollTimeoutSeconds: 20,
        pollIntervalMs: 1200,
        sessionRetentionDays: 30,
        sessionRetentionMessages: 200,
        dbPath: ':memory:',
        paperCacheDir: './data/papers/cache',
        paperDbDir: './data/papers/library',
        defaultTopic: config.defaultTopic,
        defaultAgent: config.defaultAgent,
        defaultModel: config.defaultModel,
        modelCatalogPath: config.modelCatalogPath,
        devWorkspaceRoot: config.devWorkspaceRoot,
        githubRepoUrl: config.githubRepoUrl
      }, profile.topic, profile.agent, selectedModel);
    }
    case 'bridge_get_start_message':
    case 'bridge.get_start_message': {
      return parseTelegramText('/start', config).text;
    }
    case 'copilot_list_models':
    case 'copilot.list_models': {
      return {
        models: modelCatalog.list(),
        note: '模型可用性与收费规则以你的 GitHub Copilot 订阅与官方页面为准。'
      };
    }
    case 'copilot_select_model':
    case 'copilot.select_model': {
      const chatId = Number(args.chatId);
      const topic = String(args.topic ?? config.defaultTopic);
      const modelId = String(args.modelId ?? '').trim();
      if (!modelCatalog.findById(modelId)) {
        throw new Error(`Model not found in catalog: ${modelId}`);
      }
      return {
        chatId,
        topic,
        modelId: sessions.setSelectedModel(chatId, topic, modelId)
      };
    }
    case 'copilot_get_selected_model':
    case 'copilot.get_selected_model': {
      const chatId = Number(args.chatId);
      const topic = String(args.topic ?? config.defaultTopic);
      const modelId = sessions.getSelectedModel(chatId, topic);
      return {
        chatId,
        topic,
        model: modelCatalog.findById(modelId) ?? { id: modelId, name: modelId, provider: 'unknown', pricing: '请查看官方价格页' }
      };
    }
    case 'bridge_get_offset':
    case 'bridge.get_offset': {
      return { offset: sessions.getOffset() };
    }
    case 'bridge_set_offset':
    case 'bridge.set_offset': {
      return { offset: sessions.setOffset(Number(args.offset ?? 0)) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function assertTelegramTokenConfigured(config: ReturnType<typeof loadConfig>): void {
  if (!config.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required for telegram tools. Please set env TELEGRAM_BOT_TOKEN and restart MCP server.');
  }
}

function writeResponse(response: RpcResponse | RpcResponse[], mode: RpcTransportMode): void {
  const body = JSON.stringify(response);
  if (mode === 'jsonl') {
    process.stdout.write(`${body}\n`);
    return;
  }

  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
  process.stdout.write(header + body);
}
