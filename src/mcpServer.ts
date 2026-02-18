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

const tools = [
  {
    name: 'telegram.fetch_updates',
    description: 'Fetch Telegram updates from bot API',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'number' }
      }
    }
  },
  {
    name: 'telegram.send_message',
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
    name: 'session.append',
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
    name: 'session.get_history',
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
    name: 'session.search',
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
    name: 'session.list_threads',
    description: 'List historical conversation threads',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'number' }
      }
    }
  },
  {
    name: 'session.continue',
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
    name: 'bridge.prepare_message',
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
    name: 'bridge.get_start_message',
    description: 'Get standard /start welcome message with repository link',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'copilot.list_models',
    description: 'List available Copilot models and pricing notes',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'copilot.select_model',
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
    name: 'copilot.get_selected_model',
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
    name: 'bridge.get_offset',
    description: 'Get last processed Telegram update offset',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'bridge.set_offset',
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
  const config = loadConfig();
  const modelCatalog = new ModelCatalog(config.modelCatalogPath);
  const telegram = new TelegramClient(config);
  const sessions = new SessionStore(config);

  let inputBuffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    inputBuffer += chunk;

    while (true) {
      const separatorIndex = inputBuffer.indexOf('\r\n\r\n');
      if (separatorIndex === -1) {
        break;
      }

      const header = inputBuffer.slice(0, separatorIndex);
      const contentLengthLine = header
        .split('\r\n')
        .find((line) => line.toLowerCase().startsWith('content-length:'));

      if (!contentLengthLine) {
        inputBuffer = inputBuffer.slice(separatorIndex + 4);
        continue;
      }

      const length = Number(contentLengthLine.split(':')[1]?.trim() ?? '0');
      const bodyStart = separatorIndex + 4;
      const bodyEnd = bodyStart + length;
      if (inputBuffer.length < bodyEnd) {
        break;
      }

      const body = inputBuffer.slice(bodyStart, bodyEnd);
      inputBuffer = inputBuffer.slice(bodyEnd);

      const request = JSON.parse(body) as RpcRequest;
      const response = await handleRequest(request, telegram, sessions, modelCatalog, config);
      if (response) {
        writeResponse(response);
      }
    }
  });

  process.on('SIGINT', () => {
    sessions.close();
    process.exit(0);
  });
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
    case 'telegram.fetch_updates': {
      const offset = typeof args.offset === 'number' ? args.offset : undefined;
      return telegram.getUpdates(offset);
    }
    case 'telegram.send_message': {
      const chatId = Number(args.chatId);
      const text = String(args.text ?? '');
      const messageId = await telegram.sendMessage(chatId, text);
      return { ok: true, messageId };
    }
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
    case 'session.get_history': {
      return sessions.getHistory({
        chatId: Number(args.chatId),
        topic: args.topic ? String(args.topic) : undefined,
        limit: args.limit ? Number(args.limit) : undefined
      });
    }
    case 'session.search': {
      return sessions.search({
        chatId: Number(args.chatId),
        keyword: String(args.keyword ?? ''),
        limit: args.limit ? Number(args.limit) : undefined
      });
    }
    case 'session.list_threads': {
      const chatId = typeof args.chatId === 'number' ? args.chatId : undefined;
      return sessions.listThreads(chatId);
    }
    case 'session.continue': {
      return sessions.continueContext(
        Number(args.chatId),
        String(args.topic ?? config.defaultTopic),
        args.limit ? Number(args.limit) : 20
      );
    }
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
        githubRepoUrl: config.githubRepoUrl
      }, profile.topic, profile.agent, selectedModel);
    }
    case 'bridge.get_start_message': {
      return parseTelegramText('/start', config).text;
    }
    case 'copilot.list_models': {
      return {
        models: modelCatalog.list(),
        note: '模型可用性与收费规则以你的 GitHub Copilot 订阅与官方页面为准。'
      };
    }
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
    case 'bridge.get_offset': {
      return { offset: sessions.getOffset() };
    }
    case 'bridge.set_offset': {
      return { offset: sessions.setOffset(Number(args.offset ?? 0)) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function writeResponse(response: RpcResponse): void {
  const body = JSON.stringify(response);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
  process.stdout.write(header + body);
}
