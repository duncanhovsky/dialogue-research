import { AppConfig, ReplyMode } from './types.js';

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

export function loadConfig(): AppConfig {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (!telegramBotToken) {
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
    pollIntervalMs: asNumber('POLL_INTERVAL_MS', 1200),
    sessionRetentionDays: asNumber('SESSION_RETENTION_DAYS', 30),
    sessionRetentionMessages: asNumber('SESSION_RETENTION_MESSAGES', 200),
    dbPath: process.env.DB_PATH ?? './data/sessions.sqlite',
    defaultTopic: process.env.DEFAULT_TOPIC ?? 'default',
    defaultAgent: process.env.DEFAULT_AGENT ?? 'default',
    defaultModel: process.env.DEFAULT_MODEL ?? 'gpt-5.3-codex',
    modelCatalogPath: process.env.MODEL_CATALOG_PATH ?? './config/models.catalog.json',
    githubRepoUrl: process.env.GITHUB_REPO_URL ?? 'https://github.com/duncanhovsky/telegram-copilot-bridge-skill'
  };
}
