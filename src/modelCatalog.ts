import fs from 'node:fs';
import path from 'node:path';
import { CopilotModelInfo } from './types.js';

const DEFAULT_MODELS: CopilotModelInfo[] = [
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'OpenAI',
    pricing: '按 GitHub Copilot 订阅计划计费；模型单独加价请以官方公告为准。',
    referenceUrl: 'https://github.com/features/copilot'
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'OpenAI',
    pricing: '按 GitHub Copilot 订阅计划计费；模型单独加价请以官方公告为准。',
    referenceUrl: 'https://github.com/features/copilot'
  }
];

export class ModelCatalog {
  private models: CopilotModelInfo[];

  private readonly catalogPath: string;

  constructor(catalogPath: string) {
    this.catalogPath = path.resolve(catalogPath);
    this.models = this.load(this.catalogPath);
  }

  list(): CopilotModelInfo[] {
    return this.models;
  }

  findById(modelId: string): CopilotModelInfo | undefined {
    return this.models.find((item) => item.id === modelId);
  }

  replaceWithModelIds(modelIds: string[]): void {
    const normalizedIds = [...new Set(modelIds.map((item) => item.trim()).filter(Boolean))];
    if (normalizedIds.length === 0) {
      return;
    }

    const existing = new Map(this.models.map((item) => [item.id, item]));
    this.models = normalizedIds.map((id) => {
      const hit = existing.get(id);
      if (hit) {
        return hit;
      }
      return {
        id,
        name: this.toDisplayName(id),
        provider: this.inferProvider(id),
        pricing: '按 GitHub Copilot 订阅计划计费；模型单独加价请以官方公告为准。',
        referenceUrl: 'https://github.com/features/copilot'
      };
    });

    this.persist();
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

  private persist(): void {
    fs.mkdirSync(path.dirname(this.catalogPath), { recursive: true });
    fs.writeFileSync(this.catalogPath, `${JSON.stringify({ models: this.models }, null, 2)}\n`, 'utf8');
  }

  private toDisplayName(modelId: string): string {
    return modelId
      .split(/[-_]/g)
      .filter(Boolean)
      .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
      .join(' ');
  }

  private inferProvider(modelId: string): string {
    const lowered = modelId.toLowerCase();
    if (lowered.startsWith('gpt')) {
      return 'OpenAI';
    }
    if (lowered.startsWith('claude')) {
      return 'Anthropic';
    }
    if (lowered.startsWith('gemini')) {
      return 'Google';
    }
    return 'Unknown';
  }
}
