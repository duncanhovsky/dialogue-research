import { AppConfig, ReplyMode } from './types.js';

interface LoadConfigOptions {
  requireTelegramToken?: boolean;
}

function asNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${name}: ${value}`);
  }
  return parsed;
}

function asMode(value?: string): ReplyMode {
  if (!value) {
    return 'manual';
  }
  if (value !== 'manual' && value !== 'auto') {
    throw new Error(`REPLY_MODE must be manual or auto, got: ${value}`);
  }
  return value;
}

export function loadConfig(options?: LoadConfigOptions): AppConfig {
  const requireTelegramToken = options?.requireTelegramToken ?? true;
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (requireTelegramToken && !telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  return {
    telegramBotToken,
    telegramApiBase: process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org',
    httpProxy: process.env.HTTP_PROXY,
    httpsProxy: process.env.HTTPS_PROXY,
    noProxy: process.env.NO_PROXY,
    replyMode: asMode(process.env.REPLY_MODE),
    pollTimeoutSeconds: asNumber('POLL_TIMEOUT_SECONDS', 20),
    pollIntervalMs: asNumber('POLL_INTERVAL_MS', 300),
    sessionRetentionDays: asNumber('SESSION_RETENTION_DAYS', 30),
    sessionRetentionMessages: asNumber('SESSION_RETENTION_MESSAGES', 200),
    dbPath: process.env.DB_PATH ?? './data/sessions.sqlite',
    paperCacheDir: process.env.PAPER_CACHE_DIR ?? './data/papers/cache',
    paperDbDir: process.env.PAPER_DB_DIR ?? './data/papers/library',
    defaultTopic: process.env.DEFAULT_TOPIC ?? 'default',
    defaultAgent: process.env.DEFAULT_AGENT ?? 'default',
    defaultModel: process.env.DEFAULT_MODEL ?? 'gpt-4o',
    modelCatalogPath: process.env.MODEL_CATALOG_PATH ?? './config/models.catalog.json',
    devWorkspaceRoot: process.env.DEV_WORKSPACE_ROOT ?? 'E:\\project\\bot_ws',
    githubRepoUrl: process.env.GITHUB_REPO_URL ?? 'https://github.com/duncanhovsky/dialogue-research'
  };
}
