import { describe, expect, test } from 'vitest';
import {
  buildDevFileIndexCache,
  buildDevTreeEntries,
  buildGlobalFileIndexMap,
  isGitHubRepoUrl,
  makeMenuTopicStateKey,
  parseDevFileIndexCache,
  parseDevNaturalIntent,
  resolveFilePathByStableIndex,
  resolveCallbackTopic
} from '../src/devModeHelpers.js';

describe('devModeHelpers', () => {
  test('makeMenuTopicStateKey creates stable key format', () => {
    expect(makeMenuTopicStateKey(123)).toBe('ui_menu_topic_by_message_123');
    expect(makeMenuTopicStateKey(77, 'custom_')).toBe('custom_77');
  });

  test('buildGlobalFileIndexMap assigns stable global indexes for files only', () => {
    const files = [
      { name: 'src', relativePath: 'src', isDirectory: true },
      { name: 'README.md', relativePath: 'README.md', isDirectory: false },
      { name: 'package.json', relativePath: 'package.json', isDirectory: false },
      { name: 'tests', relativePath: 'tests', isDirectory: true },
      { name: 'index.ts', relativePath: 'src/index.ts', isDirectory: false }
    ];

    const map = buildGlobalFileIndexMap(files);
    expect(map.get('README.md')).toBe(1);
    expect(map.get('package.json')).toBe(2);
    expect(map.get('src/index.ts')).toBe(3);
    expect(map.has('src')).toBe(false);
  });

  test('buildDevTreeEntries keeps file index stable across pages', () => {
    const allFiles = [
      { name: 'a.ts', relativePath: 'a.ts', isDirectory: false },
      { name: 'b.ts', relativePath: 'b.ts', isDirectory: false },
      { name: 'c.ts', relativePath: 'c.ts', isDirectory: false },
      { name: 'd.ts', relativePath: 'd.ts', isDirectory: false }
    ];

    const globalMap = buildGlobalFileIndexMap(allFiles);
    const page1 = buildDevTreeEntries(allFiles.slice(0, 2), globalMap);
    const page2 = buildDevTreeEntries(allFiles.slice(2, 4), globalMap);

    expect(page1[0]?.index).toBe(1);
    expect(page1[1]?.index).toBe(2);
    expect(page2[0]?.index).toBe(3);
    expect(page2[1]?.index).toBe(4);
  });

  test('buildDevFileIndexCache exports full lookup for #fileN resolution', () => {
    const files = [
      { name: 'folder', relativePath: 'folder', isDirectory: true },
      { name: 'main.ts', relativePath: 'main.ts', isDirectory: false },
      { name: 'util.test.ts', relativePath: 'util.test.ts', isDirectory: false }
    ];

    const map = buildGlobalFileIndexMap(files);
    const cache = buildDevFileIndexCache(files, map);

    expect(cache).toEqual([
      { index: 1, relativePath: 'main.ts', ext: 'ts' },
      { index: 2, relativePath: 'util.test.ts', ext: 'ts' }
    ]);
  });

  test('resolveCallbackTopic uses mapped topic when callback message id exists', () => {
    const topic = resolveCallbackTopic({
      callbackMessageId: 1001,
      defaultTopic: 'default',
      keyPrefix: 'ui_menu_topic_by_message_',
      readState: (key) => (key === 'ui_menu_topic_by_message_1001' ? 'dev-topic-a' : undefined)
    });

    expect(topic).toBe('dev-topic-a');
  });

  test('resolveCallbackTopic falls back to default topic when mapping is missing', () => {
    const topic = resolveCallbackTopic({
      callbackMessageId: 1002,
      defaultTopic: 'default',
      keyPrefix: 'ui_menu_topic_by_message_',
      readState: () => undefined
    });

    expect(topic).toBe('default');
  });

  test('resolveCallbackTopic falls back to default topic when callback message id is invalid', () => {
    const topic1 = resolveCallbackTopic({
      callbackMessageId: undefined,
      defaultTopic: 'default',
      readState: () => 'unexpected'
    });
    const topic2 = resolveCallbackTopic({
      callbackMessageId: 0,
      defaultTopic: 'default',
      readState: () => 'unexpected'
    });

    expect(topic1).toBe('default');
    expect(topic2).toBe('default');
  });

  test('isGitHubRepoUrl validates common GitHub repository urls', () => {
    expect(isGitHubRepoUrl('https://github.com/owner/repo')).toBe(true);
    expect(isGitHubRepoUrl('https://github.com/owner/repo.git')).toBe(true);
    expect(isGitHubRepoUrl('http://github.com/owner/repo/')).toBe(true);
    expect(isGitHubRepoUrl('https://gitlab.com/owner/repo')).toBe(false);
    expect(isGitHubRepoUrl('not-a-url')).toBe(false);
  });

  test('parseDevNaturalIntent parses folder and file-index intents', () => {
    expect(parseDevNaturalIntent('文件夹 src')).toEqual({ kind: 'folder', targetPath: 'src' });
    expect(parseDevNaturalIntent('folder')).toEqual({ kind: 'folder', targetPath: undefined });
    expect(parseDevNaturalIntent('#文件12.ts')).toEqual({ kind: 'file-index', index: 12 });
    expect(parseDevNaturalIntent('#file3.md')).toEqual({ kind: 'file-index', index: 3 });
  });

  test('parseDevNaturalIntent parses github url and falls back to none', () => {
    expect(parseDevNaturalIntent('https://github.com/owner/repo')).toEqual({
      kind: 'github-url',
      repoUrl: 'https://github.com/owner/repo'
    });
    expect(parseDevNaturalIntent('#文件0.ts')).toEqual({ kind: 'none' });
    expect(parseDevNaturalIntent('随便聊点别的')).toEqual({ kind: 'none' });
  });

  test('parseDevFileIndexCache handles invalid payloads gracefully', () => {
    expect(parseDevFileIndexCache(undefined)).toEqual([]);
    expect(parseDevFileIndexCache('')).toEqual([]);
    expect(parseDevFileIndexCache('{bad json')).toEqual([]);
    expect(parseDevFileIndexCache('{"a":1}')).toEqual([]);
    expect(parseDevFileIndexCache('[{"index":"x"}]')).toEqual([]);
  });

  test('parseDevFileIndexCache parses valid cache and resolveFilePathByStableIndex finds path', () => {
    const cache = parseDevFileIndexCache(
      JSON.stringify([
        { index: 1, relativePath: 'src/index.ts', ext: 'ts' },
        { index: 2, relativePath: 'README.md', ext: 'md' }
      ])
    );

    expect(cache).toEqual([
      { index: 1, relativePath: 'src/index.ts', ext: 'ts' },
      { index: 2, relativePath: 'README.md', ext: 'md' }
    ]);
    expect(resolveFilePathByStableIndex(cache, 1)).toBe('src/index.ts');
    expect(resolveFilePathByStableIndex(cache, 2)).toBe('README.md');
    expect(resolveFilePathByStableIndex(cache, 99)).toBeUndefined();
    expect(resolveFilePathByStableIndex(cache, 0)).toBeUndefined();
  });
});
