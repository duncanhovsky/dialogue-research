import fs from 'node:fs';
import path from 'node:path';
import { fetch as undiciFetch } from 'undici';
import { AppConfig } from './types.js';

interface ChatCompletionsResponse {
  id?: string;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface GenerateReplyParams {
  modelId: string;
  topic: string;
  agent: string;
  userInput: string;
  contextSummary: string;
  extraContext?: string;
}

interface UsageLogRecord {
  timestamp: string;
  modelId: string;
  topic: string;
  agent: string;
  status: 'success' | 'failure';
  attempt: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  requestId?: string;
  error?: string;
}

export class CopilotClient {
  private readonly endpoint: string;

  private readonly apiKey: string;

  private readonly apiKeySource: 'copilot_api_key' | 'github_token' | 'none';

  private readonly maxRetries: number;

  private readonly retryBaseMs: number;

  private readonly timeoutMs: number;

  private readonly maxTotalWaitMs: number;

  private readonly usageLogPath: string;

  private readonly priceInputPer1M: number;

  private readonly priceOutputPer1M: number;

  constructor(private readonly config: AppConfig) {
    this.endpoint = process.env.COPILOT_CHAT_COMPLETIONS_URL ?? 'https://models.inference.ai.azure.com/chat/completions';
    const copilotApiKey = process.env.COPILOT_API_KEY;
    const githubToken = process.env.GITHUB_TOKEN;
    if (copilotApiKey) {
      this.apiKey = copilotApiKey;
      this.apiKeySource = 'copilot_api_key';
    } else if (githubToken) {
      this.apiKey = githubToken;
      this.apiKeySource = 'github_token';
    } else {
      this.apiKey = '';
      this.apiKeySource = 'none';
    }
    this.maxRetries = this.asNumber('COPILOT_MAX_RETRIES', 3, 1, 8);
    this.retryBaseMs = this.asNumber('COPILOT_RETRY_BASE_MS', 400, 100, 10000);
    this.timeoutMs = this.asNumber('COPILOT_TIMEOUT_MS', 25000, 1000, 180000);
    this.maxTotalWaitMs = this.asNumber('COPILOT_MAX_TOTAL_WAIT_MS', 70000, 5000, 300000);
    this.usageLogPath = process.env.COPILOT_USAGE_LOG_PATH ?? './data/copilot-usage.log';
    this.priceInputPer1M = this.asNumber('COPILOT_PRICE_INPUT_PER_1M', 0, 0, 1000);
    this.priceOutputPer1M = this.asNumber('COPILOT_PRICE_OUTPUT_PER_1M', 0, 0, 1000);

    const logDir = path.dirname(this.usageLogPath);
    fs.mkdirSync(logDir, { recursive: true });
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  async discoverAvailableChatModelIds(seedIds: string[]): Promise<string[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const commonCandidates = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-5'];
    const fromModelsEndpoint = await this.fetchModelIdsFromEndpoint();
    const endpointDerived = fromModelsEndpoint
      .map((id) => this.extractShortId(id))
      .filter((id): id is string => Boolean(id));

    const candidateIds = [...new Set([...seedIds, ...commonCandidates, ...endpointDerived].map((item) => item.trim()))]
      .filter(Boolean)
      .slice(0, 20);

    const available: string[] = [];
    for (const modelId of candidateIds) {
      if (await this.canCompleteWithModel(modelId)) {
        available.push(modelId);
      }
    }

    return available;
  }

  async generateReply(params: GenerateReplyParams): Promise<string> {
    if (!this.isEnabled()) {
      throw new Error('COPILOT_API_KEY or GITHUB_TOKEN is required for auto Copilot replies.');
    }

    const system = [
      '你是 Telegram Copilot 助手。',
      `当前 topic: ${params.topic}`,
      `当前 agent: ${params.agent}`,
      '回答要求：',
      '- 优先基于提供的上下文与证据回答；',
      '- 如果证据不足，明确说明不确定；',
      '- 输出简洁、直接，适合 Telegram 阅读。'
    ].join('\n');

    const user = [
      `会话摘要:\n${params.contextSummary || '无'}`,
      params.extraContext ? `补充上下文:\n${params.extraContext}` : '',
      `用户输入:\n${params.userInput}`
    ]
      .filter(Boolean)
      .join('\n\n');

    const modelId = params.modelId || this.config.defaultModel;
    const startedAt = Date.now();
    let lastError = 'unknown error';

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      const elapsedBeforeAttempt = Date.now() - startedAt;
      const remainingBudget = this.maxTotalWaitMs - elapsedBeforeAttempt;
      if (remainingBudget <= 1500) {
        lastError = `request timeout budget exceeded (${this.maxTotalWaitMs}ms)`;
        break;
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, remainingBudget));

        const response = await undiciFetch(this.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: modelId,
            temperature: 0.2,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user }
            ]
          }),
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
          const body = await response.text();
          const maybeFatal = this.asNonRetryableAuthError(response.status, body);
          if (maybeFatal) {
            throw maybeFatal;
          }
          const maybeRequestFatal = this.asNonRetryableRequestError(response.status, body, modelId);
          if (maybeRequestFatal) {
            throw maybeRequestFatal;
          }
          throw new Error(`Copilot completion failed: ${response.status} ${body}`);
        }

        const json = (await response.json()) as ChatCompletionsResponse;
        const text = json.choices?.[0]?.message?.content?.trim();
        if (!text) {
          throw new Error('Copilot completion returned empty content.');
        }

        const usage = this.resolveUsage(json, `${system}\n\n${user}`, text);
        this.writeUsageLog({
          timestamp: new Date().toISOString(),
          modelId,
          topic: params.topic,
          agent: params.agent,
          status: 'success',
          attempt,
          latencyMs: Date.now() - startedAt,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          estimatedCostUsd: this.estimateCostUsd(usage.promptTokens, usage.completionTokens),
          requestId: json.id
        });

        return text;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (error instanceof Error && /缺少 models 权限|non-retryable/i.test(error.message)) {
          break;
        }
        if (attempt >= this.maxRetries) {
          break;
        }
        const nextBackoff = this.retryBaseMs * 2 ** (attempt - 1);
        const elapsedAfterAttempt = Date.now() - startedAt;
        if (elapsedAfterAttempt + nextBackoff >= this.maxTotalWaitMs) {
          break;
        }
        await this.sleep(nextBackoff);
      }
    }

    this.writeUsageLog({
      timestamp: new Date().toISOString(),
      modelId,
      topic: params.topic,
      agent: params.agent,
      status: 'failure',
      attempt: this.maxRetries,
      latencyMs: Date.now() - startedAt,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      error: lastError
    });

    throw new Error(`Copilot generation failed after ${this.maxRetries} attempts: ${lastError}`);
  }

  private resolveUsage(response: ChatCompletionsResponse, prompt: string, completion: string): {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } {
    const promptTokens = response.usage?.prompt_tokens ?? this.estimateTokens(prompt);
    const completionTokens = response.usage?.completion_tokens ?? this.estimateTokens(completion);
    const totalTokens = response.usage?.total_tokens ?? promptTokens + completionTokens;
    return { promptTokens, completionTokens, totalTokens };
  }

  private estimateTokens(text: string): number {
    const trimmed = text.trim();
    if (!trimmed) {
      return 0;
    }
    return Math.max(1, Math.ceil(trimmed.length / 4));
  }

  private estimateCostUsd(promptTokens: number, completionTokens: number): number {
    const inputCost = (promptTokens / 1_000_000) * this.priceInputPer1M;
    const outputCost = (completionTokens / 1_000_000) * this.priceOutputPer1M;
    return Number((inputCost + outputCost).toFixed(8));
  }

  private writeUsageLog(record: UsageLogRecord): void {
    fs.appendFileSync(this.usageLogPath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  private async fetchModelIdsFromEndpoint(): Promise<string[]> {
    const modelsEndpoint = this.getModelsEndpoint();
    if (!modelsEndpoint) {
      return [];
    }

    try {
      const response = await undiciFetch(modelsEndpoint, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.apiKey}`
        }
      });

      if (!response.ok) {
        return [];
      }

      const json = (await response.json()) as { data?: Array<{ id?: string }> } | Array<{ id?: string }>;
      if (Array.isArray(json)) {
        return json.map((item) => item?.id ?? '').filter(Boolean);
      }
      return (json.data ?? []).map((item) => item?.id ?? '').filter(Boolean);
    } catch {
      return [];
    }
  }

  private async canCompleteWithModel(modelId: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 12000));
    try {
      const response = await undiciFetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: modelId,
          temperature: 0,
          max_tokens: 4,
          messages: [{ role: 'user', content: 'ping' }]
        }),
        signal: controller.signal
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private getModelsEndpoint(): string | null {
    const trimmed = this.endpoint.replace(/\/+$/, '');
    const suffix = '/chat/completions';
    if (!trimmed.toLowerCase().endsWith(suffix)) {
      return null;
    }
    return `${trimmed.slice(0, -suffix.length)}/models`;
  }

  private extractShortId(rawId: string): string | null {
    if (!rawId) {
      return null;
    }
    if (/^[a-z0-9][a-z0-9._-]*$/i.test(rawId)) {
      return rawId;
    }

    const match = rawId.match(/\/models\/([^/]+)\/versions\//i);
    if (!match?.[1]) {
      return null;
    }

    const candidate = decodeURIComponent(match[1]);
    if (/^[a-z0-9][a-z0-9._-]*$/i.test(candidate)) {
      return candidate;
    }
    return null;
  }

  private asNonRetryableAuthError(status: number, body: string): Error | null {
    if (status !== 401 && status !== 403) {
      return null;
    }

    const lowered = body.toLowerCase();
    if (lowered.includes('models') && lowered.includes('permission')) {
      const tokenHint =
        this.apiKeySource === 'github_token'
          ? '当前使用的是 GITHUB_TOKEN，请为该 Token 开启 models 读取权限。'
          : this.apiKeySource === 'copilot_api_key'
            ? '当前使用的是 COPILOT_API_KEY，请确认该 Key 具备访问模型接口权限。'
            : '请先配置有权限的 COPILOT_API_KEY 或 GITHUB_TOKEN。';

      return new Error(
        [
          'Copilot completion failed: 缺少 models 权限。',
          tokenHint,
          '也可以改用具备权限的端点：设置 COPILOT_CHAT_COMPLETIONS_URL 后重启 daemon。'
        ].join(' ')
      );
    }

    return null;
  }

  private asNonRetryableRequestError(status: number, body: string, modelId: string): Error | null {
    const lowered = body.toLowerCase();

    if (status === 400 || status === 404 || status === 422) {
      if (lowered.includes('unknown_model') || lowered.includes('unknown model')) {
        return new Error(`Copilot completion non-retryable: unknown model ${modelId}`);
      }
      if (lowered.includes('invalid_request') || lowered.includes('invalid request')) {
        return new Error('Copilot completion non-retryable: invalid request');
      }
      if (lowered.includes('context_length') || lowered.includes('max context')) {
        return new Error('Copilot completion non-retryable: context length exceeded');
      }
    }

    return null;
  }

  private asNumber(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name];
    if (!raw) {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      throw new Error(`${name} must be a finite number in [${min}, ${max}], got: ${raw}`);
    }
    return parsed;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
