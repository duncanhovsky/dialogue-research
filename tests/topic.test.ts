import { describe, expect, it } from 'vitest';
import { parseTelegramText } from '../src/topic.js';
import { AppConfig } from '../src/types.js';

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
  dbPath: ':memory:',
  defaultTopic: 'default',
  defaultAgent: 'default',
  defaultModel: 'gpt-4o',
  modelCatalogPath: './config/models.catalog.json',
  devWorkspaceRoot: 'E:\\project\\bot_ws',
  githubRepoUrl: 'https://github.com/duncanhovsky/dialogue-research'
};

describe('parseTelegramText', () => {
  it('parses topic command', () => {
    const result = parseTelegramText('/topic planning', config);
    expect(result.command).toBe('topic');
    expect(result.topic).toBe('planning');
  });

  it('parses agent command', () => {
    const result = parseTelegramText('/agent gpt-4o', config);
    expect(result.command).toBe('agent');
    expect(result.agent).toBe('gpt-4o');
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

  it('parses modelsync command', () => {
    const result = parseTelegramText('/modelsync', config);
    expect(result.command).toBe('modelsync');
  });

  it('parses start command and returns welcome text', () => {
    const result = parseTelegramText('/start', config);
    expect(result.command).toBe('start');
    expect(result.text).toContain('Dialogue-Research');
    expect(result.text).toContain('/devworkspace E:\\project\\bot_ws');
    expect(result.text).toContain('https://github.com/duncanhovsky/dialogue-research');
  });

  it('parses menu command', () => {
    const result = parseTelegramText('/menu', config);
    expect(result.command).toBe('menu');
  });

  it('parses language command', () => {
    const result = parseTelegramText('/language en', config);
    expect(result.command).toBe('language');
    expect(result.languageInput).toBe('en');
  });

  it('returns english welcome when current language is en', () => {
    const result = parseTelegramText('/start', config, 'default', 'default', 'gpt-4o', 'en');
    expect(result.command).toBe('start');
    expect(result.text).toContain('Welcome to Dialogue-Research');
    expect(result.text).toContain('/language zh or /language en');
  });

  it('parses ask command', () => {
    const result = parseTelegramText('/ask 这篇论文的主要贡献是什么', config);
    expect(result.command).toBe('ask');
    expect(result.question).toContain('主要贡献');
    expect(result.askModelId).toBeUndefined();
    expect(result.modelId).toBe('gpt-4o');
  });

  it('parses ask command with model override', () => {
    const result = parseTelegramText('/ask --model gpt-4o-mini 这篇论文的方法有什么限制', config);
    expect(result.command).toBe('ask');
    expect(result.askModelId).toBe('gpt-4o-mini');
    expect(result.modelId).toBe('gpt-4o-mini');
    expect(result.question).toContain('方法有什么限制');
  });

  it('parses askm alias command', () => {
    const result = parseTelegramText('/askm gpt-4o-mini 给出这篇论文的三点局限', config);
    expect(result.command).toBe('ask');
    expect(result.askModelId).toBe('gpt-4o-mini');
    expect(result.modelId).toBe('gpt-4o-mini');
    expect(result.question).toContain('三点局限');
  });

  it('parses paper command', () => {
    const result = parseTelegramText('/paper', config);
    expect(result.command).toBe('paper');
  });

  it('parses paperhelp command', () => {
    const result = parseTelegramText('/paperhelp', config);
    expect(result.command).toBe('paperhelp');
  });

  it('parses paperadd command', () => {
    const result = parseTelegramText('/paperadd https://arxiv.org/abs/1706.03762', config);
    expect(result.command).toBe('paperadd');
    expect(result.paperInput).toContain('arxiv.org');
  });

  it('parses paperlist command', () => {
    const result = parseTelegramText('/paperlist', config);
    expect(result.command).toBe('paperlist');
  });

  it('parses paperorganize command with mode', () => {
    const result = parseTelegramText('/paperorganize got', config);
    expect(result.command).toBe('paperorganize');
    expect(result.thinkingMode).toBe('got');
  });

  it('parses paperbrainstorm command', () => {
    const result = parseTelegramText('/paperbrainstorm --mode tot 这个方法的创新点是否足够发表', config);
    expect(result.command).toBe('paperbrainstorm');
    expect(result.thinkingMode).toBe('tot');
    expect(result.brainstormQuestion).toContain('创新点');
  });

  it('parses papermode command', () => {
    const result = parseTelegramText('/papermode brainstorm got', config);
    expect(result.command).toBe('papermode');
    expect(result.paperTarget).toBe('brainstorm');
    expect(result.thinkingMode).toBe('got');
  });

  it('parses devworkspace command', () => {
    const result = parseTelegramText('/devworkspace E:/workspace/research', config);
    expect(result.command).toBe('devworkspace');
    expect(result.workspacePath).toContain('workspace');
  });

  it('parses devprojects command', () => {
    const result = parseTelegramText('/devprojects', config);
    expect(result.command).toBe('devprojects');
  });

  it('parses devcreate command', () => {
    const result = parseTelegramText('/devcreate baseline-v1', config);
    expect(result.command).toBe('devcreate');
    expect(result.projectName).toBe('baseline-v1');
  });

  it('parses devselect command', () => {
    const result = parseTelegramText('/devselect baseline-v1', config);
    expect(result.command).toBe('devselect');
    expect(result.projectName).toBe('baseline-v1');
  });

  it('parses devclone command', () => {
    const result = parseTelegramText('/devclone https://github.com/user/repo.git local-repo', config);
    expect(result.command).toBe('devclone');
    expect(result.repoUrl).toContain('github.com');
    expect(result.cloneName).toBe('local-repo');
  });

  it('parses devstatus command', () => {
    const result = parseTelegramText('/devstatus', config);
    expect(result.command).toBe('devstatus');
  });

  it('parses devhelp command', () => {
    const result = parseTelegramText('/devhelp', config);
    expect(result.command).toBe('devhelp');
  });

  it('parses devls command', () => {
    const result = parseTelegramText('/devls src', config);
    expect(result.command).toBe('devls');
    expect(result.relativePath).toBe('src');
  });

  it('parses devcat command', () => {
    const result = parseTelegramText('/devcat src/index.ts', config);
    expect(result.command).toBe('devcat');
    expect(result.relativePath).toContain('src');
  });

  it('parses devrun command', () => {
    const result = parseTelegramText('/devrun npm test', config);
    expect(result.command).toBe('devrun');
    expect(result.shellCommand).toBe('npm test');
  });

  it('parses devgit command', () => {
    const result = parseTelegramText('/devgit branch', config);
    expect(result.command).toBe('devgit');
    expect(result.gitAction).toBe('branch');
  });

  it('returns plain text payload', () => {
    const result = parseTelegramText('hello world', config, 'ops', 'default');
    expect(result.command).toBeUndefined();
    expect(result.topic).toBe('ops');
    expect(result.agent).toBe('default');
    expect(result.modelId).toBe('gpt-4o');
    expect(result.text).toBe('hello world');
  });
});
