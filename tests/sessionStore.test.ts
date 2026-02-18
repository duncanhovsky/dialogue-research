import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/sessionStore.js';
import { AppConfig } from '../src/types.js';

const stores: SessionStore[] = [];

function makeStore(): SessionStore {
  const config: AppConfig = {
    telegramBotToken: 'token',
    telegramApiBase: 'https://api.telegram.org',
    replyMode: 'manual',
    pollTimeoutSeconds: 20,
    pollIntervalMs: 1200,
    paperCacheDir: './data/papers/cache',
    paperDbDir: './data/papers/library',
    sessionRetentionDays: 30,
    sessionRetentionMessages: 200,
    dbPath: path.join(os.tmpdir(), `telegram-copilot-test-${Date.now()}-${Math.random()}.sqlite`),
    defaultTopic: 'default',
    defaultAgent: 'default',
    defaultModel: 'gpt-5.3-codex',
    modelCatalogPath: './config/models.catalog.json',
    githubRepoUrl: 'https://github.com/duncanhovsky/telegram-copilot-bridge-skill'
  };

  const store = new SessionStore(config);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0, stores.length)) {
    store.close();
  }
});

describe('SessionStore', () => {
  it('appends and reads history in order', () => {
    const store = makeStore();

    store.append({ chatId: 1, topic: 'work', role: 'user', content: 'hello', agent: 'default' });
    store.append({ chatId: 1, topic: 'work', role: 'assistant', content: 'hi', agent: 'default' });

    const history = store.getHistory({ chatId: 1, topic: 'work', limit: 10 });
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe('hello');
    expect(history[1].content).toBe('hi');
  });

  it('searches by keyword', () => {
    const store = makeStore();
    store.append({ chatId: 2, topic: 'ops', role: 'user', content: 'deploy failed', agent: 'default' });
    store.append({ chatId: 2, topic: 'ops', role: 'assistant', content: 'check logs', agent: 'default' });

    const results = store.search({ chatId: 2, keyword: 'deploy', limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('deploy');
  });

  it('stores and reads offset', () => {
    const store = makeStore();
    expect(store.getOffset()).toBe(0);
    store.setOffset(99);
    expect(store.getOffset()).toBe(99);
  });

  it('builds continuation context', () => {
    const store = makeStore();
    store.append({ chatId: 3, topic: 'default', role: 'user', content: 'first', agent: 'agent-a' });
    store.append({ chatId: 3, topic: 'default', role: 'assistant', content: 'second', agent: 'agent-a' });
    store.setSelectedModel(3, 'default', 'claude-sonnet-4.5');

    const context = store.continueContext(3, 'default', 10);
    expect(context.agent).toBe('agent-a');
    expect(context.modelId).toBe('claude-sonnet-4.5');
    expect(context.messages.length).toBe(2);
    expect(context.summary).toContain('user: first');
  });

  it('stores and reads selected model', () => {
    const store = makeStore();
    expect(store.getSelectedModel(4, 'research')).toBe('gpt-5.3-codex');
    store.setSelectedModel(4, 'research', 'gemini-2.5-pro');
    expect(store.getSelectedModel(4, 'research')).toBe('gemini-2.5-pro');
  });
});
