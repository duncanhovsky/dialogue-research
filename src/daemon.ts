import { loadConfig } from './config.js';
import { CopilotClient } from './copilotClient.js';
import { ModelCatalog } from './modelCatalog.js';
import { PaperManager, PaperRecord } from './paperManager.js';
import { SessionStore } from './sessionStore.js';
import { InlineKeyboardMarkup, TelegramClient } from './telegram.js';
import { parseTelegramText, ThinkingMode } from './topic.js';
import { TelegramUpdate } from './types.js';
import { fetch as undiciFetch } from 'undici';
import { buildPaperBrainstormInstruction, buildPaperOrganizeInstruction } from './researchModes.js';
import { DevWorkspaceManager } from './devWorkspace.js';
import {
  buildDevFileIndexCache,
  buildDevTreeEntries,
  buildGlobalFileIndexMap,
  DevTreeEntry,
  isGitHubRepoUrl,
  makeMenuTopicStateKey,
  parseDevFileIndexCache,
  parseDevNaturalIntent,
  resolveFilePathByStableIndex,
  resolveCallbackTopic
} from './devModeHelpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  languageLabel,
  parseLanguageInput,
  pickLanguageText,
  UI_LANGUAGE_KEY,
  UiLanguage,
  withLanguageInstruction
} from './i18n.js';

const copilotLastCallAt = new Map<string, number>();
const execFileAsync = promisify(execFile);
const MAIN_MENU_MESSAGE_ID_KEY = 'ui_main_menu_message_id';
const UI_MODE_KEY = 'ui_mode';
const PAPER_SEARCH_RESULTS_KEY = 'paper_search_results';
const PAPER_RECENT_RESULTS_KEY = 'paper_recent_results';
const PAPER_ORGANIZE_MODE_KEY = 'paper_mode_organize';
const PAPER_BRAINSTORM_MODE_KEY = 'paper_mode_brainstorm';
const DEV_WORKSPACE_ROOT_KEY = 'dev_workspace_root';
const DEV_CURRENT_PROJECT_KEY = 'dev_current_project';
const DEV_GLOBAL_PROJECT_KEY = 'dev_focused_project_global';
const DEV_PROJECT_CANDIDATES_KEY = 'dev_project_candidates';
const DEV_VIBE_MODE_KEY = 'dev_vibe_mode';
const DEV_SELECTED_AGENT_KEY = 'dev_selected_agent';
const DEV_FILE_TREE_PATH_KEY = 'dev_file_tree_path';
const DEV_FILE_TREE_INDEX_KEY = 'dev_file_tree_index';
const DEV_FILE_TREE_PAGE_KEY = 'dev_file_tree_page';
const DEV_AGENT_CACHE_KEY = 'dev_agent_cache';
const DEV_NAV_STEP_KEY = 'dev_nav_step';
const PAPER_NAV_STEP_KEY = 'paper_nav_step';
const MENU_TOPIC_BY_MESSAGE_PREFIX = 'ui_menu_topic_by_message_';
const DEV_NAV_STEP = {
  PROJECTS: 'projects',
  FOCUSED: 'focused',
  VIBE: 'vibe',
  VIBE_AGENT: 'vibe_agent',
  VIBE_MODEL: 'vibe_model',
  VIBE_TREE: 'vibe_tree',
  CREATE_PROMPT: 'dev_create_prompt',
  CLONE_PROMPT: 'dev_clone_prompt'
} as const;
const PAPER_NAV_STEP = {
  MENU: 'paper_menu',
  ACTIVE: 'paper_active',
  HELP: 'paper_help',
  ADD_PROMPT: 'paper_add_prompt',
  HISTORY: 'paper_history',
  CANDIDATES: 'paper_candidates',
  ORGANIZE_PROMPT: 'paper_organize_prompt',
  BRAINSTORM_PROMPT: 'paper_brainstorm_prompt'
} as const;
const BACK_CALLBACK = {
  PAPER: 'back:paper',
  DEV_PROJECTS: 'back:dev:projects',
  DEV_FOCUSED: 'back:dev:focused',
  DEV_VIBE: 'back:dev:vibe'
} as const;
const LEGACY_BACK_CALLBACK = {
  PAPER: 'paper:back',
  DEV_PROJECTS: 'dev:back:projects',
  DEV_FOCUSED: 'dev:back:focused',
  DEV_VIBE: 'dev:back:vibe'
} as const;

type UiMode = 'home' | 'paper' | 'dev' | 'dev_vibe';

interface ArxivCandidate {
  id: string;
  title: string;
  summary: string;
  pdfUrl: string;
}

interface PaginationResult<T> {
  pageItems: T[];
  page: number;
  totalPages: number;
  startIndex: number;
}

const devWorkspace = new DevWorkspaceManager();
const PAPER_LIST_PAGE_SIZE = 6;
const DEV_PROJECT_PAGE_SIZE = 8;

function normalizeThinkingMode(raw: string | undefined, fallback: ThinkingMode = 'cot'): ThinkingMode {
  if (raw === 'cot' || raw === 'tot' || raw === 'got') {
    return raw;
  }
  return fallback;
}

function getPaperMode(store: SessionStore, chatId: number, topic: string, target: 'organize' | 'brainstorm'): ThinkingMode {
  const key = target === 'organize' ? PAPER_ORGANIZE_MODE_KEY : PAPER_BRAINSTORM_MODE_KEY;
  return normalizeThinkingMode(store.getTopicState(chatId, topic, key));
}

function setPaperMode(
  store: SessionStore,
  chatId: number,
  topic: string,
  target: 'organize' | 'brainstorm',
  mode: ThinkingMode
): void {
  const key = target === 'organize' ? PAPER_ORGANIZE_MODE_KEY : PAPER_BRAINSTORM_MODE_KEY;
  store.setTopicState(chatId, topic, key, mode);
}

function formatModelList(catalog: ModelCatalog, language: UiLanguage): string {
  const lines = catalog.list().map((item) => `- ${item.id} | ${item.name} | ${item.provider}\n  计费：${item.pricing}`);
  if (language === 'en') {
    const enLines = catalog.list().map((item) => `- ${item.id} | ${item.name} | ${item.provider}\n  Pricing: ${item.pricing}`);
    return ['Available Copilot models:', ...enLines].join('\n');
  }
  return ['当前可选 Copilot 大模型：', ...lines].join('\n');
}

function buildMainMenuKeyboard(mode: UiMode, language: UiLanguage): InlineKeyboardMarkup {
  if (mode === 'paper') {
    return {
      inline_keyboard: [
        [
          { text: language === 'en' ? '➕ Add Paper' : '➕ 添加论文', callback_data: 'paper:add' },
          { text: language === 'en' ? '📚 History' : '📚 历史论文', callback_data: 'paper:history' }
        ],
        [
          { text: language === 'en' ? '🧾 Organize' : '🧾 信息整理', callback_data: 'paper:organize' },
          { text: language === 'en' ? '🧠 Brainstorm' : '🧠 头脑风暴', callback_data: 'paper:brainstorm' }
        ],
        [{ text: language === 'en' ? '🆘 Paper Help' : '🆘 论文帮助', callback_data: 'paper:help' }],
        [
          { text: language === 'en' ? '🏠 Home' : '🏠 主菜单', callback_data: 'menu:home' }
        ]
      ]
    };
  }

  if (mode === 'dev') {
    return {
      inline_keyboard: [
        [
          { text: language === 'en' ? '📁 Projects' : '📁 项目列表', callback_data: 'dev:projects' },
          { text: language === 'en' ? '📌 Status' : '📌 当前状态', callback_data: 'dev:status' }
        ],
        [
          { text: language === 'en' ? '➕ Create' : '➕ 创建项目', callback_data: 'dev:create' },
          { text: language === 'en' ? '📥 Clone' : '📥 克隆项目', callback_data: 'dev:clone' }
        ],
        [{ text: language === 'en' ? '🆘 Dev Help' : '🆘 开发帮助', callback_data: 'dev:help' }],
        [
          { text: language === 'en' ? '🏠 Home' : '🏠 主菜单', callback_data: 'menu:home' }
        ]
      ]
    };
  }

  if (mode === 'dev_vibe') {
    return {
      inline_keyboard: [
        [
          { text: language === 'en' ? '🧩 Agent' : '🧩 智能体', callback_data: 'vibe:agent' },
          { text: language === 'en' ? '🧠 Model' : '🧠 模型', callback_data: 'vibe:model' },
          { text: language === 'en' ? '🌳 File Tree' : '🌳 文件树', callback_data: 'vibe:tree' }
        ],
        [{ text: language === 'en' ? '⬅️ Back' : '⬅️ 返回上一步', callback_data: BACK_CALLBACK.DEV_FOCUSED }],
        [
          { text: language === 'en' ? '🔁 Change Project' : '🔁 更换项目', callback_data: 'dev:switch' },
          { text: language === 'en' ? '🏠 Home' : '🏠 主菜单', callback_data: 'menu:home' }
        ]
      ]
    };
  }

  return {
    inline_keyboard: [
      [
        { text: language === 'en' ? '📚 Paper Menu' : '📚 论文菜单', callback_data: 'menu:paper' },
        { text: language === 'en' ? '💻 Dev Menu' : '💻 开发菜单', callback_data: 'menu:dev' }
      ]
    ]
  };
}

function buildMainMenuText(mode: UiMode, language: UiLanguage, detail?: string): string {
  if (language === 'en') {
    const lines =
      mode === 'paper'
        ? [
            '📚 Paper Menu',
            'Use buttons to add/switch papers, organize, and brainstorm.',
            'All paper actions stay in this inline panel to keep chat clean.'
          ]
        : mode === 'dev'
          ? [
              '💻 Development Menu',
              'Use buttons to view projects, check status, create or clone.',
              'All development actions stay in this inline panel to keep chat clean.'
            ]
          : mode === 'dev_vibe'
            ? [
                '🎛️ Vibe Coding Panel',
                'Use buttons to switch agent/model, inspect file tree, or change focused project.',
                'Then chat directly and Copilot will answer with project context.'
              ]
          : [
              '🤖 Dialogue-Research Main Menu',
              'Choose a mode below:',
              '📚 Paper Menu | 💻 Development Menu'
            ];
    if (detail) {
      lines.push('', detail);
    }
    return lines.join('\n');
  }
  const lines =
    mode === 'paper'
      ? ['📚 论文菜单', '通过按钮完成添加/切换论文、信息整理与头脑风暴。', '论文相关操作尽量都在此 inline 面板中完成，减少聊天刷屏。']
      : mode === 'dev'
        ? ['💻 开发菜单', '通过按钮查看项目、查看状态、创建或克隆项目。', '开发相关操作尽量都在此 inline 面板中完成，减少聊天刷屏。']
        : mode === 'dev_vibe'
          ? ['🎛️ Vibe Coding 面板', '通过按钮切换智能体/模型、查看文件树，或更换专注项目。', '然后直接发送需求，Copilot 会结合项目上下文回复。']
        : ['🤖 对话式科研主菜单', '请选择下方模式：', '📚 论文菜单 | 💻 开发菜单'];
  if (detail) {
    lines.push('', detail);
  }
  return lines.join('\n');
}

function normalizeUiMode(raw: string | undefined): UiMode {
  if (raw === 'paper' || raw === 'dev' || raw === 'home' || raw === 'dev_vibe') {
    return raw;
  }
  return 'home';
}

function isDevVibeMode(store: SessionStore, chatId: number, topic: string): boolean {
  return store.getTopicState(chatId, topic, DEV_VIBE_MODE_KEY) === '1';
}

function setDevVibeMode(store: SessionStore, chatId: number, topic: string, active: boolean): void {
  store.setTopicState(chatId, topic, DEV_VIBE_MODE_KEY, active ? '1' : '0');
}

function getSelectedDevAgent(store: SessionStore, config: ReturnType<typeof loadConfig>, chatId: number, topic: string): string {
  return store.getTopicState(chatId, topic, DEV_SELECTED_AGENT_KEY) ?? config.defaultAgent;
}

function setSelectedDevAgent(store: SessionStore, chatId: number, topic: string, agent: string): void {
  store.setTopicState(chatId, topic, DEV_SELECTED_AGENT_KEY, agent);
}

function getDevNavStep(store: SessionStore, chatId: number, topic: string): string {
  return store.getTopicState(chatId, topic, DEV_NAV_STEP_KEY) ?? '';
}

function setDevNavStep(store: SessionStore, chatId: number, topic: string, step: string): void {
  store.setTopicState(chatId, topic, DEV_NAV_STEP_KEY, step);
}

function getPaperNavStep(store: SessionStore, chatId: number, topic: string): string {
  return store.getTopicState(chatId, topic, PAPER_NAV_STEP_KEY) ?? '';
}

function setPaperNavStep(store: SessionStore, chatId: number, topic: string, step: string): void {
  store.setTopicState(chatId, topic, PAPER_NAV_STEP_KEY, step);
}

function isBackCallback(data: string, key: keyof typeof BACK_CALLBACK): boolean {
  return data === BACK_CALLBACK[key] || data === LEGACY_BACK_CALLBACK[key];
}

function getDevWorkspaceRoot(store: SessionStore, config: ReturnType<typeof loadConfig>, chatId: number, topic: string): string {
  return store.getTopicState(chatId, topic, DEV_WORKSPACE_ROOT_KEY) ?? config.devWorkspaceRoot;
}

function getDevCurrentProject(
  store: SessionStore,
  config: ReturnType<typeof loadConfig>,
  chatId: number,
  topic: string
): string | undefined {
  return store.getTopicState(chatId, topic, DEV_CURRENT_PROJECT_KEY) ?? store.getTopicState(chatId, config.defaultTopic, DEV_GLOBAL_PROJECT_KEY);
}

function setDevCurrentProject(
  store: SessionStore,
  config: ReturnType<typeof loadConfig>,
  chatId: number,
  topic: string,
  projectName: string,
  syncGlobal = true
): void {
  store.setTopicState(chatId, topic, DEV_CURRENT_PROJECT_KEY, projectName);
  if (syncGlobal) {
    store.setTopicState(chatId, config.defaultTopic, DEV_GLOBAL_PROJECT_KEY, projectName);
  }
}

function getUiLanguage(store: SessionStore, chatId: number, topic: string): UiLanguage {
  const raw = store.getTopicState(chatId, topic, UI_LANGUAGE_KEY);
  return raw === 'en' ? 'en' : 'zh';
}

function localize(store: SessionStore, chatId: number, topic: string, zh: string, en: string): string {
  return pickLanguageText(getUiLanguage(store, chatId, topic), zh, en);
}

function getCurrentProjectPath(
  store: SessionStore,
  config: ReturnType<typeof loadConfig>,
  chatId: number,
  topic: string
): { name: string; path: string } {
  const current = getDevCurrentProject(store, config, chatId, topic);
  if (!current) {
    throw new Error('当前未选择项目，请先执行 /devselect <项目名>。');
  }
  const root = getDevWorkspaceRoot(store, config, chatId, topic);
  const projectPath = devWorkspace.resolveProjectPath(root, current);
  return { name: current, path: projectPath };
}

function parseArxivId(input: string): string | null {
  const trimmed = input.trim();
  const absMatch = trimmed.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i);
  if (absMatch?.[1]) {
    return absMatch[1];
  }
  const idMatch = trimmed.match(/^([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)$/i);
  if (idMatch?.[1]) {
    return idMatch[1];
  }
  return null;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchArxivByTitle(query: string, max = 5): Promise<ArxivCandidate[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${max}`;
  const response = await undiciFetch(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`arXiv search failed: ${response.status}`);
  }
  const xml = await response.text();

  const entries: ArxivCandidate[] = [];
  const chunks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  for (const chunk of chunks) {
    const idRaw = chunk.match(/<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+)\s*<\/id>/i)?.[1];
    const titleRaw = chunk.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
    const summaryRaw = chunk.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1];
    if (!idRaw || !titleRaw) {
      continue;
    }

    const id = idRaw.trim();
    entries.push({
      id,
      title: decodeXml(titleRaw),
      summary: decodeXml(summaryRaw ?? ''),
      pdfUrl: `https://arxiv.org/pdf/${id}.pdf`
    });
  }

  return entries.slice(0, max);
}

async function downloadArxivPdf(id: string): Promise<Buffer> {
  const response = await undiciFetch(`https://arxiv.org/pdf/${id}.pdf`, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`arXiv PDF download failed: ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  return Buffer.from(bytes);
}

function saveCandidates<T>(store: SessionStore, chatId: number, topic: string, key: string, list: T[]): void {
  store.setTopicState(chatId, topic, key, JSON.stringify(list));
}

function readCandidates<T>(store: SessionStore, chatId: number, topic: string, key: string): T[] {
  const raw = store.getTopicState(chatId, topic, key);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function paginateItems<T>(items: T[], page: number, pageSize: number): PaginationResult<T> {
  if (items.length === 0) {
    return {
      pageItems: [],
      page: 0,
      totalPages: 1,
      startIndex: 0
    };
  }

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = safePage * pageSize;
  return {
    pageItems: items.slice(startIndex, startIndex + pageSize),
    page: safePage,
    totalPages,
    startIndex
  };
}

function parsePageFromCallback(data: string, prefix: string): number {
  const raw = data.slice(prefix.length);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function buildPaginationNavRow(
  language: UiLanguage,
  page: number,
  totalPages: number,
  prevCallbackPrefix: string,
  nextCallbackPrefix: string
) {
  if (totalPages <= 1) {
    return [] as Array<{ text: string; callback_data: string }>;
  }

  const row: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) {
    row.push({
      text: language === 'en' ? '⬅️ Prev' : '⬅️ 上一页',
      callback_data: `${prevCallbackPrefix}${page - 1}`
    });
  }
  if (page < totalPages - 1) {
    row.push({
      text: language === 'en' ? 'Next ➡️' : '下一页 ➡️',
      callback_data: `${nextCallbackPrefix}${page + 1}`
    });
  }
  return row;
}

function buildArxivPickKeyboard(candidates: ArxivCandidate[], language: UiLanguage, page = 0, pageSize = 5): InlineKeyboardMarkup {
  const pagination = paginateItems(candidates, page, pageSize);
  const rows = pagination.pageItems.map((item, index) => [
    { text: `${pagination.startIndex + index + 1}. ${item.id}`, callback_data: `paper:pick:${pagination.startIndex + index}` }
  ]);
  const navRow = buildPaginationNavRow(language, pagination.page, pagination.totalPages, 'paper:pick:page:', 'paper:pick:page:');
  if (navRow.length > 0) {
    rows.push(navRow);
  }
  rows.push([{ text: language === 'en' ? '⬅️ Back' : '⬅️ 返回上一步', callback_data: BACK_CALLBACK.PAPER }]);
  return { inline_keyboard: rows };
}

function buildRecentPaperKeyboard(records: PaperRecord[], language: UiLanguage, page = 0, pageSize = PAPER_LIST_PAGE_SIZE): InlineKeyboardMarkup {
  const pagination = paginateItems(records, page, pageSize);
  const rows = pagination.pageItems.map((item, index) => [
    { text: `${pagination.startIndex + index + 1}. ${item.title.slice(0, 40)}`, callback_data: `paper:use:${pagination.startIndex + index}` }
  ]);
  const navRow = buildPaginationNavRow(language, pagination.page, pagination.totalPages, 'paper:history:page:', 'paper:history:page:');
  if (navRow.length > 0) {
    rows.push(navRow);
  }
  rows.push([{ text: language === 'en' ? '⬅️ Back' : '⬅️ 返回上一步', callback_data: BACK_CALLBACK.PAPER }]);
  return { inline_keyboard: rows };
}

function buildDevProjectsKeyboard(language: UiLanguage, page: number, totalPages: number): InlineKeyboardMarkup {
  const baseRows = buildMainMenuKeyboard('dev', language).inline_keyboard.map((row) => [...row]);
  const navRow = buildPaginationNavRow(language, page, totalPages, 'dev:projects:page:', 'dev:projects:page:');
  if (navRow.length > 0) {
    baseRows.unshift(navRow);
  }
  return { inline_keyboard: baseRows };
}

function buildDevFocusedKeyboard(language: UiLanguage): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: language === 'en' ? '🤖 Copilot' : '🤖 Copilot', callback_data: 'dev:copilot' },
        { text: language === 'en' ? '🔁 Change Project' : '🔁 更换项目', callback_data: 'dev:switch' }
      ],
      [{ text: language === 'en' ? '⬅️ Back' : '⬅️ 返回上一步', callback_data: BACK_CALLBACK.DEV_PROJECTS }],
      [{ text: language === 'en' ? '🏠 Home' : '🏠 主菜单', callback_data: 'menu:home' }]
    ]
  };
}

function buildStepBackKeyboard(language: UiLanguage, backCallbackData: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: language === 'en' ? '⬅️ Back' : '⬅️ 返回上一步', callback_data: backCallbackData }],
      [{ text: language === 'en' ? '🏠 Home' : '🏠 主菜单', callback_data: 'menu:home' }]
    ]
  };
}

function buildAgentPickKeyboard(language: UiLanguage, agents: string[]): InlineKeyboardMarkup {
  const rows = agents.map((agent, index) => [
    { text: `${index + 1}. ${agent}`, callback_data: `vibe:agent:pick:${index}` }
  ]);
  rows.push([{ text: language === 'en' ? '⬅️ Back' : '⬅️ 返回上一步', callback_data: BACK_CALLBACK.DEV_VIBE }]);
  return { inline_keyboard: rows };
}

function buildModelPickKeyboard(language: UiLanguage, catalog: ModelCatalog): InlineKeyboardMarkup {
  const rows = catalog.list().slice(0, 30).map((model, index) => [
    { text: `${index + 1}. ${model.id}`, callback_data: `vibe:model:pick:${model.id}` }
  ]);
  rows.push([{ text: language === 'en' ? '⬅️ Back' : '⬅️ 返回上一步', callback_data: BACK_CALLBACK.DEV_VIBE }]);
  return { inline_keyboard: rows };
}

function buildFileTreeKeyboard(language: UiLanguage, page: number, totalPages: number): InlineKeyboardMarkup {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  const nav = buildPaginationNavRow(language, page, totalPages, 'vibe:tree:page:', 'vibe:tree:page:');
  if (nav.length > 0) {
    rows.push(nav);
  }
  rows.push([{ text: language === 'en' ? '⬅️ Back' : '⬅️ 返回上一步', callback_data: BACK_CALLBACK.DEV_VIBE }]);
  return { inline_keyboard: rows };
}

async function discoverAvailableAgents(config: ReturnType<typeof loadConfig>): Promise<string[]> {
  const result = new Set<string>([config.defaultAgent]);
  const configured = (process.env.COPILOT_AGENT_LIST ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  configured.forEach((item) => result.add(item));

  const discoveryCmd = (process.env.COPILOT_AGENT_DISCOVERY_CMD ?? '').trim();
  if (discoveryCmd) {
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', discoveryCmd], {
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .forEach((line) => result.add(line));
    } catch {
      // fallback to local config only
    }
  }

  const agentConfigCandidates = [
    path.resolve('config/agents.json'),
    path.resolve('config/agents.example.json')
  ];
  for (const filePath of agentConfigCandidates) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      Object.keys(parsed).forEach((key) => {
        if (key.trim()) {
          result.add(key.trim());
        }
      });
      break;
    } catch {
      // ignore malformed config
    }
  }

  return [...result].sort((a, b) => a.localeCompare(b));
}

function formatDevTreeMessage(language: UiLanguage, projectName: string, dirPath: string, entries: DevTreeEntry[]): string {
  const lines = entries.map((entry) => {
    if (entry.isDirectory) {
      return `${language === 'en' ? 'Folder' : '文件夹'} ${entry.relativePath}`;
    }
    return `#${language === 'en' ? 'file' : '文件'}${entry.index}.${entry.ext} ${entry.relativePath}`;
  });

  return pickLanguageText(
    language,
    [
      `当前项目：${projectName}`,
      `目录：${dirPath}`,
      '文件树：',
      ...lines,
      '回复“文件夹 路径”查看目录；回复“#文件N.ext”查看并解释文件。',
      '#文件N.ext 的 N 在当前目录中是全局稳定编号（跨页不变）。'
    ].join('\n'),
    [
      `Current project: ${projectName}`,
      `Directory: ${dirPath}`,
      'File tree:',
      ...lines,
      'Reply with "Folder <path>" to browse; reply with "#fileN.ext" to inspect and explain.',
      'The N in #fileN.ext is globally stable in current directory (unchanged across pages).'
    ].join('\n')
  );
}

async function ingestPaperFromArxiv(
  papers: PaperManager,
  store: SessionStore,
  chatId: number,
  topic: string,
  agent: string,
  id: string,
  suggestedTitle?: string
): Promise<PaperRecord> {
  const bytes = await downloadArxivPdf(id);
  const record = await papers.ingestPdf({
    chatId,
    topic,
    originalFileName: `${suggestedTitle ? suggestedTitle.slice(0, 80) : id}.pdf`,
    bytes
  });

  store.setTopicState(chatId, topic, 'active_paper_path', record.pdfPath);
  store.append({
    chatId,
    topic,
    role: 'system',
    agent,
    content: `[paper] title=${record.title}; category=${record.category}; path=${record.pdfPath}; source=arxiv:${id}`
  });

  return record;
}

async function tryHandleArxivDirectInput(
  telegram: TelegramClient,
  store: SessionStore,
  papers: PaperManager,
  chatId: number,
  topic: string,
  agent: string,
  text: string
): Promise<boolean> {
  const arxivId = parseArxivId(text);
  if (!arxivId) {
    return false;
  }

  await sendChunks(
    telegram,
    chatId,
    localize(
      store,
      chatId,
      topic,
      `检测到 arXiv 链接/编号，正在调用本地论文导入流程：${arxivId}`,
      `Detected arXiv link/id, importing via local paper workflow: ${arxivId}`
    )
  );

  try {
    const record = await ingestPaperFromArxiv(papers, store, chatId, topic, agent, arxivId);
    await sendChunks(
      telegram,
      chatId,
      localize(
        store,
        chatId,
        topic,
        [`论文已入库：${record.title}`, `分类：${record.category}`, `摘要：${record.summary.slice(0, 1000)}`, '可继续提问：/ask 你的问题'].join('\n'),
        [`Paper ingested: ${record.title}`, `Category: ${record.category}`, `Summary: ${record.summary.slice(0, 1000)}`, 'Continue with: /ask <your question>'].join('\n')
      )
    );
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await sendChunks(
      telegram,
      chatId,
      localize(store, chatId, topic, `arXiv 论文导入失败：${messageText}`, `arXiv import failed: ${messageText}`)
    );
  }

  return true;
}

async function upsertMainMenu(
  telegram: TelegramClient,
  store: SessionStore,
  config: ReturnType<typeof loadConfig>,
  chatId: number,
  topic: string,
  mode: UiMode,
  detail?: string,
  forceResurface = false
): Promise<number> {
  const language = getUiLanguage(store, chatId, topic);
  const text = buildMainMenuText(mode, language, detail);
  const keyboard = buildMainMenuKeyboard(mode, language);
  const rawMessageId = store.getTopicState(chatId, topic, MAIN_MENU_MESSAGE_ID_KEY);
  const existingMessageId = rawMessageId ? Number(rawMessageId) : NaN;

  if (Number.isFinite(existingMessageId) && existingMessageId > 0) {
    try {
      const messageId = await telegram.editMessageText(chatId, existingMessageId, text, keyboard);
      store.setTopicState(chatId, topic, MAIN_MENU_MESSAGE_ID_KEY, String(messageId));
      store.setTopicState(chatId, config.defaultTopic, makeMenuTopicStateKey(messageId, MENU_TOPIC_BY_MESSAGE_PREFIX), topic);
      store.setTopicState(chatId, topic, UI_MODE_KEY, mode);
      return messageId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/message is not modified/i.test(message)) {
        // fall through to send a new menu message
      } else {
        if (forceResurface) {
          const newMessageId = await telegram.sendMessage(chatId, text, keyboard);
          store.setTopicState(chatId, topic, MAIN_MENU_MESSAGE_ID_KEY, String(newMessageId));
          store.setTopicState(chatId, config.defaultTopic, makeMenuTopicStateKey(newMessageId, MENU_TOPIC_BY_MESSAGE_PREFIX), topic);
          store.setTopicState(chatId, topic, UI_MODE_KEY, mode);
          return newMessageId;
        }
        store.setTopicState(chatId, topic, UI_MODE_KEY, mode);
        return existingMessageId;
      }
    }
  }

  const messageId = await telegram.sendMessage(chatId, text, keyboard);
  store.setTopicState(chatId, topic, MAIN_MENU_MESSAGE_ID_KEY, String(messageId));
  store.setTopicState(chatId, config.defaultTopic, makeMenuTopicStateKey(messageId, MENU_TOPIC_BY_MESSAGE_PREFIX), topic);
  store.setTopicState(chatId, topic, UI_MODE_KEY, mode);
  return messageId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCopilotMinIntervalMs(): number {
  const raw = process.env.COPILOT_MIN_INTERVAL_MS;
  if (!raw) {
    return 1200;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`COPILOT_MIN_INTERVAL_MS must be a non-negative number, got: ${raw}`);
  }
  return parsed;
}

async function enforceCopilotRateLimit(chatId: number, topic: string): Promise<void> {
  const minInterval = getCopilotMinIntervalMs();
  if (minInterval === 0) {
    return;
  }

  const key = `${chatId}:${topic}`;
  const now = Date.now();
  const last = copilotLastCallAt.get(key) ?? 0;
  const waitMs = minInterval - (now - last);
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  copilotLastCallAt.set(key, Date.now());
}

function shouldAutoRefreshModelCatalog(): boolean {
  return process.env.AUTO_REFRESH_MODEL_CATALOG !== '0';
}

async function refreshModelCatalog(
  catalog: ModelCatalog,
  copilot: CopilotClient,
  config: ReturnType<typeof loadConfig>,
  force = false
): Promise<string[]> {
  if (!copilot.isEnabled()) {
    return [];
  }
  if (!force && !shouldAutoRefreshModelCatalog()) {
    return [];
  }

  const currentIds = catalog.list().map((item) => item.id);
  const discovered = await copilot.discoverAvailableChatModelIds([config.defaultModel, ...currentIds]);
  if (discovered.length === 0) {
    return [];
  }

  const ranked = [...new Set(['gpt-4o', 'gpt-4o-mini', ...discovered])].filter((id) => discovered.includes(id));
  catalog.replaceWithModelIds(ranked);
  return ranked;
}

async function refreshModelCatalogAtStartup(catalog: ModelCatalog, copilot: CopilotClient, config: ReturnType<typeof loadConfig>): Promise<void> {
  try {
    const ranked = await refreshModelCatalog(catalog, copilot, config, false);
    if (ranked.length > 0) {
      process.stdout.write(`Model catalog refreshed: ${ranked.join(', ')}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Model catalog refresh skipped: ${message}\n`);
  }
}

async function sendDevFileTree(
  telegram: TelegramClient,
  store: SessionStore,
  config: ReturnType<typeof loadConfig>,
  chatId: number,
  topic: string,
  relativePath = '.',
  page = 0
): Promise<void> {
  const language = getUiLanguage(store, chatId, topic);
  const project = getCurrentProjectPath(store, config, chatId, topic);
  const files = devWorkspace.listProjectFiles(project.path, relativePath);
  const globalFileIndexMap = buildGlobalFileIndexMap(files);
  const pagination = paginateItems(files, page, 30);
  const entries = buildDevTreeEntries(pagination.pageItems, globalFileIndexMap);
  const fileIndexMap = buildDevFileIndexCache(files, globalFileIndexMap);

  store.setTopicState(chatId, topic, DEV_FILE_TREE_PATH_KEY, relativePath);
  store.setTopicState(chatId, topic, DEV_FILE_TREE_PAGE_KEY, String(pagination.page));
  store.setTopicState(chatId, topic, DEV_FILE_TREE_INDEX_KEY, JSON.stringify(fileIndexMap));

  if (entries.length === 0) {
    await sendChunks(
      telegram,
      chatId,
      pickLanguageText(language, `当前目录为空：${relativePath}`, `Directory is empty: ${relativePath}`)
    );
    return;
  }

  const message = `${formatDevTreeMessage(language, project.name, relativePath, entries)}\n\n${pickLanguageText(language, `第 ${pagination.page + 1}/${pagination.totalPages} 页`, `Page ${pagination.page + 1}/${pagination.totalPages}`)}`;
  await telegram.sendMessage(chatId, message, buildFileTreeKeyboard(language, pagination.page, pagination.totalPages));
}

async function explainProjectFile(
  telegram: TelegramClient,
  store: SessionStore,
  config: ReturnType<typeof loadConfig>,
  catalog: ModelCatalog,
  copilot: CopilotClient,
  chatId: number,
  topic: string,
  relativePath: string,
  userPrompt?: string
): Promise<void> {
  const language = getUiLanguage(store, chatId, topic);
  const project = getCurrentProjectPath(store, config, chatId, topic);
  const content = devWorkspace.readProjectFile(project.path, relativePath, 260);

  if (!copilot.isEnabled()) {
    await sendChunks(
      telegram,
      chatId,
      pickLanguageText(
        language,
        [`当前项目：${project.name}`, `文件：${relativePath}`, '', content].join('\n'),
        [`Current project: ${project.name}`, `File: ${relativePath}`, '', content].join('\n')
      )
    );
    return;
  }

  const selectedModel = store.getSelectedModel(chatId, topic);
  const modelId = catalog.findById(selectedModel)?.id ?? config.defaultModel;
  if (modelId !== selectedModel) {
    store.setSelectedModel(chatId, topic, modelId);
  }
  const agent = getSelectedDevAgent(store, config, chatId, topic);
  const continuation = store.continueContext(chatId, topic, 20);

  await enforceCopilotRateLimit(chatId, topic);
  const reply = await copilot.generateReply({
    modelId,
    topic,
    agent,
    userInput: withLanguageInstruction(
      language,
      userPrompt ?? pickLanguageText(language, `请阅读并解释文件 ${relativePath} 的作用、关键结构与注意点。`, `Explain file ${relativePath}: purpose, key structure, and caveats.`)
    ),
    contextSummary: continuation.summary,
    extraContext: [`Project: ${project.name}`, `Path: ${relativePath}`, 'File content:', content].join('\n\n')
  });

  store.append({
    chatId,
    topic,
    role: 'assistant',
    agent,
    content: `[dev-file-explain] ${relativePath} => ${reply.slice(0, 3000)}`
  });

  await sendChunks(telegram, chatId, reply);
}

async function tryHandleDevNaturalInput(
  telegram: TelegramClient,
  store: SessionStore,
  catalog: ModelCatalog,
  copilot: CopilotClient,
  config: ReturnType<typeof loadConfig>,
  chatId: number,
  topic: string,
  text: string
): Promise<boolean> {
  const trimmed = text.trim();
  const language = getUiLanguage(store, chatId, topic);
  const currentMode = normalizeUiMode(store.getTopicState(chatId, topic, UI_MODE_KEY));
  const naturalIntent = parseDevNaturalIntent(trimmed);

  if ((currentMode === 'dev' || currentMode === 'dev_vibe') && naturalIntent.kind === 'github-url') {
    try {
      const root = getDevWorkspaceRoot(store, config, chatId, topic);
      await sendChunks(
        telegram,
        chatId,
        pickLanguageText(language, `正在克隆仓库：${naturalIntent.repoUrl}`, `Cloning repository: ${naturalIntent.repoUrl}`)
      );
      const project = await devWorkspace.cloneProject(root, naturalIntent.repoUrl);
      setDevCurrentProject(store, config, chatId, topic, project.name, true);
      await telegram.sendMessage(
        chatId,
        pickLanguageText(
          language,
          `仓库克隆成功，已设为专注项目：${project.name}\n点击“Copilot”开始 Vibe Coding，或“更换项目”切换。`,
          `Repository cloned and focused: ${project.name}\nTap Copilot to start vibe coding, or Change Project.`
        ),
        buildDevFocusedKeyboard(language)
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(telegram, chatId, pickLanguageText(language, `克隆失败：${messageText}`, `Clone failed: ${messageText}`));
    }
    return true;
  }

  if (!isDevVibeMode(store, chatId, topic)) {
    return false;
  }

  if (naturalIntent.kind === 'folder') {
    const target = naturalIntent.targetPath || store.getTopicState(chatId, topic, DEV_FILE_TREE_PATH_KEY) || '.';
    const page = Number(store.getTopicState(chatId, topic, DEV_FILE_TREE_PAGE_KEY) ?? '0');
    try {
      await sendDevFileTree(telegram, store, config, chatId, topic, target, Number.isFinite(page) ? Math.max(0, page) : 0);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(telegram, chatId, pickLanguageText(language, `读取文件夹失败：${messageText}`, `Failed to open folder: ${messageText}`));
    }
    return true;
  }

  if (naturalIntent.kind === 'file-index') {
    const index = naturalIntent.index;
    const rawMap = store.getTopicState(chatId, topic, DEV_FILE_TREE_INDEX_KEY);
    const mapping = parseDevFileIndexCache(rawMap);
    const filePath = resolveFilePathByStableIndex(mapping, index);
    if (!filePath) {
      await sendChunks(telegram, chatId, pickLanguageText(language, '索引无效，请先点“文件树”刷新列表。', 'Invalid index. Open File Tree first to refresh indexes.'));
      return true;
    }

    try {
      await explainProjectFile(telegram, store, config, catalog, copilot, chatId, topic, filePath);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(telegram, chatId, pickLanguageText(language, `文件解释失败：${messageText}`, `File explanation failed: ${messageText}`));
    }
    return true;
  }

  try {
    const project = getCurrentProjectPath(store, config, chatId, topic);
    const selectedModel = store.getSelectedModel(chatId, topic);
    const modelId = catalog.findById(selectedModel)?.id ?? config.defaultModel;
    if (modelId !== selectedModel) {
      store.setSelectedModel(chatId, topic, modelId);
    }
    const agent = getSelectedDevAgent(store, config, chatId, topic);
    const continuation = store.continueContext(chatId, topic, 20);
    const treeSnapshot = devWorkspace
      .listProjectFiles(project.path, '.')
      .slice(0, 40)
      .map((item) => `${item.isDirectory ? '[dir]' : '[file]'} ${item.relativePath}`)
      .join('\n');

    store.append({ chatId, topic, role: 'user', agent, content: trimmed });
    await enforceCopilotRateLimit(chatId, topic);
    const reply = await copilot.generateReply({
      modelId,
      topic,
      agent,
      userInput: withLanguageInstruction(language, trimmed),
      contextSummary: continuation.summary,
      extraContext: [`Focused project: ${project.name}`, 'Project structure snapshot:', treeSnapshot].join('\n\n')
    });

    store.append({ chatId, topic, role: 'assistant', agent, content: reply.slice(0, 3000) });
    await sendChunks(telegram, chatId, reply);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await sendChunks(telegram, chatId, pickLanguageText(language, `Vibe Coding 回复失败：${messageText}`, `Vibe coding reply failed: ${messageText}`));
  }

  return true;
}

async function handleMessage(
  telegram: TelegramClient,
  store: SessionStore,
  catalog: ModelCatalog,
  copilot: CopilotClient,
  papers: PaperManager,
  message: NonNullable<TelegramUpdate['message']>,
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  const chatId = message.chat.id;
  const profile = store.getCurrentProfile(chatId, config.defaultTopic);
  const selectedModel = store.getSelectedModel(chatId, profile.topic);
  const text = message.text ?? message.caption ?? '';
  const selectedLanguage = getUiLanguage(store, chatId, profile.topic);
  const parsed = parseTelegramText(text, config, profile.topic, profile.agent, selectedModel, selectedLanguage);

  if (message.document && isPdf(message.document.file_name, message.document.mime_type)) {
    await sendChunks(
      telegram,
      chatId,
      localize(store, chatId, parsed.topic, '已收到 PDF，正在阅读并分析，请稍候...', 'PDF received. Reading and analyzing, please wait...')
    );
    await handlePdfDocument(telegram, store, papers, message, parsed.topic, parsed.agent);
    return;
  }

  if (parsed.command === 'language') {
    const raw = parsed.languageInput?.trim();
    if (!raw) {
      const current = getUiLanguage(store, chatId, parsed.topic);
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          `当前语言：${languageLabel(current)}\n设置方式：/language zh 或 /language en（简写：/lang zh|en）`,
          `Current language: ${languageLabel(current)}\nUsage: /language zh or /language en (short: /lang zh|en)`
        )
      );
      return;
    }

    const nextLanguage = parseLanguageInput(raw);
    if (!nextLanguage) {
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          '不支持的语言值。请使用：/language zh 或 /language en',
          'Unsupported language value. Use: /language zh or /language en'
        )
      );
      return;
    }

    store.setTopicState(chatId, parsed.topic, UI_LANGUAGE_KEY, nextLanguage);
    await sendChunks(
      telegram,
      chatId,
      pickLanguageText(
        nextLanguage,
        `语言已切换为 ${languageLabel(nextLanguage)}。之后 bot 回复与模型输出都将遵循该语言。`,
        `Language switched to ${languageLabel(nextLanguage)}. Bot messages and model outputs will follow this setting.`
      )
    );
    return;
  }

  if (parsed.command === 'start') {
    await sendChunks(telegram, chatId, parsed.text);
    await upsertMainMenu(telegram, store, config, chatId, parsed.topic, 'home', undefined, true);
    return;
  }

  if (parsed.command === 'menu') {
    const currentMode = normalizeUiMode(store.getTopicState(chatId, parsed.topic, UI_MODE_KEY));
    await upsertMainMenu(telegram, store, config, chatId, parsed.topic, currentMode, undefined, true);
    return;
  }

  if (parsed.command === 'back') {
    const language = getUiLanguage(store, chatId, parsed.topic);
    const currentMode = normalizeUiMode(store.getTopicState(chatId, parsed.topic, UI_MODE_KEY));
    const navStep = getDevNavStep(store, chatId, parsed.topic);
    const paperNavStep = getPaperNavStep(store, chatId, parsed.topic);
    const focused = getDevCurrentProject(store, config, chatId, parsed.topic);

    const renderPaperMenuByText = async (): Promise<void> => {
      await upsertMainMenu(telegram, store, config, chatId, parsed.topic, 'paper', undefined, true);
      setPaperNavStep(store, chatId, parsed.topic, PAPER_NAV_STEP.MENU);
    };

    const isPaperStep = currentMode === 'paper';
    if (isPaperStep) {
      if (paperNavStep && paperNavStep !== PAPER_NAV_STEP.MENU) {
        await renderPaperMenuByText();
        return;
      }
      await upsertMainMenu(telegram, store, config, chatId, parsed.topic, 'home', undefined, true);
      return;
    }

    const renderFocusedByText = async (): Promise<void> => {
      if (!focused) {
        await upsertMainMenu(telegram, store, config, chatId, parsed.topic, 'dev', undefined, true);
        return;
      }
      await telegram.sendMessage(
        chatId,
        pickLanguageText(
          language,
          `已设置专注项目：${focused}\n点击“Copilot”开始 Vibe Coding，或“更换项目”返回项目列表。`,
          `Focused project set: ${focused}\nTap Copilot to start vibe coding, or Change Project to go back.`
        ),
        buildDevFocusedKeyboard(language)
      );
      store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'dev');
      setDevVibeMode(store, chatId, parsed.topic, false);
      setDevNavStep(store, chatId, parsed.topic, DEV_NAV_STEP.FOCUSED);
    };

    const renderProjectsByText = async (): Promise<void> => {
      const root = getDevWorkspaceRoot(store, config, chatId, parsed.topic);
      const projects = devWorkspace.listProjects(root);
      saveCandidates(store, chatId, parsed.topic, DEV_PROJECT_CANDIDATES_KEY, projects.map((item) => ({ name: item.name })));

      if (projects.length === 0) {
        await telegram.sendMessage(
          chatId,
          pickLanguageText(
            language,
            `欢迎进入开发模式。\n工作空间：${root}\n当前还没有项目。\n你可以发送 GitHub 仓库链接，我会在工作空间自动克隆。`,
            `Welcome to development mode.\nWorkspace: ${root}\nNo projects yet.\nSend a GitHub repo URL and I will clone it into workspace.`
          ),
          buildMainMenuKeyboard('dev', language)
        );
        store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'dev');
        setDevVibeMode(store, chatId, parsed.topic, false);
        setDevNavStep(store, chatId, parsed.topic, DEV_NAV_STEP.PROJECTS);
        return;
      }

      const pagination = paginateItems(projects, 0, DEV_PROJECT_PAGE_SIZE);
      const lines = pagination.pageItems.map((item, index) => {
        const absolute = pagination.startIndex + index;
        const tag = focused === item.name ? (language === 'en' ? ' [focused]' : ' [当前专注]') : '';
        return `${absolute + 1}. ${item.name}${item.isGitRepo ? ' (git)' : ''}${tag}`;
      });
      const projectRows = pagination.pageItems.map((item, index) => [
        {
          text: `${pagination.startIndex + index + 1}. ${item.name}`,
          callback_data: `dev:pick:${pagination.startIndex + index}`
        }
      ]);
      const navRow = buildPaginationNavRow(language, pagination.page, pagination.totalPages, 'dev:projects:page:', 'dev:projects:page:');
      if (navRow.length > 0) {
        projectRows.push(navRow);
      }
      projectRows.push([{ text: language === 'en' ? '📥 Clone by URL' : '📥 通过链接克隆', callback_data: 'dev:clone' }]);
      if (focused) {
        projectRows.push([
          { text: language === 'en' ? '🤖 Copilot' : '🤖 Copilot', callback_data: 'dev:copilot' },
          { text: language === 'en' ? '🔁 Change Project' : '🔁 更换项目', callback_data: 'dev:switch' }
        ]);
        projectRows.push([{ text: language === 'en' ? '⬅️ Back' : '⬅️ 返回上一步', callback_data: BACK_CALLBACK.DEV_FOCUSED }]);
      }
      projectRows.push([{ text: language === 'en' ? '🏠 Home' : '🏠 主菜单', callback_data: 'menu:home' }]);

      await telegram.sendMessage(
        chatId,
        pickLanguageText(
          language,
          ['欢迎进入开发模式（项目管理器）', `工作空间：${root}`, '项目列表：', ...lines, '可发送 GitHub 仓库链接直接克隆。'].join('\n'),
          ['Welcome to development mode (project manager)', `Workspace: ${root}`, 'Projects:', ...lines, 'You can send a GitHub URL to clone directly.'].join('\n')
        ),
        { inline_keyboard: projectRows }
      );
      store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'dev');
      setDevVibeMode(store, chatId, parsed.topic, false);
      setDevNavStep(store, chatId, parsed.topic, DEV_NAV_STEP.PROJECTS);
    };

    const renderVibeByText = async (): Promise<void> => {
      if (!focused) {
        await renderProjectsByText();
        return;
      }
      const selectedAgent = getSelectedDevAgent(store, config, chatId, parsed.topic);
      const selectedModel = store.getSelectedModel(chatId, parsed.topic);
      await telegram.sendMessage(
        chatId,
        pickLanguageText(
          language,
          [`当前专注项目：${focused}`, `智能体：${selectedAgent}`, `模型：${selectedModel}`, '你现在可以直接发送需求，进入 Vibe Coding。'].join('\n'),
          [`Focused project: ${focused}`, `Agent: ${selectedAgent}`, `Model: ${selectedModel}`, 'You can now chat directly for vibe coding.'].join('\n')
        ),
        buildMainMenuKeyboard('dev_vibe', language)
      );
      store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'dev_vibe');
      setDevVibeMode(store, chatId, parsed.topic, true);
      setDevNavStep(store, chatId, parsed.topic, DEV_NAV_STEP.VIBE);
    };

    const effectiveStep = navStep || currentMode;
    if (effectiveStep === DEV_NAV_STEP.VIBE_AGENT || effectiveStep === DEV_NAV_STEP.VIBE_MODEL || effectiveStep === DEV_NAV_STEP.VIBE_TREE) {
      await renderVibeByText();
      return;
    }
    if (effectiveStep === DEV_NAV_STEP.VIBE || currentMode === 'dev_vibe') {
      await renderFocusedByText();
      return;
    }
    if (effectiveStep === DEV_NAV_STEP.FOCUSED) {
      await renderProjectsByText();
      return;
    }
    if (effectiveStep === DEV_NAV_STEP.CREATE_PROMPT || effectiveStep === DEV_NAV_STEP.CLONE_PROMPT) {
      await renderProjectsByText();
      return;
    }
    if (effectiveStep === DEV_NAV_STEP.PROJECTS || currentMode === 'dev') {
      if (focused) {
        await renderFocusedByText();
      } else {
        await upsertMainMenu(telegram, store, config, chatId, parsed.topic, 'home', undefined, true);
      }
      return;
    }

    await upsertMainMenu(telegram, store, config, chatId, parsed.topic, 'home', undefined, true);
    return;
  }

  if (parsed.command === 'models') {
    await sendChunks(telegram, chatId, formatModelList(catalog, getUiLanguage(store, chatId, parsed.topic)));
    return;
  }

  if (parsed.command === 'modelsync') {
    if (!copilot.isEnabled()) {
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          '未配置 COPILOT_API_KEY 或 GITHUB_TOKEN，无法执行模型同步。',
          'COPILOT_API_KEY or GITHUB_TOKEN is not configured, model sync is unavailable.'
        )
      );
      return;
    }

    try {
      const ranked = await refreshModelCatalog(catalog, copilot, config, true);
      if (ranked.length === 0) {
        await sendChunks(
          telegram,
          chatId,
          localize(
            store,
            chatId,
            parsed.topic,
            '模型同步完成，但没有发现可用于 chat/completions 的模型。',
            'Model sync completed, but no model is available for chat/completions.'
          )
        );
        return;
      }
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          `模型同步完成（${ranked.length} 个）：\n${ranked.map((id) => `- ${id}`).join('\n')}`,
          `Model sync complete (${ranked.length}):\n${ranked.map((id) => `- ${id}`).join('\n')}`
        )
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, `模型同步失败：${messageText}`, `Model sync failed: ${messageText}`)
      );
    }
    return;
  }

  if (parsed.command === 'model') {
    const model = catalog.findById(parsed.modelId);
    if (!model) {
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          `未找到模型：${parsed.modelId}。请先执行 /models 查看可用模型。`,
          `Model not found: ${parsed.modelId}. Run /models to view available models.`
        )
      );
      return;
    }

    store.setSelectedModel(chatId, parsed.topic, parsed.modelId);
    store.append({
      chatId,
      topic: parsed.topic,
      role: 'system',
      agent: parsed.agent,
      content: `Model changed to ${parsed.modelId}`
    });

    await sendChunks(
      telegram,
      chatId,
      localize(store, chatId, parsed.topic, `已切换模型为 ${parsed.modelId}`, `Model switched to ${parsed.modelId}`)
    );
    return;
  }

  if (parsed.command === 'paper') {
    store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'paper');
    const paperPath = store.getTopicState(chatId, parsed.topic, 'active_paper_path');
    const paper = paperPath ? papers.getPaperByPath(paperPath) : null;
    if (!paper) {
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, '当前话题还没有激活论文。请先发送 PDF 文件。', 'No active paper in this topic. Please send a PDF first.')
      );
      setPaperNavStep(store, chatId, parsed.topic, PAPER_NAV_STEP.MENU);
      return;
    }

    await sendChunks(
      telegram,
      chatId,
      localize(
        store,
        chatId,
        parsed.topic,
        [
          `当前论文：${paper.title}`,
          `分类：${paper.category}`,
          `摘要：${paper.summary.slice(0, 1200)}`,
          '提问方式：/ask 你的问题',
          '临时指定模型：/ask --model <model-id> 你的问题（简写：/askm <model-id> 你的问题）'
        ].join('\n'),
        [
          `Current paper: ${paper.title}`,
          `Category: ${paper.category}`,
          `Summary: ${paper.summary.slice(0, 1200)}`,
          'Ask questions with: /ask <your question>',
          'Temporary model override: /ask --model <model-id> <your question> (short: /askm <model-id> <your question>)'
        ].join('\n')
      )
    );
    setPaperNavStep(store, chatId, parsed.topic, PAPER_NAV_STEP.ACTIVE);
    return;
  }

  if (parsed.command === 'paperhelp') {
    store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'paper');
    await sendChunks(
      telegram,
      chatId,
      localize(
        store,
        chatId,
        parsed.topic,
        [
          '📚 论文模式指南',
          '- 添加论文：发送 PDF 或 /paperadd <arXiv链接|编号|标题>',
          '- 论文状态：/paper 与 /paperlist',
          '- 论文整理：/paperorganize [cot|tot|got]',
          '- 论文讨论：/paperbrainstorm [--mode cot|tot|got] <问题>',
          '- 模式设置：/papermode <organize|brainstorm> <cot|tot|got>',
          '- 问答：/ask <问题> 或 /askm <model-id> <问题>',
          '- 返回上一步：/back 或 inline 按钮'
        ].join('\n'),
        [
          '📚 Paper Mode Guide',
          '- Add paper: send PDF or /paperadd <arXiv-link|id|title>',
          '- Paper status: /paper and /paperlist',
          '- Paper organizing: /paperorganize [cot|tot|got]',
          '- Paper discussion: /paperbrainstorm [--mode cot|tot|got] <question>',
          '- Mode config: /papermode <organize|brainstorm> <cot|tot|got>',
          '- QA: /ask <question> or /askm <model-id> <question>',
          '- Go back: /back or inline back button'
        ].join('\n')
      )
    );
    setPaperNavStep(store, chatId, parsed.topic, PAPER_NAV_STEP.HELP);
    return;
  }

  if (parsed.command === 'devworkspace') {
    const workspacePath = (parsed.workspacePath ?? '').trim();
    if (!workspacePath) {
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, '用法：/devworkspace <本地工作空间路径>', 'Usage: /devworkspace <local workspace path>')
      );
      return;
    }

    try {
      const resolved = devWorkspace.resolveWorkspaceRoot(workspacePath);
      store.setTopicState(chatId, parsed.topic, DEV_WORKSPACE_ROOT_KEY, resolved);
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, `开发工作空间已设置：${resolved}`, `Development workspace set to: ${resolved}`)
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, `设置开发工作空间失败：${messageText}`, `Failed to set development workspace: ${messageText}`)
      );
    }
    return;
  }

  if (parsed.command === 'devprojects') {
    try {
      const root = getDevWorkspaceRoot(store, config, chatId, parsed.topic);
      const projects = devWorkspace.listProjects(root).slice(0, 20);
      if (projects.length === 0) {
        await sendChunks(
          telegram,
          chatId,
          localize(
            store,
            chatId,
            parsed.topic,
            `工作空间下暂无项目：${root}\n可用 /devcreate <项目名> 或 /devclone <仓库URL>。`,
            `No projects in workspace: ${root}\nUse /devcreate <project-name> or /devclone <repo-url>.`
          )
        );
        return;
      }

      const lines = projects.map((item, index) => `${index + 1}. ${item.name}${item.isGitRepo ? ' (git)' : ''}`);
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          [`工作空间：${root}`, '项目列表：', ...lines, '可用 /devselect <项目名> 切换当前开发项目。'].join('\n'),
          [`Workspace: ${root}`, 'Projects:', ...lines, 'Use /devselect <project-name> to switch current project.'].join('\n')
        )
      );
      setDevNavStep(store, chatId, parsed.topic, DEV_NAV_STEP.PROJECTS);
      store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'dev');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, `读取项目列表失败：${messageText}`, `Failed to read project list: ${messageText}`)
      );
    }
    return;
  }

  if (parsed.command === 'devcreate') {
    const projectName = (parsed.projectName ?? '').trim();
    if (!projectName) {
      await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, '用法：/devcreate <项目名>', 'Usage: /devcreate <project-name>'));
      return;
    }

    try {
      const root = getDevWorkspaceRoot(store, config, chatId, parsed.topic);
      const project = devWorkspace.createProject(root, projectName);
      setDevCurrentProject(store, config, chatId, parsed.topic, project.name, true);
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          `项目已创建并设为当前项目：${project.name}\n路径：${project.path}`,
          `Project created and selected: ${project.name}\nPath: ${project.path}`
        )
      );
      setDevNavStep(store, chatId, parsed.topic, DEV_NAV_STEP.FOCUSED);
      store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'dev');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, `创建项目失败：${messageText}`, `Failed to create project: ${messageText}`)
      );
    }
    return;
  }

  if (parsed.command === 'devselect') {
    const projectName = (parsed.projectName ?? '').trim();
    if (!projectName) {
      await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, '用法：/devselect <项目名>', 'Usage: /devselect <project-name>'));
      return;
    }

    try {
      const root = getDevWorkspaceRoot(store, config, chatId, parsed.topic);
      const resolvedPath = devWorkspace.resolveProjectPath(root, projectName);
      setDevCurrentProject(store, config, chatId, parsed.topic, projectName, true);
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          `已切换当前项目：${projectName}\n路径：${resolvedPath}`,
          `Current project switched to: ${projectName}\nPath: ${resolvedPath}`
        )
      );
      setDevNavStep(store, chatId, parsed.topic, DEV_NAV_STEP.FOCUSED);
      store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'dev');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, `切换项目失败：${messageText}`, `Failed to switch project: ${messageText}`)
      );
    }
    return;
  }

  if (parsed.command === 'devclone') {
    const repoUrl = (parsed.repoUrl ?? '').trim();
    if (!repoUrl) {
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, '用法：/devclone <仓库URL> [项目名]', 'Usage: /devclone <repo-url> [project-name]')
      );
      return;
    }

    try {
      const root = getDevWorkspaceRoot(store, config, chatId, parsed.topic);
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, `正在克隆仓库：${repoUrl}`, `Cloning repository: ${repoUrl}`)
      );
      const project = await devWorkspace.cloneProject(root, repoUrl, parsed.cloneName);
      setDevCurrentProject(store, config, chatId, parsed.topic, project.name, true);
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          `仓库克隆成功并设为当前项目：${project.name}\n路径：${project.path}`,
          `Repository cloned and selected: ${project.name}\nPath: ${project.path}`
        )
      );
      setDevNavStep(store, chatId, parsed.topic, DEV_NAV_STEP.FOCUSED);
      store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'dev');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, `克隆仓库失败：${messageText}`, `Failed to clone repository: ${messageText}`)
      );
    }
    return;
  }

  if (parsed.command === 'devstatus') {
    const root = getDevWorkspaceRoot(store, config, chatId, parsed.topic);
    const current = getDevCurrentProject(store, config, chatId, parsed.topic) ?? '未设置';
    await sendChunks(telegram, chatId, localize(
      store,
      chatId,
      parsed.topic,
      [
        '开发模式状态：',
        `- 工作空间：${root}`,
        `- 当前项目：${current}`,
        '- 项目管理：/devprojects /devcreate /devselect /devclone',
        '- 项目操作：/devls [目录] /devcat <文件> /devrun <命令> /devgit [status|branch|log]'
      ].join('\n'),
      [
        'Development mode status:',
        `- Workspace: ${root}`,
        `- Current project: ${current}`,
        '- Project management: /devprojects /devcreate /devselect /devclone',
        '- Project operations: /devls [dir] /devcat <file> /devrun <command> /devgit [status|branch|log]'
      ].join('\n')
    ));
    return;
  }

  if (parsed.command === 'devhelp') {
    await sendChunks(
      telegram,
      chatId,
      localize(
        store,
        chatId,
        parsed.topic,
        [
          '💻 开发模式指南',
          '- 工作空间：/devworkspace <路径>',
          '- 项目管理：/devprojects /devcreate /devselect /devclone /devstatus',
          '- 项目浏览：/devls [目录] /devcat <文件路径>',
          '- 命令执行：/devrun <命令>（白名单）',
          '- Git 快捷：/devgit [status|branch|log]',
          '- 返回上一步：/back 或 inline 按钮“⬅️ 返回上一步”'
        ].join('\n'),
        [
          '💻 Development Mode Guide',
          '- Workspace: /devworkspace <path>',
          '- Project management: /devprojects /devcreate /devselect /devclone /devstatus',
          '- Project browsing: /devls [dir] /devcat <file-path>',
          '- Command execution: /devrun <command> (whitelist only)',
          '- Git shortcut: /devgit [status|branch|log]',
          '- Go back: /back or inline button "⬅️ Back"'
        ].join('\n')
      )
    );
    return;
  }

  if (parsed.command === 'devls') {
    try {
      const project = getCurrentProjectPath(store, config, chatId, parsed.topic);
      const targetPath = (parsed.relativePath ?? '.').trim() || '.';
      const files = devWorkspace.listProjectFiles(project.path, targetPath);
      if (files.length === 0) {
        await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, `目录为空：${targetPath}`, `Directory is empty: ${targetPath}`));
        return;
      }

      const lines = files.slice(0, 80).map((item) => `${item.isDirectory ? '📁' : '📄'} ${item.relativePath}`);
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          [`当前项目：${project.name}`, `目录：${targetPath}`, '内容：', ...lines, '可用：/devcat <文件路径> 查看内容。'].join('\n'),
          [`Current project: ${project.name}`, `Directory: ${targetPath}`, 'Contents:', ...lines, 'Use /devcat <file-path> to read a file.'].join('\n')
        )
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, `读取目录失败：${messageText}`, `Failed to read directory: ${messageText}`));
    }
    return;
  }

  if (parsed.command === 'devcat') {
    const targetPath = (parsed.relativePath ?? '').trim();
    if (!targetPath) {
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, '用法：/devcat <项目内文件路径>', 'Usage: /devcat <project-file-path>')
      );
      return;
    }

    try {
      const project = getCurrentProjectPath(store, config, chatId, parsed.topic);
      const content = devWorkspace.readProjectFile(project.path, targetPath, 200);
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          [`当前项目：${project.name}`, `文件：${targetPath}`, '', content].join('\n'),
          [`Current project: ${project.name}`, `File: ${targetPath}`, '', content].join('\n')
        )
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, `读取文件失败：${messageText}`, `Failed to read file: ${messageText}`));
    }
    return;
  }

  if (parsed.command === 'devrun') {
    const shellCommand = (parsed.shellCommand ?? '').trim();
    if (!shellCommand) {
      await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, '用法：/devrun <命令>', 'Usage: /devrun <command>'));
      return;
    }

    try {
      const project = getCurrentProjectPath(store, config, chatId, parsed.topic);
      await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, `正在执行命令：${shellCommand}`, `Running command: ${shellCommand}`));
      const output = await devWorkspace.runProjectCommand(project.path, shellCommand);
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          [`当前项目：${project.name}`, `命令：${shellCommand}`, '', output].join('\n'),
          [`Current project: ${project.name}`, `Command: ${shellCommand}`, '', output].join('\n')
        )
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, `执行命令失败：${messageText}`, `Command execution failed: ${messageText}`));
    }
    return;
  }

  if (parsed.command === 'devgit') {
    const action = parsed.gitAction ?? 'status';
    const command = `git ${action}`;
    try {
      const project = getCurrentProjectPath(store, config, chatId, parsed.topic);
      const output = await devWorkspace.runProjectCommand(project.path, command);
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          [`当前项目：${project.name}`, `Git 动作：${action}`, '', output].join('\n'),
          [`Current project: ${project.name}`, `Git action: ${action}`, '', output].join('\n')
        )
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, `执行 Git 失败：${messageText}`, `Git execution failed: ${messageText}`));
    }
    return;
  }

  if (parsed.command === 'papermode') {
    if (!parsed.paperTarget || !parsed.thinkingMode) {
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, '用法：/papermode <organize|brainstorm> <cot|tot|got>', 'Usage: /papermode <organize|brainstorm> <cot|tot|got>')
      );
      return;
    }

    const mode = normalizeThinkingMode(parsed.thinkingMode);
    setPaperMode(store, chatId, parsed.topic, parsed.paperTarget, mode);
    await sendChunks(
      telegram,
      chatId,
      localize(
        store,
        chatId,
        parsed.topic,
        `已设置论文${parsed.paperTarget}模式为 ${mode.toUpperCase()}。`,
        `Paper ${parsed.paperTarget} mode set to ${mode.toUpperCase()}.`
      )
    );
    return;
  }

  if (parsed.command === 'paperorganize') {
    store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'paper');
    const paperPath = store.getTopicState(chatId, parsed.topic, 'active_paper_path');
    const paper = paperPath ? papers.getPaperByPath(paperPath) : null;
    if (!paper) {
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, '当前没有可整理的论文，请先发送 PDF 或 /paperadd。', 'No paper available for organization. Send a PDF or use /paperadd first.')
      );
      setPaperNavStep(store, chatId, parsed.topic, PAPER_NAV_STEP.MENU);
      return;
    }

    const mode = normalizeThinkingMode(parsed.thinkingMode ?? getPaperMode(store, chatId, parsed.topic, 'organize'));
    const modeSource = parsed.thinkingMode ? '本次指定' : '当前配置';
    if (parsed.thinkingMode) {
      setPaperMode(store, chatId, parsed.topic, 'organize', mode);
    }

    if (!copilot.isEnabled()) {
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          '当前未配置自动大模型调用凭据，无法执行论文信息整理。',
          'No model credentials configured for auto invocation, cannot run paper organization.'
        )
      );
      return;
    }

    const organizeQuestion = '请对当前论文做标准化信息整理。';
    const copilotContext = papers.buildCopilotQaContext(paper, organizeQuestion);
    const continuation = store.continueContext(chatId, parsed.topic, 20);

    try {
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          `正在整理论文信息（模式 ${mode.toUpperCase()}，${modeSource}），请稍候...`,
          `Organizing paper information (mode ${mode.toUpperCase()}, ${modeSource}), please wait...`
        )
      );
      await enforceCopilotRateLimit(chatId, parsed.topic);
      const language = getUiLanguage(store, chatId, parsed.topic);
      const answer = await copilot.generateReply({
        modelId: parsed.modelId,
        topic: parsed.topic,
        agent: parsed.agent,
        userInput: buildPaperOrganizeInstruction(mode, language),
        contextSummary: continuation.summary,
        extraContext: copilotContext
      });

      store.append({
        chatId,
        topic: parsed.topic,
        role: 'assistant',
        agent: parsed.agent,
        content: `[paper-organize:${mode}] ${answer.slice(0, 3000)}`
      });
      await sendChunks(telegram, chatId, answer);
      setPaperNavStep(store, chatId, parsed.topic, PAPER_NAV_STEP.ORGANIZE_PROMPT);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, `论文信息整理失败：${messageText}`, `Paper organization failed: ${messageText}`));
    }

    return;
  }

  if (parsed.command === 'paperbrainstorm') {
    store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'paper');
    const paperPath = store.getTopicState(chatId, parsed.topic, 'active_paper_path');
    const paper = paperPath ? papers.getPaperByPath(paperPath) : null;
    if (!paper) {
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, '当前没有可讨论的论文，请先发送 PDF 或 /paperadd。', 'No paper available for brainstorming. Send a PDF or use /paperadd first.')
      );
      setPaperNavStep(store, chatId, parsed.topic, PAPER_NAV_STEP.MENU);
      return;
    }

    const question = (parsed.brainstormQuestion ?? '').trim();
    if (!question) {
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          '请使用 /paperbrainstorm <你的科研问题>，可选 --mode cot|tot|got。',
          'Use /paperbrainstorm <your research question>, optional --mode cot|tot|got.'
        )
      );
      return;
    }

    const mode = normalizeThinkingMode(parsed.thinkingMode ?? getPaperMode(store, chatId, parsed.topic, 'brainstorm'));
    const modeSource = parsed.thinkingMode ? '本次指定' : '当前配置';
    if (parsed.thinkingMode) {
      setPaperMode(store, chatId, parsed.topic, 'brainstorm', mode);
    }

    if (!copilot.isEnabled()) {
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          '当前未配置自动大模型调用凭据，无法执行论文头脑风暴。',
          'No model credentials configured for auto invocation, cannot run paper brainstorming.'
        )
      );
      return;
    }

    const copilotContext = papers.buildCopilotQaContext(paper, question);
    const continuation = store.continueContext(chatId, parsed.topic, 20);
    try {
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          `正在进行5角色头脑风暴（模式 ${mode.toUpperCase()}，${modeSource}），请稍候...`,
          `Running 5-role brainstorming (mode ${mode.toUpperCase()}, ${modeSource}), please wait...`
        )
      );
      await enforceCopilotRateLimit(chatId, parsed.topic);
      const language = getUiLanguage(store, chatId, parsed.topic);
      const answer = await copilot.generateReply({
        modelId: parsed.modelId,
        topic: parsed.topic,
        agent: parsed.agent,
        userInput: buildPaperBrainstormInstruction(mode, question, language),
        contextSummary: continuation.summary,
        extraContext: copilotContext
      });

      store.append({
        chatId,
        topic: parsed.topic,
        role: 'assistant',
        agent: parsed.agent,
        content: `[paper-brainstorm:${mode}] ${question} => ${answer.slice(0, 3000)}`
      });
      await sendChunks(telegram, chatId, answer);
      setPaperNavStep(store, chatId, parsed.topic, PAPER_NAV_STEP.BRAINSTORM_PROMPT);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, `论文头脑风暴失败：${messageText}`, `Paper brainstorming failed: ${messageText}`));
    }
    return;
  }

  if (parsed.command === 'paperlist') {
    store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'paper');
    const recent = papers.listRecent(chatId, parsed.topic, 30);
    if (recent.length === 0) {
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          '当前话题没有历史论文。可先发送 PDF，或使用 /paperadd <arXiv链接/论文名>。',
          'No historical papers in this topic. Send a PDF first or use /paperadd <arXiv link/title>.'
        )
      );
      setPaperNavStep(store, chatId, parsed.topic, PAPER_NAV_STEP.MENU);
      return;
    }

    saveCandidates(store, chatId, parsed.topic, PAPER_RECENT_RESULTS_KEY, recent);
    const pagination = paginateItems(recent, 0, PAPER_LIST_PAGE_SIZE);
    const lines = pagination.pageItems.map((item, index) => `${pagination.startIndex + index + 1}. ${item.title} (${item.category})`).join('\n');
    await telegram.sendMessage(
      chatId,
      localize(
        store,
        chatId,
        parsed.topic,
        `历史论文（第 ${pagination.page + 1}/${pagination.totalPages} 页，点击按钮激活）：\n${lines}`,
        `Recent papers (page ${pagination.page + 1}/${pagination.totalPages}, click to activate):\n${lines}`
      ),
      buildRecentPaperKeyboard(recent, getUiLanguage(store, chatId, parsed.topic), pagination.page, PAPER_LIST_PAGE_SIZE)
    );
    setPaperNavStep(store, chatId, parsed.topic, PAPER_NAV_STEP.HISTORY);
    return;
  }

  if (parsed.command === 'paperadd') {
    store.setTopicState(chatId, parsed.topic, UI_MODE_KEY, 'paper');
    const input = (parsed.paperInput ?? '').trim();
    if (!input) {
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          '请使用 /paperadd <arXiv链接|arXiv编号|论文标题>。',
          'Use /paperadd <arXiv-link|arXiv-id|paper-title>.'
        )
      );
      return;
    }

    const arxivId = parseArxivId(input);
    if (arxivId) {
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, `正在从 arXiv 下载论文 ${arxivId}，请稍候...`, `Downloading arXiv paper ${arxivId}, please wait...`)
      );
      try {
        const record = await ingestPaperFromArxiv(papers, store, chatId, parsed.topic, parsed.agent, arxivId);
        await sendChunks(
          telegram,
          chatId,
          localize(
            store,
            chatId,
            parsed.topic,
            [`论文已入库：${record.title}`, `分类：${record.category}`, `摘要：${record.summary.slice(0, 1000)}`, '可继续提问：/ask 你的问题'].join('\n'),
            [`Paper ingested: ${record.title}`, `Category: ${record.category}`, `Summary: ${record.summary.slice(0, 1000)}`, 'Continue with: /ask <your question>'].join('\n')
          )
        );
        setPaperNavStep(store, chatId, parsed.topic, PAPER_NAV_STEP.ACTIVE);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, `arXiv 论文导入失败：${messageText}`, `arXiv import failed: ${messageText}`));
      }
      return;
    }

    await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, `正在检索 arXiv：${input}`, `Searching arXiv: ${input}`));
    try {
      const candidates = await searchArxivByTitle(input, 5);
      if (candidates.length === 0) {
        await sendChunks(
          telegram,
          chatId,
          localize(
            store,
            chatId,
            parsed.topic,
            '未检索到候选论文，请尝试更具体的标题关键词。',
            'No candidate papers found. Try a more specific title query.'
          )
        );
        setPaperNavStep(store, chatId, parsed.topic, PAPER_NAV_STEP.ADD_PROMPT);
        return;
      }

      saveCandidates(store, chatId, parsed.topic, PAPER_SEARCH_RESULTS_KEY, candidates);
      const lines = candidates.map((item, index) => `${index + 1}. ${item.title} (${item.id})`).join('\n');
      await telegram.sendMessage(
        chatId,
        localize(store, chatId, parsed.topic, `检索到以下候选（点击按钮导入）：\n${lines}`, `Candidates found (click to import):\n${lines}`),
        buildArxivPickKeyboard(candidates, getUiLanguage(store, chatId, parsed.topic))
      );
      setPaperNavStep(store, chatId, parsed.topic, PAPER_NAV_STEP.CANDIDATES);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, `arXiv 检索失败：${messageText}`, `arXiv search failed: ${messageText}`));
    }
    return;
  }

  if (parsed.command === 'ask') {
    const paperPath = store.getTopicState(chatId, parsed.topic, 'active_paper_path');
    const paper = paperPath ? papers.getPaperByPath(paperPath) : null;
    if (!paper) {
      await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, '当前没有可问答的论文，请先发送 PDF。', 'No paper available for QA. Please send a PDF first.'));
      return;
    }

    const question = (parsed.question ?? '').trim();
    if (!question) {
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          '请使用 /ask <你的问题> 进行提问，或 /ask --model <model-id> <你的问题>。',
          'Use /ask <your question> or /ask --model <model-id> <your question>.'
        )
      );
      return;
    }

    const askModelId = parsed.askModelId?.trim();
    if (askModelId) {
      const model = catalog.findById(askModelId);
      if (!model) {
        await sendChunks(
          telegram,
          chatId,
          localize(
            store,
            chatId,
            parsed.topic,
            `未找到模型：${askModelId}。请先执行 /models 查看可用模型。`,
            `Model not found: ${askModelId}. Run /models to view available models.`
          )
        );
        return;
      }
    }

    let modelIdForAsk = askModelId || parsed.modelId;
    if (!askModelId && !catalog.findById(modelIdForAsk)) {
      modelIdForAsk = config.defaultModel;
      store.setSelectedModel(chatId, parsed.topic, modelIdForAsk);
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          `检测到当前话题模型不可用，已自动回退为 ${modelIdForAsk}。可用 /model <id> 或 /askm <id> <问题> 指定模型。`,
          `Current topic model is unavailable; auto-fallback to ${modelIdForAsk}. Use /model <id> or /askm <id> <question> to override.`
        )
      );
    }

    const copilotContext = papers.buildCopilotQaContext(paper, question);

    store.append({
      chatId,
      topic: parsed.topic,
      role: 'user',
      agent: parsed.agent,
      content: question
    });

    store.append({
      chatId,
      topic: parsed.topic,
      role: 'system',
      agent: parsed.agent,
      content: `[paper-context]\n${copilotContext.slice(0, 6000)}`
    });

    const continuation = store.continueContext(chatId, parsed.topic, 20);
    if (!copilot.isEnabled()) {
      await sendChunks(
        telegram,
        chatId,
        localize(
          store,
          chatId,
          parsed.topic,
          ['已记录你的论文问题和上下文。', '当前未配置自动大模型调用凭据。', '请设置环境变量 COPILOT_API_KEY 或 GITHUB_TOKEN 后重启 daemon。'].join('\n'),
          ['Your paper question and context are saved.', 'Auto model credentials are not configured.', 'Set COPILOT_API_KEY or GITHUB_TOKEN and restart the daemon.'].join('\n')
        )
      );
      return;
    }

    try {
      await enforceCopilotRateLimit(chatId, parsed.topic);
      const language = getUiLanguage(store, chatId, parsed.topic);
      const answer = await copilot.generateReply({
        modelId: modelIdForAsk,
        topic: parsed.topic,
        agent: parsed.agent,
        userInput: withLanguageInstruction(language, question),
        contextSummary: continuation.summary,
        extraContext: copilotContext
      });

      store.append({
        chatId,
        topic: parsed.topic,
        role: 'assistant',
        agent: parsed.agent,
        content: `[copilot-paper-qa] ${question} => ${answer.slice(0, 3000)}`
      });

      await sendChunks(telegram, chatId, answer);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendChunks(
        telegram,
        chatId,
        localize(store, chatId, parsed.topic, `自动 Copilot 论文问答失败：${messageText}`, `Automatic Copilot paper QA failed: ${messageText}`)
      );
    }
    return;
  }

  if (!parsed.command) {
    const consumed = await tryHandleArxivDirectInput(telegram, store, papers, chatId, parsed.topic, parsed.agent, parsed.text);
    if (consumed) {
      return;
    }

    const devConsumed = await tryHandleDevNaturalInput(telegram, store, catalog, copilot, config, chatId, parsed.topic, parsed.text);
    if (devConsumed) {
      return;
    }
  }

  if (parsed.command === 'history') {
    const records = parsed.keyword
      ? store.search({ chatId, keyword: parsed.keyword, limit: 8 })
      : store.getHistory({ chatId, topic: parsed.topic, limit: 8 });

    if (records.length === 0) {
      await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, '未找到历史记录。', 'No history found.'));
      return;
    }

    const preview = records
      .slice(-8)
      .map((item) => `${item.role}: ${item.content.replace(/\s+/g, ' ').slice(0, 120)}`)
      .join('\n');

    await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, `历史记录预览：\n${preview}`, `History preview:\n${preview}`));
    return;
  }

  if (parsed.command === 'topic' || parsed.command === 'agent' || parsed.command === 'mode') {
    store.append({
      chatId,
      topic: parsed.topic,
      role: 'system',
      agent: parsed.agent,
      content: parsed.text
    });

    await sendChunks(telegram, chatId, parsed.text);
    return;
  }

  store.append({
    chatId,
    topic: parsed.topic,
    role: 'user',
    agent: parsed.agent,
    content: parsed.text
  });

  const continuation = store.continueContext(chatId, parsed.topic, 20);
  let modelIdForReply = parsed.modelId;
  if (!catalog.findById(modelIdForReply)) {
    modelIdForReply = config.defaultModel;
    store.setSelectedModel(chatId, parsed.topic, modelIdForReply);
    await sendChunks(
      telegram,
      chatId,
      localize(
        store,
        chatId,
        parsed.topic,
        `检测到当前话题模型不可用，已自动回退为 ${modelIdForReply}。可用 /model <id> 手动切换。`,
        `Current topic model is unavailable; auto-fallback to ${modelIdForReply}. Use /model <id> to switch manually.`
      )
    );
  }
  if (!copilot.isEnabled()) {
    await sendChunks(
      telegram,
      chatId,
      localize(
        store,
        chatId,
        parsed.topic,
        `已收到消息并写入会话（topic=${parsed.topic}, agent=${parsed.agent}, model=${parsed.modelId}）。\n未配置自动大模型调用凭据。请设置 COPILOT_API_KEY 或 GITHUB_TOKEN 后重启 daemon。`,
        `Message saved to session (topic=${parsed.topic}, agent=${parsed.agent}, model=${parsed.modelId}).\nAuto model credentials are not configured. Set COPILOT_API_KEY or GITHUB_TOKEN and restart the daemon.`
      )
    );
    return;
  }

  try {
    await enforceCopilotRateLimit(chatId, parsed.topic);
    const language = getUiLanguage(store, chatId, parsed.topic);
    const reply = await copilot.generateReply({
      modelId: modelIdForReply,
      topic: parsed.topic,
      agent: parsed.agent,
      userInput: withLanguageInstruction(language, parsed.text),
      contextSummary: continuation.summary
    });

    store.append({
      chatId,
      topic: parsed.topic,
      role: 'assistant',
      agent: parsed.agent,
      content: reply.slice(0, 3000)
    });

    await sendChunks(telegram, chatId, reply);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await sendChunks(telegram, chatId, localize(store, chatId, parsed.topic, `自动 Copilot 回复失败：${messageText}`, `Automatic Copilot reply failed: ${messageText}`));
  }
}

async function handleCallbackQuery(
  telegram: TelegramClient,
  store: SessionStore,
  catalog: ModelCatalog,
  copilot: CopilotClient,
  papers: PaperManager,
  callbackQuery: NonNullable<TelegramUpdate['callback_query']>,
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  const chatId = callbackQuery.message?.chat.id;
  if (!chatId) {
    await telegram.answerCallbackQuery(callbackQuery.id);
    return;
  }

  const data = (callbackQuery.data ?? '').trim();
  const callbackMessageId = callbackQuery.message?.message_id;
  const topic = resolveCallbackTopic({
    callbackMessageId,
    defaultTopic: config.defaultTopic,
    keyPrefix: MENU_TOPIC_BY_MESSAGE_PREFIX,
    readState: (key) => store.getTopicState(chatId, config.defaultTopic, key)
  });
  const language = getUiLanguage(store, chatId, topic);

  const renderPanel = async (mode: UiMode, detail?: string, customKeyboard?: InlineKeyboardMarkup): Promise<void> => {
    const text = buildMainMenuText(mode, language, detail);
    const keyboard = customKeyboard ?? buildMainMenuKeyboard(mode, language);

    if (callbackMessageId) {
      try {
        const messageId = await telegram.editMessageText(chatId, callbackMessageId, text, keyboard);
        store.setTopicState(chatId, topic, MAIN_MENU_MESSAGE_ID_KEY, String(messageId));
        store.setTopicState(chatId, topic, UI_MODE_KEY, mode);
        setDevVibeMode(store, chatId, topic, mode === 'dev_vibe');
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/message is not modified/i.test(message)) {
          store.setTopicState(chatId, topic, UI_MODE_KEY, mode);
          setDevVibeMode(store, chatId, topic, mode === 'dev_vibe');
          return;
        }
      }
    }

    await upsertMainMenu(telegram, store, config, chatId, topic, mode, detail);
    setDevVibeMode(store, chatId, topic, mode === 'dev_vibe');
  };

  const renderDevFocusedPanel = async (projectNameOverride?: string): Promise<void> => {
    const focused = projectNameOverride ?? getDevCurrentProject(store, config, chatId, topic);
    if (!focused) {
      await renderDevProjectPanel(0);
      return;
    }

    await renderPanel(
      'dev',
      pickLanguageText(
        language,
        `已设置专注项目：${focused}\n点击“Copilot”开始 Vibe Coding，或“更换项目”返回项目列表。`,
        `Focused project set: ${focused}\nTap Copilot to start vibe coding, or Change Project to go back.`
      ),
      buildDevFocusedKeyboard(language)
    );
    setDevNavStep(store, chatId, topic, DEV_NAV_STEP.FOCUSED);
  };

  const renderDevProjectPanel = async (requestedPage = 0): Promise<void> => {
    const root = getDevWorkspaceRoot(store, config, chatId, topic);
    const projects = devWorkspace.listProjects(root);
    const focused = getDevCurrentProject(store, config, chatId, topic);
    saveCandidates(store, chatId, topic, DEV_PROJECT_CANDIDATES_KEY, projects.map((item) => ({ name: item.name })));

    if (projects.length === 0) {
      await renderPanel(
        'dev',
        pickLanguageText(
          language,
          `欢迎进入开发模式。\n工作空间：${root}\n当前还没有项目。\n你可以发送 GitHub 仓库链接，我会在工作空间自动克隆。`,
          `Welcome to development mode.\nWorkspace: ${root}\nNo projects yet.\nSend a GitHub repo URL and I will clone it into workspace.`
        )
      );
      return;
    }

    const pagination = paginateItems(projects, requestedPage, DEV_PROJECT_PAGE_SIZE);
    const lines = pagination.pageItems.map((item, index) => {
      const absolute = pagination.startIndex + index;
      const tag = focused === item.name ? (language === 'en' ? ' [focused]' : ' [当前专注]') : '';
      return `${absolute + 1}. ${item.name}${item.isGitRepo ? ' (git)' : ''}${tag}`;
    });

    const projectRows = pagination.pageItems.map((item, index) => [
      {
        text: `${pagination.startIndex + index + 1}. ${item.name}`,
        callback_data: `dev:pick:${pagination.startIndex + index}`
      }
    ]);
    const navRow = buildPaginationNavRow(language, pagination.page, pagination.totalPages, 'dev:projects:page:', 'dev:projects:page:');
    if (navRow.length > 0) {
      projectRows.push(navRow);
    }
    projectRows.push([{ text: language === 'en' ? '📥 Clone by URL' : '📥 通过链接克隆', callback_data: 'dev:clone' }]);
    if (focused) {
      projectRows.push([
        { text: language === 'en' ? '🤖 Copilot' : '🤖 Copilot', callback_data: 'dev:copilot' },
        { text: language === 'en' ? '🔁 Change Project' : '🔁 更换项目', callback_data: 'dev:switch' }
      ]);
      projectRows.push([{ text: language === 'en' ? '⬅️ Back' : '⬅️ 返回上一步', callback_data: BACK_CALLBACK.DEV_FOCUSED }]);
    }
    projectRows.push([{ text: language === 'en' ? '🏠 Home' : '🏠 主菜单', callback_data: 'menu:home' }]);

    await renderPanel(
      'dev',
      pickLanguageText(
        language,
        [
          '欢迎进入开发模式（项目管理器）',
          `工作空间：${root}`,
          '项目列表：',
          ...lines,
          '可发送 GitHub 仓库链接直接克隆。'
        ].join('\n'),
        [
          'Welcome to development mode (project manager)',
          `Workspace: ${root}`,
          'Projects:',
          ...lines,
          'You can send a GitHub URL to clone directly.'
        ].join('\n')
      ),
      { inline_keyboard: projectRows }
    );
    setDevNavStep(store, chatId, topic, DEV_NAV_STEP.PROJECTS);
  };

  const renderVibePanel = async (): Promise<void> => {
    const focused = getDevCurrentProject(store, config, chatId, topic);
    if (!focused) {
      await renderDevProjectPanel(0);
      return;
    }

    const selectedAgent = getSelectedDevAgent(store, config, chatId, topic);
    const selectedModel = store.getSelectedModel(chatId, topic);
    await renderPanel(
      'dev_vibe',
      pickLanguageText(
        language,
        [`当前专注项目：${focused}`, `智能体：${selectedAgent}`, `模型：${selectedModel}`, '你现在可以直接发送需求，进入 Vibe Coding。'].join('\n'),
        [`Focused project: ${focused}`, `Agent: ${selectedAgent}`, `Model: ${selectedModel}`, 'You can now chat directly for vibe coding.'].join('\n')
      ),
      buildMainMenuKeyboard('dev_vibe', language)
    );
    setDevNavStep(store, chatId, topic, DEV_NAV_STEP.VIBE);
  };

  if (data === 'menu:paper') {
    await renderPanel('paper');
    setPaperNavStep(store, chatId, topic, PAPER_NAV_STEP.MENU);
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '已切换到论文模式', 'Switched to paper mode'));
    return;
  }

  if (isBackCallback(data, 'PAPER')) {
    await renderPanel('paper');
    setPaperNavStep(store, chatId, topic, PAPER_NAV_STEP.MENU);
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '已返回上一步', 'Back to previous step'));
    return;
  }

  if (data === 'menu:dev') {
    await renderDevProjectPanel(0);
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '已切换到开发模式', 'Switched to development mode'));
    return;
  }

  if (data === 'dev:switch') {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '请选择项目', 'Select a project'));
    await renderDevProjectPanel(0);
    return;
  }

  if (isBackCallback(data, 'DEV_PROJECTS')) {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '已返回项目列表', 'Back to project list'));
    await renderDevProjectPanel(0);
    return;
  }

  if (isBackCallback(data, 'DEV_FOCUSED')) {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '已返回上一步', 'Back to previous step'));
    await renderDevFocusedPanel();
    return;
  }

  if (isBackCallback(data, 'DEV_VIBE')) {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '已返回上一步', 'Back to previous step'));
    await renderVibePanel();
    return;
  }

  if (data.startsWith('dev:pick:')) {
    const index = Number(data.split(':')[2]);
    const candidates = readCandidates<{ name: string }>(store, chatId, topic, DEV_PROJECT_CANDIDATES_KEY);
    const selected = Number.isFinite(index) ? candidates[index] : undefined;
    if (!selected?.name) {
      await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '项目列表已失效，请刷新', 'Project list expired, please refresh'));
      await renderDevProjectPanel(0);
      return;
    }

    try {
      const root = getDevWorkspaceRoot(store, config, chatId, topic);
      devWorkspace.resolveProjectPath(root, selected.name);
      setDevCurrentProject(store, config, chatId, topic, selected.name, true);
      await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, `已选择 ${selected.name}`, `Selected ${selected.name}`));
      await renderDevFocusedPanel(selected.name);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '项目不可用', 'Project unavailable'));
      await renderPanel('dev', pickLanguageText(language, `设置项目失败：${messageText}`, `Failed to set project: ${messageText}`));
    }
    return;
  }

  if (data === 'dev:copilot') {
    const focused = getDevCurrentProject(store, config, chatId, topic);
    if (!focused) {
      await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '请先选择项目', 'Select a project first'));
      await renderDevProjectPanel(0);
      return;
    }

    const agents = await discoverAvailableAgents(config);
    store.setTopicState(chatId, topic, DEV_AGENT_CACHE_KEY, JSON.stringify(agents));
    const preferredModel = 'gpt-5.3-codex';
    if (catalog.findById(preferredModel)) {
      store.setSelectedModel(chatId, topic, preferredModel);
    } else if (!catalog.findById(store.getSelectedModel(chatId, topic))) {
      store.setSelectedModel(chatId, topic, config.defaultModel);
    }

    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '已进入 Copilot 模式', 'Entered Copilot mode'));
    await renderVibePanel();
    return;
  }

  if (data === 'vibe:agent') {
    const freshAgents = await discoverAvailableAgents(config);
    store.setTopicState(chatId, topic, DEV_AGENT_CACHE_KEY, JSON.stringify(freshAgents));
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '请选择智能体', 'Choose an agent'));
    await renderPanel(
      'dev_vibe',
      pickLanguageText(language, '请选择用于 Vibe Coding 的智能体：', 'Pick an agent for vibe coding:'),
      buildAgentPickKeyboard(language, freshAgents)
    );
    setDevNavStep(store, chatId, topic, DEV_NAV_STEP.VIBE_AGENT);
    return;
  }

  if (data.startsWith('vibe:agent:pick:')) {
    const index = Number(data.split(':')[3]);
    const raw = store.getTopicState(chatId, topic, DEV_AGENT_CACHE_KEY) ?? '[]';
    const agents = (() => {
      try {
        const parsed = JSON.parse(raw) as string[];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [] as string[];
      }
    })();
    const selected = Number.isFinite(index) ? agents[index] : undefined;
    if (!selected) {
      await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '智能体列表已过期', 'Agent list expired'));
      await renderVibePanel();
      return;
    }

    setSelectedDevAgent(store, chatId, topic, selected);
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, `已切换智能体 ${selected}`, `Agent switched to ${selected}`));
    await renderVibePanel();
    return;
  }

  if (data === 'vibe:model') {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '请选择模型', 'Choose a model'));
    await renderPanel(
      'dev_vibe',
      pickLanguageText(language, '请选择用于 Vibe Coding 的模型：', 'Pick a model for vibe coding:'),
      buildModelPickKeyboard(language, catalog)
    );
    setDevNavStep(store, chatId, topic, DEV_NAV_STEP.VIBE_MODEL);
    return;
  }

  if (data.startsWith('vibe:model:pick:')) {
    const modelId = data.slice('vibe:model:pick:'.length).trim();
    if (!catalog.findById(modelId)) {
      await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '模型不可用', 'Model unavailable'));
      await renderVibePanel();
      return;
    }
    store.setSelectedModel(chatId, topic, modelId);
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, `已切换模型 ${modelId}`, `Model switched to ${modelId}`));
    await renderVibePanel();
    return;
  }

  if (data === 'vibe:tree') {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '正在加载文件树', 'Loading file tree'));
    try {
      await sendDevFileTree(telegram, store, config, chatId, topic, '.', 0);
      await renderVibePanel();
      setDevNavStep(store, chatId, topic, DEV_NAV_STEP.VIBE_TREE);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await renderPanel('dev_vibe', pickLanguageText(language, `文件树加载失败：${messageText}`, `File tree failed: ${messageText}`));
    }
    return;
  }

  if (data.startsWith('vibe:tree:page:')) {
    const requestedPage = parsePageFromCallback(data, 'vibe:tree:page:');
    const currentPath = store.getTopicState(chatId, topic, DEV_FILE_TREE_PATH_KEY) ?? '.';
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '正在翻页', 'Paging'));
    try {
      await sendDevFileTree(telegram, store, config, chatId, topic, currentPath, requestedPage);
      await renderVibePanel();
      setDevNavStep(store, chatId, topic, DEV_NAV_STEP.VIBE_TREE);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await renderPanel('dev_vibe', pickLanguageText(language, `文件树翻页失败：${messageText}`, `File tree paging failed: ${messageText}`));
    }
    return;
  }

  if (data === 'menu:home') {
    await renderPanel('home');
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '已返回主菜单', 'Back to main menu'));
    return;
  }

  if (data === 'paper:add') {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '请发送论文信息', 'Please send paper details'));
    await renderPanel(
      'paper',
      pickLanguageText(
        language,
        ['添加论文支持三种方式：', '1) 直接上传 PDF', '2) /paperadd <arXiv链接或编号>', '3) /paperadd <论文标题关键词>（会返回候选按钮）'].join('\n'),
        ['Three ways to add a paper:', '1) Upload a PDF directly', '2) /paperadd <arXiv link or id>', '3) /paperadd <paper title keywords> (returns candidate buttons)'].join('\n')
      )
    );
    setPaperNavStep(store, chatId, topic, PAPER_NAV_STEP.ADD_PROMPT);
    return;
  }

  if (data === 'paper:help') {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '已打开论文帮助', 'Paper help opened'));
    await renderPanel(
      'paper',
      pickLanguageText(
        language,
        ['论文常用命令：', '- /paper', '- /paperorganize', '- /paperbrainstorm <问题>', '- /papermode organize|brainstorm cot|tot|got', '- /paperadd <arXiv链接|编号|标题关键词>', '- /back'].join('\n'),
        ['Paper commands:', '- /paper', '- /paperorganize', '- /paperbrainstorm <question>', '- /papermode organize|brainstorm cot|tot|got', '- /paperadd <arXiv link|id|title keywords>', '- /back'].join('\n')
      )
    );
    setPaperNavStep(store, chatId, topic, PAPER_NAV_STEP.HELP);
    return;
  }

  if (data === 'paper:history' || data.startsWith('paper:history:page:')) {
    const requestedPage = data.startsWith('paper:history:page:') ? parsePageFromCallback(data, 'paper:history:page:') : 0;
    const recent = papers.listRecent(chatId, topic, 30);
    if (recent.length === 0) {
      await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '没有历史论文', 'No paper history'));
      await renderPanel('paper', pickLanguageText(language, '当前没有历史论文，先上传 PDF 或 /paperadd 检索。', 'No history yet. Upload a PDF or use /paperadd first.'));
      return;
    }

    saveCandidates(store, chatId, topic, PAPER_RECENT_RESULTS_KEY, recent);
    const pagination = paginateItems(recent, requestedPage, PAPER_LIST_PAGE_SIZE);
    await telegram.answerCallbackQuery(
      callbackQuery.id,
      data === 'paper:history'
        ? pickLanguageText(language, '已加载历史论文', 'History loaded')
        : pickLanguageText(language, `第 ${pagination.page + 1}/${pagination.totalPages} 页`, `Page ${pagination.page + 1}/${pagination.totalPages}`)
    );
    const lines = pagination.pageItems.map((item, index) => `${pagination.startIndex + index + 1}. ${item.title} (${item.category})`).join('\n');
    await renderPanel(
      'paper',
      pickLanguageText(
        language,
        `历史论文（第 ${pagination.page + 1}/${pagination.totalPages} 页，点击按钮激活）：\n${lines}`,
        `Recent papers (page ${pagination.page + 1}/${pagination.totalPages}, click to activate):\n${lines}`
      ),
      buildRecentPaperKeyboard(recent, language, pagination.page, PAPER_LIST_PAGE_SIZE)
    );
    setPaperNavStep(store, chatId, topic, PAPER_NAV_STEP.HISTORY);
    return;
  }

  if (data.startsWith('paper:pick:page:')) {
    const requestedPage = parsePageFromCallback(data, 'paper:pick:page:');
    const candidates = readCandidates<ArxivCandidate>(store, chatId, topic, PAPER_SEARCH_RESULTS_KEY);
    if (candidates.length === 0) {
      await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '候选已失效，请重新检索', 'Candidates expired, please search again'));
      await renderPanel('paper', pickLanguageText(language, '候选列表已失效，请重新执行 /paperadd。', 'Candidate list expired. Please run /paperadd again.'));
      return;
    }

    const pagination = paginateItems(candidates, requestedPage, 5);
    const lines = pagination.pageItems.map((item, index) => `${pagination.startIndex + index + 1}. ${item.title} (${item.id})`).join('\n');
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, `第 ${pagination.page + 1}/${pagination.totalPages} 页`, `Page ${pagination.page + 1}/${pagination.totalPages}`));
    await renderPanel(
      'paper',
      pickLanguageText(
        language,
        `检索候选（第 ${pagination.page + 1}/${pagination.totalPages} 页，点击按钮导入）：\n${lines}`,
        `Candidates (page ${pagination.page + 1}/${pagination.totalPages}, click to import):\n${lines}`
      ),
      buildArxivPickKeyboard(candidates, language, pagination.page, 5)
    );
    setPaperNavStep(store, chatId, topic, PAPER_NAV_STEP.CANDIDATES);
    return;
  }

  if (data.startsWith('paper:pick:')) {
    const index = Number(data.split(':')[2]);
    const candidates = readCandidates<ArxivCandidate>(store, chatId, topic, PAPER_SEARCH_RESULTS_KEY);
    const selected = Number.isFinite(index) ? candidates[index] : undefined;
    if (!selected) {
      await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '候选已失效，请重新检索', 'Candidates expired, please search again'));
      return;
    }

    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, `正在导入 ${selected.id}`, `Importing ${selected.id}`));
    try {
      const profile = store.getCurrentProfile(chatId, topic);
      const record = await ingestPaperFromArxiv(papers, store, chatId, topic, profile.agent, selected.id, selected.title);
      await renderPanel(
        'paper',
        pickLanguageText(
          language,
          [`论文已入库：${record.title}`, `分类：${record.category}`, `摘要：${record.summary.slice(0, 1000)}`, '可继续提问：/ask 你的问题'].join('\n'),
          [`Paper ingested: ${record.title}`, `Category: ${record.category}`, `Summary: ${record.summary.slice(0, 1000)}`, 'Continue with: /ask <your question>'].join('\n')
        )
      );
      setPaperNavStep(store, chatId, topic, PAPER_NAV_STEP.ACTIVE);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await renderPanel('paper', pickLanguageText(language, `导入候选论文失败：${messageText}`, `Candidate import failed: ${messageText}`));
    }
    return;
  }

  if (data.startsWith('paper:use:')) {
    const index = Number(data.split(':')[2]);
    const recent = readCandidates<PaperRecord>(store, chatId, topic, PAPER_RECENT_RESULTS_KEY);
    const selected = Number.isFinite(index) ? recent[index] : undefined;
    if (!selected?.pdfPath) {
      await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '历史列表已失效，请重试', 'History expired, please retry'));
      return;
    }

    store.setTopicState(chatId, topic, 'active_paper_path', selected.pdfPath);
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '已切换当前论文', 'Current paper switched'));
    await renderPanel(
      'paper',
      pickLanguageText(language, `已切换当前论文：${selected.title}\n可继续使用 /paper 或 /ask 提问。`, `Current paper switched: ${selected.title}\nContinue with /paper or /ask.`)
    );
    setPaperNavStep(store, chatId, topic, PAPER_NAV_STEP.ACTIVE);
    return;
  }

  if (data === 'paper:brainstorm') {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '请发送你的讨论问题', 'Please send your discussion question'));
    const currentMode = getPaperMode(store, chatId, topic, 'brainstorm').toUpperCase();
    await renderPanel(
      'paper',
      pickLanguageText(
        language,
        [`请发送：/paperbrainstorm 你的问题`, `当前头脑风暴模式：${currentMode}`, '可改模式：/papermode brainstorm cot|tot|got'].join('\n'),
        [`Send: /paperbrainstorm <your question>`, `Current brainstorm mode: ${currentMode}`, 'Change mode: /papermode brainstorm cot|tot|got'].join('\n')
      )
    );
    setPaperNavStep(store, chatId, topic, PAPER_NAV_STEP.BRAINSTORM_PROMPT);
    return;
  }

  if (data === 'dev:projects' || data.startsWith('dev:projects:page:')) {
    const requestedPage = data.startsWith('dev:projects:page:') ? parsePageFromCallback(data, 'dev:projects:page:') : 0;
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '正在读取项目列表', 'Loading projects'));
    await renderDevProjectPanel(requestedPage);
    return;
  }

  if (data === 'dev:status') {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '已加载开发状态', 'Development status loaded'));
    const root = getDevWorkspaceRoot(store, config, chatId, topic);
    const current = getDevCurrentProject(store, config, chatId, topic) ?? pickLanguageText(language, '未设置', 'Not set');
    await renderPanel(
      'dev',
      pickLanguageText(language, ['开发模式状态：', `- 工作空间：${root}`, `- 当前项目：${current}`].join('\n'), ['Development mode status:', `- Workspace: ${root}`, `- Current project: ${current}`].join('\n'))
    );
    return;
  }

  if (data === 'dev:create') {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '请输入项目名', 'Please enter project name'));
    await renderPanel(
      'dev',
      pickLanguageText(language, '请发送：/devcreate <项目名>', 'Send: /devcreate <project-name>'),
      buildStepBackKeyboard(language, BACK_CALLBACK.DEV_PROJECTS)
    );
    setDevNavStep(store, chatId, topic, DEV_NAV_STEP.CREATE_PROMPT);
    return;
  }

  if (data === 'dev:clone') {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '请输入仓库地址', 'Please enter repository URL'));
    await renderPanel(
      'dev',
      pickLanguageText(language, '请发送：/devclone <仓库URL> [项目名]', 'Send: /devclone <repo-url> [project-name]'),
      buildStepBackKeyboard(language, BACK_CALLBACK.DEV_PROJECTS)
    );
    setDevNavStep(store, chatId, topic, DEV_NAV_STEP.CLONE_PROMPT);
    return;
  }

  if (data === 'dev:help') {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '已打开开发帮助', 'Development help opened'));
    await renderPanel(
      'dev',
      pickLanguageText(
        language,
        ['开发常用命令：', '- /devworkspace <目录>', '- /devls', '- /devselect <项目名>', '- /devcat <相对路径>', '- /devrun <命令>', '- /devgit <args>', '- /back'].join('\n'),
        ['Development commands:', '- /devworkspace <path>', '- /devls', '- /devselect <project-name>', '- /devcat <relative-path>', '- /devrun <command>', '- /devgit <args>', '- /back'].join('\n')
      )
    );
    return;
  }

  if (data === 'paper:organize') {
    await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '开始整理论文信息', 'Starting paper organization'));
    const currentMode = getPaperMode(store, chatId, topic, 'organize').toUpperCase();
    await renderPanel(
      'paper',
      pickLanguageText(
        language,
        [`请发送：/paperorganize`, `当前整理模式：${currentMode}`, '可改模式：/papermode organize cot|tot|got'].join('\n'),
        [`Send: /paperorganize`, `Current organize mode: ${currentMode}`, 'Change mode: /papermode organize cot|tot|got'].join('\n')
      )
    );
    setPaperNavStep(store, chatId, topic, PAPER_NAV_STEP.ORGANIZE_PROMPT);
    return;
  }

  await telegram.answerCallbackQuery(callbackQuery.id, pickLanguageText(language, '暂未支持该按钮动作', 'This button action is not supported yet'));
}

function isPdf(fileName?: string, mimeType?: string): boolean {
  if (mimeType && /pdf/i.test(mimeType)) {
    return true;
  }
  return !!fileName && /\.pdf$/i.test(fileName);
}

async function sendChunks(telegram: TelegramClient, chatId: number, text: string): Promise<void> {
  const chunkSize = 3500;
  for (let index = 0; index < text.length; index += chunkSize) {
    const chunk = text.slice(index, index + chunkSize);
    await telegram.sendMessage(chatId, chunk);
  }
}

async function handlePdfDocument(
  telegram: TelegramClient,
  store: SessionStore,
  papers: PaperManager,
  message: NonNullable<TelegramUpdate['message']>,
  topic: string,
  agent: string
): Promise<void> {
  const language = getUiLanguage(store, message.chat.id, topic);
  const document = message.document;
  if (!document?.file_id) {
    await sendChunks(
      telegram,
      message.chat.id,
      pickLanguageText(language, '未能识别 PDF 文件信息。', 'Unable to identify PDF file information.')
    );
    return;
  }

  try {
    const info = await telegram.getFile(document.file_id);
    if (!info.file_path) {
      throw new Error('Telegram did not return file_path for document.');
    }

    const bytes = await telegram.downloadFile(info.file_path);
    const record = await papers.ingestPdf({
      chatId: message.chat.id,
      topic,
      originalFileName: document.file_name ?? 'paper.pdf',
      bytes
    });

    store.setTopicState(message.chat.id, topic, 'active_paper_path', record.pdfPath);
    store.append({
      chatId: message.chat.id,
      topic,
      role: 'system',
      agent,
      content: `[paper] title=${record.title}; category=${record.category}; path=${record.pdfPath}`
    });

    await sendChunks(
      telegram,
      message.chat.id,
      pickLanguageText(
        language,
        [
          `论文已入库：${record.title}`,
          `分类：${record.category}`,
          `保存路径：${record.pdfPath}`,
          `摘要：${record.summary.slice(0, 1000)}`,
          '可继续提问：/ask 你的问题'
        ].join('\n'),
        [
          `Paper ingested: ${record.title}`,
          `Category: ${record.category}`,
          `Saved path: ${record.pdfPath}`,
          `Summary: ${record.summary.slice(0, 1000)}`,
          'Continue with: /ask <your question>'
        ].join('\n')
      )
    );
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await sendChunks(telegram, message.chat.id, pickLanguageText(language, `PDF 处理失败：${messageText}`, `PDF processing failed: ${messageText}`));
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const telegram = new TelegramClient(config);
  const store = new SessionStore(config);
  const catalog = new ModelCatalog(config.modelCatalogPath);
  const copilot = new CopilotClient(config);
  const papers = new PaperManager(config);

  await refreshModelCatalogAtStartup(catalog, copilot, config);

  let offset = store.getOffset();

  process.stdout.write('Daemon started: waiting Telegram updates...\n');

  while (true) {
    try {
      const updates = await telegram.getUpdates(offset || undefined);

      for (const update of updates) {
        const callbackQuery = update.callback_query;
        if (callbackQuery?.id) {
          await handleCallbackQuery(telegram, store, catalog, copilot, papers, callbackQuery, config);
          offset = Math.max(offset, update.update_id + 1);
          continue;
        }

        const message = update.message;
        if (!message?.chat?.id) {
          offset = Math.max(offset, update.update_id + 1);
          continue;
        }

        await handleMessage(telegram, store, catalog, copilot, papers, message, config);
        offset = Math.max(offset, update.update_id + 1);
      }

      if (updates.length > 0) {
        store.setOffset(offset);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Daemon loop error: ${message}\n`);
    }

    await sleep(config.pollIntervalMs);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
