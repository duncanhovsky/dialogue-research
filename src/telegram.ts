import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';
import { AppConfig, TelegramFileInfo, TelegramUpdate } from './types.js';

const execFileAsync = promisify(execFile);

const updatesSchema = z.object({
  ok: z.boolean(),
  result: z.array(z.any())
});

const sendSchema = z.object({
  ok: z.boolean(),
  result: z.object({
    message_id: z.number()
  })
});

const getFileSchema = z.object({
  ok: z.boolean(),
  result: z.object({
    file_id: z.string(),
    file_unique_id: z.string(),
    file_size: z.number().optional(),
    file_path: z.string().optional()
  })
});

export class TelegramClient {
  private readonly proxyDispatcher: Dispatcher | undefined;

  private readonly noProxyList: string[];

  constructor(private readonly config: AppConfig) {
    const protocol = new URL(config.telegramApiBase).protocol;
    this.noProxyList = (config.noProxy ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    const proxy = this.selectProxyForProtocol(protocol);
    this.proxyDispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  }

  private endpoint(method: string): string {
    return `${this.config.telegramApiBase}/bot${this.config.telegramBotToken}/${method}`;
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const payload: Record<string, unknown> = {
      timeout: this.config.pollTimeoutSeconds,
      allowed_updates: ['message']
    };
    if (typeof offset === 'number') {
      payload.offset = offset;
    }

    const json = await this.postWithFallback('getUpdates', payload);
    const parsed = updatesSchema.parse(json);
    if (!parsed.ok) {
      throw new Error('Telegram getUpdates returned ok=false');
    }

    return parsed.result as TelegramUpdate[];
  }

  async sendMessage(chatId: number, text: string): Promise<number> {
    const json = await this.postWithFallback('sendMessage', {
      chat_id: chatId,
      text
    });
    const parsed = sendSchema.parse(json);
    if (!parsed.ok) {
      throw new Error('Telegram sendMessage returned ok=false');
    }

    return parsed.result.message_id;
  }

  async getFile(fileId: string): Promise<TelegramFileInfo> {
    const json = await this.postWithFallback('getFile', { file_id: fileId });
    const parsed = getFileSchema.parse(json);
    if (!parsed.ok) {
      throw new Error('Telegram getFile returned ok=false');
    }

    return parsed.result;
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const url = `${this.config.telegramApiBase}/file/bot${this.config.telegramBotToken}/${filePath}`;

    try {
      const response = await undiciFetch(url, {
        method: 'GET',
        dispatcher: this.shouldBypassProxy(url) ? undefined : this.proxyDispatcher
      });
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch {
      return this.downloadViaPowerShell(url);
    }
  }

  private async postWithFallback(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const url = this.endpoint(method);

    try {
      const response = await undiciFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        dispatcher: this.shouldBypassProxy(url) ? undefined : this.proxyDispatcher
      });

      if (!response.ok) {
        throw new Error(`Telegram ${method} failed: ${response.status}`);
      }

      return response.json();
    } catch {
      return this.postViaPowerShell(url, payload);
    }
  }

  private async postViaPowerShell(url: string, payload: Record<string, unknown>): Promise<unknown> {
    const bodyBase64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const escapedUrl = url.replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$url = '${escapedUrl}'`,
      `$bodyBase64 = '${bodyBase64}'`,
      '$body = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($bodyBase64))',
      "$resp = Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body $body",
      "$resp | ConvertTo-Json -Depth 20 -Compress"
    ].join('; ');

    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });

    return JSON.parse(stdout.trim());
  }

  private async downloadViaPowerShell(url: string): Promise<Buffer> {
    const escapedUrl = url.replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$url = '${escapedUrl}'`,
      '$tmp = [System.IO.Path]::GetTempFileName()',
      'Invoke-WebRequest -Uri $url -OutFile $tmp',
      '$bytes = [System.IO.File]::ReadAllBytes($tmp)',
      'Remove-Item $tmp -Force',
      '[System.Convert]::ToBase64String($bytes)'
    ].join('; ');

    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024
    });

    return Buffer.from(stdout.trim(), 'base64');
  }

  private selectProxyForProtocol(protocol: string): string | undefined {
    if (protocol === 'https:') {
      return this.config.httpsProxy ?? this.config.httpProxy;
    }
    return this.config.httpProxy;
  }

  private shouldBypassProxy(url: string): boolean {
    if (this.noProxyList.length === 0) {
      return false;
    }

    const hostname = new URL(url).hostname.toLowerCase();
    return this.noProxyList.some((rule) => {
      if (rule === '*') {
        return true;
      }
      if (rule.startsWith('.')) {
        return hostname.endsWith(rule) || hostname === rule.slice(1);
      }
      return hostname === rule || hostname.endsWith(`.${rule}`);
    });
  }
}
