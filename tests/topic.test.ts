import { describe, expect, it } from 'vitest';
import { parseTelegramText } from '../src/topic.js';
import { AppConfig } from '../src/types.js';

const config: AppConfig = {
  telegramBotToken: 'token',
  telegramApiBase: 'https://api.telegram.org',
  replyMode: 'manual',
  pollTimeoutSeconds: 20,
  pollIntervalMs: 1200,
  sessionRetentionDays: 30,
  sessionRetentionMessages: 200,
  dbPath: ':memory:',
  defaultTopic: 'default',
  defaultAgent: 'default',
  defaultModel: 'gpt-5.3-codex',
  modelCatalogPath: './config/models.catalog.json',
  githubRepoUrl: 'https://github.com/duncanhovsky/telegram-copilot-bridge-skill'
};

describe('parseTelegramText', () => {
  it('parses topic command', () => {
    const result = parseTelegramText('/topic planning', config);
    expect(result.command).toBe('topic');
    expect(result.topic).toBe('planning');
  });

  it('parses agent command', () => {
    const result = parseTelegramText('/agent gpt-5.3-codex', config);
    expect(result.command).toBe('agent');
    expect(result.agent).toBe('gpt-5.3-codex');
  });

  it('parses history command', () => {
    const result = parseTelegramText('/history database', config);
    expect(result.command).toBe('history');
    expect(result.keyword).toBe('database');
  });

  it('parses mode command', () => {
    const result = parseTelegramText('/mode auto', config);
    expect(result.command).toBe('mode');
    expect(result.mode).toBe('auto');
  });

  it('parses model switch command', () => {
    const result = parseTelegramText('/model claude-sonnet-4.5', config);
    expect(result.command).toBe('model');
    expect(result.modelId).toBe('claude-sonnet-4.5');
  });

  it('parses start command and returns welcome text', () => {
    const result = parseTelegramText('/start', config);
    expect(result.command).toBe('start');
    expect(result.text).toContain('Telegram ↔ VS Code Copilot Bridge Skill');
    expect(result.text).toContain('https://github.com/duncanhovsky/telegram-copilot-bridge-skill');
  });

  it('returns plain text payload', () => {
    const result = parseTelegramText('hello world', config, 'ops', 'default');
    expect(result.command).toBeUndefined();
    expect(result.topic).toBe('ops');
    expect(result.agent).toBe('default');
    expect(result.modelId).toBe('gpt-5.3-codex');
    expect(result.text).toBe('hello world');
  });
});
