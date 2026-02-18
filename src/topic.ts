import { AppConfig } from './types.js';
import { UiLanguage, normalizeUiLanguage, pickLanguageText } from './i18n.js';

const TOPIC_RE = /^\/topic\s+([\w\-]{1,64})$/i;
const AGENT_RE = /^\/agent\s+([\w\-.]{1,64})$/i;
const HISTORY_RE = /^\/history(?:\s+(.+))?$/i;
const MODE_RE = /^\/mode\s+(manual|auto)$/i;
const START_RE = /^\/start(?:@[\w_]+)?$/i;
const LANGUAGE_RE = /^\/(?:language|lang)(?:\s+(.+))?$/i;
const MENU_RE = /^\/menu$/i;
const MODELS_RE = /^\/models$/i;
const MODELSYNC_RE = /^\/modelsync$/i;
const MODEL_RE = /^\/model\s+([\w\-.]{1,64})$/i;
const ASKM_RE = /^\/askm\s+([\w\-.]{1,64})\s+(.+)$/i;
const ASK_RE = /^\/ask(?:\s+--model\s+([\w\-.]{1,64}))?\s+(.+)$/i;
const PAPER_RE = /^\/paper(?:\s+(current))?$/i;
const PAPERHELP_RE = /^\/paperhelp$/i;
const PAPERADD_RE = /^\/paperadd\s+(.+)$/i;
const PAPERLIST_RE = /^\/paperlist$/i;
const PAPERORGANIZE_RE = /^\/paperorganize(?:\s+(cot|tot|got))?$/i;
const PAPERBRAINSTORM_RE = /^\/paperbrainstorm(?:\s+--mode\s+(cot|tot|got))?\s+(.+)$/i;
const PAPERMODE_RE = /^\/papermode\s+(organize|brainstorm)\s+(cot|tot|got)$/i;
const DEVWORKSPACE_RE = /^\/devworkspace\s+(.+)$/i;
const DEVPROJECTS_RE = /^\/devprojects$/i;
const DEVCREATE_RE = /^\/devcreate\s+([\w\-.]{1,80})$/i;
const DEVSELECT_RE = /^\/devselect\s+([\w\-.]{1,80})$/i;
const DEVCLONE_RE = /^\/devclone\s+(https?:\/\/\S+)(?:\s+([\w\-.]{1,80}))?$/i;
const DEVSTATUS_RE = /^\/devstatus$/i;
const DEVHELP_RE = /^\/devhelp$/i;
const DEVLS_RE = /^\/devls(?:\s+(.+))?$/i;
const DEVCAT_RE = /^\/devcat\s+(.+)$/i;
const DEVRUN_RE = /^\/devrun\s+(.+)$/i;
const DEVGIT_RE = /^\/devgit(?:\s+(status|branch|log))?$/i;

export type ThinkingMode = 'cot' | 'tot' | 'got';

export interface ParsedMessage {
  topic: string;
  agent: string;
  modelId: string;
  text: string;
  command?:
    | 'topic'
    | 'agent'
    | 'history'
    | 'mode'
    | 'start'
    | 'language'
    | 'menu'
    | 'models'
    | 'modelsync'
    | 'model'
    | 'ask'
    | 'paper'
    | 'paperhelp'
    | 'paperadd'
    | 'paperlist'
    | 'paperorganize'
    | 'paperbrainstorm'
    | 'papermode'
    | 'devworkspace'
    | 'devprojects'
    | 'devcreate'
    | 'devselect'
    | 'devclone'
    | 'devstatus'
    | 'devhelp'
    | 'devls'
    | 'devcat'
    | 'devrun'
    | 'devgit';
  mode?: 'manual' | 'auto';
  keyword?: string;
  languageInput?: string;
  question?: string;
  askModelId?: string;
  paperInput?: string;
  thinkingMode?: ThinkingMode;
  paperTarget?: 'organize' | 'brainstorm';
  brainstormQuestion?: string;
  workspacePath?: string;
  projectName?: string;
  repoUrl?: string;
  cloneName?: string;
  relativePath?: string;
  shellCommand?: string;
  gitAction?: 'status' | 'branch' | 'log';
}

export function parseTelegramText(
  input: string | undefined,
  config: AppConfig,
  currentTopic?: string,
  currentAgent?: string,
  currentModelId?: string,
  currentLanguage?: UiLanguage
): ParsedMessage {
  const raw = (input ?? '').trim();
  const topic = currentTopic ?? config.defaultTopic;
  const agent = currentAgent ?? config.defaultAgent;
  const modelId = currentModelId ?? config.defaultModel;
  const language = normalizeUiLanguage(currentLanguage, 'zh');

  if (START_RE.test(raw)) {
    return {
      topic,
      agent,
      modelId,
      command: 'start',
      repoUrl: config.githubRepoUrl,
      text: buildWelcomeMessage(config.githubRepoUrl, config.devWorkspaceRoot, language)
    };
  }

  const languageMatch = raw.match(LANGUAGE_RE);
  if (languageMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'language',
      languageInput: languageMatch[1]?.trim(),
      text: 'Language config requested'
    };
  }

  if (MENU_RE.test(raw)) {
    return {
      topic,
      agent,
      modelId,
      command: 'menu',
      text: 'Main menu requested'
    };
  }

  if (MODELS_RE.test(raw)) {
    return {
      topic,
      agent,
      modelId,
      command: 'models',
      text: 'Model list requested'
    };
  }

  if (MODELSYNC_RE.test(raw)) {
    return {
      topic,
      agent,
      modelId,
      command: 'modelsync',
      text: 'Model sync requested'
    };
  }

  const modelMatch = raw.match(MODEL_RE);
  if (modelMatch) {
    return {
      topic,
      agent,
      modelId: modelMatch[1],
      command: 'model',
      text: `Model changed to ${modelMatch[1]}`
    };
  }

  const askMatch = raw.match(ASK_RE);
  const askmMatch = raw.match(ASKM_RE);
  if (askmMatch) {
    const askModelId = askmMatch[1]?.trim();
    const question = askmMatch[2]?.trim() ?? '';
    return {
      topic,
      agent,
      modelId: askModelId || modelId,
      command: 'ask',
      question,
      askModelId,
      text: 'Paper question requested'
    };
  }

  if (askMatch) {
    const askModelId = askMatch[1]?.trim();
    const question = askMatch[2]?.trim() ?? '';
    return {
      topic,
      agent,
      modelId: askModelId || modelId,
      command: 'ask',
      question,
      askModelId,
      text: 'Paper question requested'
    };
  }

  if (PAPER_RE.test(raw)) {
    return {
      topic,
      agent,
      modelId,
      command: 'paper',
      text: 'Paper status requested'
    };
  }

  if (PAPERHELP_RE.test(raw)) {
    return {
      topic,
      agent,
      modelId,
      command: 'paperhelp',
      text: 'Paper help requested'
    };
  }

  const paperAddMatch = raw.match(PAPERADD_RE);
  if (paperAddMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'paperadd',
      paperInput: paperAddMatch[1].trim(),
      text: 'Paper add requested'
    };
  }

  if (PAPERLIST_RE.test(raw)) {
    return {
      topic,
      agent,
      modelId,
      command: 'paperlist',
      text: 'Paper list requested'
    };
  }

  const paperOrganizeMatch = raw.match(PAPERORGANIZE_RE);
  if (paperOrganizeMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'paperorganize',
      thinkingMode: (paperOrganizeMatch[1]?.toLowerCase() as ThinkingMode | undefined) ?? undefined,
      text: 'Paper organize requested'
    };
  }

  const paperBrainstormMatch = raw.match(PAPERBRAINSTORM_RE);
  if (paperBrainstormMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'paperbrainstorm',
      thinkingMode: (paperBrainstormMatch[1]?.toLowerCase() as ThinkingMode | undefined) ?? undefined,
      brainstormQuestion: paperBrainstormMatch[2].trim(),
      text: 'Paper brainstorm requested'
    };
  }

  const paperModeMatch = raw.match(PAPERMODE_RE);
  if (paperModeMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'papermode',
      paperTarget: paperModeMatch[1].toLowerCase() as 'organize' | 'brainstorm',
      thinkingMode: paperModeMatch[2].toLowerCase() as ThinkingMode,
      text: 'Paper mode config requested'
    };
  }

  const devWorkspaceMatch = raw.match(DEVWORKSPACE_RE);
  if (devWorkspaceMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'devworkspace',
      workspacePath: devWorkspaceMatch[1].trim(),
      text: 'Dev workspace set requested'
    };
  }

  if (DEVPROJECTS_RE.test(raw)) {
    return {
      topic,
      agent,
      modelId,
      command: 'devprojects',
      text: 'Dev projects list requested'
    };
  }

  const devCreateMatch = raw.match(DEVCREATE_RE);
  if (devCreateMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'devcreate',
      projectName: devCreateMatch[1],
      text: 'Dev create project requested'
    };
  }

  const devSelectMatch = raw.match(DEVSELECT_RE);
  if (devSelectMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'devselect',
      projectName: devSelectMatch[1],
      text: 'Dev select project requested'
    };
  }

  const devCloneMatch = raw.match(DEVCLONE_RE);
  if (devCloneMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'devclone',
      repoUrl: devCloneMatch[1],
      cloneName: devCloneMatch[2]?.trim(),
      text: 'Dev clone project requested'
    };
  }

  if (DEVSTATUS_RE.test(raw)) {
    return {
      topic,
      agent,
      modelId,
      command: 'devstatus',
      text: 'Dev status requested'
    };
  }

  if (DEVHELP_RE.test(raw)) {
    return {
      topic,
      agent,
      modelId,
      command: 'devhelp',
      text: 'Dev help requested'
    };
  }

  const devLsMatch = raw.match(DEVLS_RE);
  if (devLsMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'devls',
      relativePath: devLsMatch[1]?.trim(),
      text: 'Dev list files requested'
    };
  }

  const devCatMatch = raw.match(DEVCAT_RE);
  if (devCatMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'devcat',
      relativePath: devCatMatch[1].trim(),
      text: 'Dev read file requested'
    };
  }

  const devRunMatch = raw.match(DEVRUN_RE);
  if (devRunMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'devrun',
      shellCommand: devRunMatch[1].trim(),
      text: 'Dev run command requested'
    };
  }

  const devGitMatch = raw.match(DEVGIT_RE);
  if (devGitMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'devgit',
      gitAction: (devGitMatch[1]?.toLowerCase() as 'status' | 'branch' | 'log' | undefined) ?? 'status',
      text: 'Dev git action requested'
    };
  }

  const topicMatch = raw.match(TOPIC_RE);
  if (topicMatch) {
    return { topic: topicMatch[1], agent, modelId, text: `Topic changed to ${topicMatch[1]}`, command: 'topic' };
  }

  const agentMatch = raw.match(AGENT_RE);
  if (agentMatch) {
    return { topic, agent: agentMatch[1], modelId, text: `Agent changed to ${agentMatch[1]}`, command: 'agent' };
  }

  const historyMatch = raw.match(HISTORY_RE);
  if (historyMatch) {
    const keyword = (historyMatch[1] ?? '').trim();
    return { topic, agent, modelId, text: 'History query', command: 'history', keyword };
  }

  const modeMatch = raw.match(MODE_RE);
  if (modeMatch) {
    return {
      topic,
      agent,
      modelId,
      text: `Reply mode changed to ${modeMatch[1].toLowerCase()}`,
      command: 'mode',
      mode: modeMatch[1].toLowerCase() as 'manual' | 'auto'
    };
  }

  return { topic, agent, modelId, text: raw };
}

function buildWelcomeMessage(repoUrl: string, devWorkspaceRoot: string, language: UiLanguage): string {
  return pickLanguageText(
    language,
    [
      '欢迎使用 Dialogue-Research。',
      'Dialogue-Research = 对话式科研（论文研究 + 开发协作）。',
      '你可以在 Telegram 中直接与 Copilot 对话，并支持历史续聊、智能体切换与模型选择。',
      `首次建议先配置开发工作空间：/devworkspace ${devWorkspaceRoot}`,
      '语言设置：/language zh 或 /language en（简写：/lang zh|en）',
      '全局命令：/start /menu /topic /agent /models /modelsync /model /history /mode /language',
      '模式命令请使用：/paperhelp 和 /devhelp（进入对应模式后也会自动提示）。',
      `GitHub 仓库：${repoUrl}`
    ].join('\n'),
    [
      'Welcome to Dialogue-Research.',
      'Dialogue-Research = conversational research for papers and development workflows.',
      'You can chat with Copilot in Telegram with history continuation, agent/model selection, and guided mode workflows.',
      `Recommended first step: /devworkspace ${devWorkspaceRoot}`,
      'Language setting: /language zh or /language en (short: /lang zh|en)',
      'Global commands: /start /menu /topic /agent /models /modelsync /model /history /mode /language',
      'Mode-specific guides: /paperhelp and /devhelp (also shown after entering each mode).',
      `GitHub repo: ${repoUrl}`
    ].join('\n')
  );
}
