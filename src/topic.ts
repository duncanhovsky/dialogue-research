import { AppConfig } from './types.js';

const TOPIC_RE = /^\/topic\s+([\w\-]{1,64})$/i;
const AGENT_RE = /^\/agent\s+([\w\-.]{1,64})$/i;
const HISTORY_RE = /^\/history(?:\s+(.+))?$/i;
const MODE_RE = /^\/mode\s+(manual|auto)$/i;
const START_RE = /^\/start(?:@[\w_]+)?$/i;
const MODELS_RE = /^\/models$/i;
const MODEL_RE = /^\/model\s+([\w\-.]{1,64})$/i;
const ASK_RE = /^\/ask\s+(.+)$/i;
const PAPER_RE = /^\/paper(?:\s+(current))?$/i;

export interface ParsedMessage {
  topic: string;
  agent: string;
  modelId: string;
  text: string;
  command?: 'topic' | 'agent' | 'history' | 'mode' | 'start' | 'models' | 'model' | 'ask' | 'paper';
  mode?: 'manual' | 'auto';
  keyword?: string;
  question?: string;
  repoUrl?: string;
}

export function parseTelegramText(
  input: string | undefined,
  config: AppConfig,
  currentTopic?: string,
  currentAgent?: string,
  currentModelId?: string
): ParsedMessage {
  const raw = (input ?? '').trim();
  const topic = currentTopic ?? config.defaultTopic;
  const agent = currentAgent ?? config.defaultAgent;
  const modelId = currentModelId ?? config.defaultModel;

  if (START_RE.test(raw)) {
    return {
      topic,
      agent,
      modelId,
      command: 'start',
      repoUrl: config.githubRepoUrl,
      text: buildWelcomeMessage(config.githubRepoUrl)
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
  if (askMatch) {
    return {
      topic,
      agent,
      modelId,
      command: 'ask',
      question: askMatch[1].trim(),
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

function buildWelcomeMessage(repoUrl: string): string {
  return [
    '欢迎使用 Telegram ↔ VS Code Copilot Bridge Skill。',
    '你可以在 Telegram 中直接与 Copilot 对话，并支持历史续聊、智能体切换、模型选择与 PDF 论文分析。',
    '常用命令：/start /topic /agent /models /model /history /mode /paper /ask',
    `GitHub 仓库：${repoUrl}`
  ].join('\n');
}
