export interface DevTreeFileLike {
  name: string;
  relativePath: string;
  isDirectory: boolean;
}

export interface DevTreeEntry {
  index: number;
  name: string;
  relativePath: string;
  isDirectory: boolean;
  ext: string;
}

export interface DevFileIndexItem {
  index: number;
  relativePath: string;
  ext: string;
}

export type DevNaturalIntent =
  | { kind: 'github-url'; repoUrl: string }
  | { kind: 'folder'; targetPath?: string }
  | { kind: 'file-index'; index: number }
  | { kind: 'none' };

export function makeMenuTopicStateKey(messageId: number, prefix = 'ui_menu_topic_by_message_'): string {
  return `${prefix}${messageId}`;
}

export function resolveCallbackTopic(params: {
  callbackMessageId?: number;
  defaultTopic: string;
  readState: (key: string) => string | undefined;
  keyPrefix?: string;
}): string {
  const { callbackMessageId, defaultTopic, readState, keyPrefix } = params;
  if (!callbackMessageId || !Number.isFinite(callbackMessageId) || callbackMessageId <= 0) {
    return defaultTopic;
  }
  const key = makeMenuTopicStateKey(callbackMessageId, keyPrefix);
  return readState(key) ?? defaultTopic;
}

export function buildGlobalFileIndexMap(files: DevTreeFileLike[]): Map<string, number> {
  const globalFileIndexMap = new Map<string, number>();
  let globalFileIndex = 0;
  for (const item of files) {
    if (!item.isDirectory) {
      globalFileIndex += 1;
      globalFileIndexMap.set(item.relativePath, globalFileIndex);
    }
  }
  return globalFileIndexMap;
}

export function buildDevTreeEntries(files: DevTreeFileLike[], globalFileIndexMap: Map<string, number>): DevTreeEntry[] {
  return files.map((item) => {
    if (item.isDirectory) {
      return {
        index: 0,
        name: item.name,
        relativePath: item.relativePath,
        isDirectory: true,
        ext: ''
      };
    }
    const extension = item.name.includes('.') ? item.name.split('.').pop() ?? 'file' : 'file';
    return {
      index: globalFileIndexMap.get(item.relativePath) ?? 0,
      name: item.name,
      relativePath: item.relativePath,
      isDirectory: false,
      ext: extension
    };
  });
}

export function buildDevFileIndexCache(files: DevTreeFileLike[], globalFileIndexMap: Map<string, number>): DevFileIndexItem[] {
  return files
    .filter((item) => !item.isDirectory)
    .map((item) => {
      const extension = item.name.includes('.') ? item.name.split('.').pop() ?? 'file' : 'file';
      return { index: globalFileIndexMap.get(item.relativePath) ?? 0, relativePath: item.relativePath, ext: extension };
    });
}

export function parseDevFileIndexCache(raw: string | undefined): DevFileIndexItem[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Array<Partial<DevFileIndexItem>>;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is DevFileIndexItem => Number.isFinite(item.index) && !!item.relativePath && !!item.ext)
      .map((item) => ({ index: Number(item.index), relativePath: String(item.relativePath), ext: String(item.ext) }));
  } catch {
    return [];
  }
}

export function resolveFilePathByStableIndex(cache: DevFileIndexItem[], index: number): string | undefined {
  if (!Number.isFinite(index) || index <= 0) {
    return undefined;
  }
  const found = cache.find((item) => item.index === index);
  return found?.relativePath;
}

export function isGitHubRepoUrl(raw: string): boolean {
  return /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(raw.trim());
}

export function parseDevNaturalIntent(raw: string): DevNaturalIntent {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { kind: 'none' };
  }

  if (isGitHubRepoUrl(trimmed)) {
    return { kind: 'github-url', repoUrl: trimmed };
  }

  const folderMatch = trimmed.match(/^(?:文件夹|folder)(?:\s+(.+))?$/i);
  if (folderMatch) {
    const targetPath = folderMatch[1]?.trim();
    return { kind: 'folder', targetPath: targetPath || undefined };
  }

  const fileMatch = trimmed.match(/^#(?:文件|file)(\d+)(?:\.[\w-]+)?$/i);
  if (fileMatch) {
    const index = Number(fileMatch[1]);
    if (Number.isFinite(index) && index > 0) {
      return { kind: 'file-index', index };
    }
  }

  return { kind: 'none' };
}
