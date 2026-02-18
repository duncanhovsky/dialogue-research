import fs from 'node:fs';
import path from 'node:path';
import { CopilotModelInfo } from './types.js';

const DEFAULT_MODELS: CopilotModelInfo[] = [
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3-Codex',
    provider: 'OpenAI',
    pricing: '按 GitHub Copilot 订阅计划计费；模型单独加价请以官方公告为准。',
    referenceUrl: 'https://github.com/features/copilot'
  },
  {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    provider: 'Anthropic',
    pricing: '按 GitHub Copilot 订阅计划计费；模型单独加价请以官方公告为准。',
    referenceUrl: 'https://github.com/features/copilot'
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'Google',
    pricing: '按 GitHub Copilot 订阅计划计费；模型单独加价请以官方公告为准。',
    referenceUrl: 'https://github.com/features/copilot'
  }
];

export class ModelCatalog {
  private readonly models: CopilotModelInfo[];

  constructor(catalogPath: string) {
    this.models = this.load(catalogPath);
  }

  list(): CopilotModelInfo[] {
    return this.models;
  }

  findById(modelId: string): CopilotModelInfo | undefined {
    return this.models.find((item) => item.id === modelId);
  }

  private load(catalogPath: string): CopilotModelInfo[] {
    const resolvedPath = path.resolve(catalogPath);
    if (!fs.existsSync(resolvedPath)) {
      return DEFAULT_MODELS;
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const parsed = JSON.parse(content) as { models?: CopilotModelInfo[] };
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) {
      return DEFAULT_MODELS;
    }

    const valid = parsed.models.filter((item) => item.id && item.name && item.provider && item.pricing);
    return valid.length > 0 ? valid : DEFAULT_MODELS;
  }
}
