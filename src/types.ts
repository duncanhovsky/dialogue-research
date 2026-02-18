export type ReplyMode = 'manual' | 'auto';

export interface AppConfig {
  telegramBotToken: string;
  telegramApiBase: string;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  paperCacheDir: string;
  paperDbDir: string;
  replyMode: ReplyMode;
  pollTimeoutSeconds: number;
  pollIntervalMs: number;
  sessionRetentionDays: number;
  sessionRetentionMessages: number;
  dbPath: string;
  defaultTopic: string;
  defaultAgent: string;
  defaultModel: string;
  modelCatalogPath: string;
  githubRepoUrl: string;
}

export interface CopilotModelInfo {
  id: string;
  name: string;
  provider: string;
  pricing: string;
  referenceUrl?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    chat: {
      id: number;
      type: string;
      title?: string;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
    from?: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    document?: {
      file_id: string;
      file_unique_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
  };
}

export interface TelegramFileInfo {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface SessionMessage {
  id?: number;
  chatId: number;
  topic: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  agent: string;
  createdAt?: number;
}

export interface SessionThread {
  chatId: number;
  topic: string;
  messageCount: number;
  updatedAt: number;
}

export interface SessionQuery {
  chatId: number;
  topic?: string;
  limit?: number;
  keyword?: string;
}

export interface ContinueContextResult {
  chatId: number;
  topic: string;
  agent: string;
  modelId: string;
  messages: SessionMessage[];
  summary: string;
}
