import fs from 'node:fs';
import path from 'node:path';
import pdf from 'pdf-parse';
import { AppConfig } from './types.js';

export interface PaperRecord {
  id: string;
  chatId: number;
  topic: string;
  title: string;
  category: string;
  pdfPath: string;
  textPath: string;
  summary: string;
  createdAt: number;
}

const CATEGORY_RULES: Array<{ category: string; keywords: string[] }> = [
  { category: 'NLP', keywords: ['language model', 'nlp', 'token', 'prompt', 'translation', 'bert', 'llm'] },
  { category: 'CV', keywords: ['image', 'vision', 'segmentation', 'detection', 'video', 'diffusion'] },
  { category: 'Systems', keywords: ['distributed', 'throughput', 'latency', 'scheduler', 'cluster', 'network'] },
  { category: 'Theory', keywords: ['theorem', 'lemma', 'proof', 'complexity', 'bound', 'optimization'] },
  { category: 'Bio', keywords: ['protein', 'genome', 'clinical', 'biomedical', 'cell', 'drug'] },
  { category: 'AI-ML', keywords: ['machine learning', 'neural', 'transformer', 'reinforcement', 'gradient'] }
];

export class PaperManager {
  private readonly cacheDir: string;

  private readonly dbDir: string;

  constructor(private readonly config: AppConfig) {
    this.cacheDir = path.resolve(config.paperCacheDir);
    this.dbDir = path.resolve(config.paperDbDir);

    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(this.dbDir, { recursive: true });
  }

  async ingestPdf(params: {
    chatId: number;
    topic: string;
    originalFileName: string;
    bytes: Buffer;
  }): Promise<PaperRecord> {
    const now = Date.now();
    const cacheName = `${now}-${this.safeFileName(params.originalFileName || 'paper.pdf')}`;
    const cachePath = path.join(this.cacheDir, cacheName);
    fs.writeFileSync(cachePath, params.bytes);

    const parsed = await pdf(params.bytes);
    const text = (parsed.text ?? '').replace(/\u0000/g, '').trim();
    const title = this.extractTitle(text, params.originalFileName);
    const category = this.classify(text);
    const summary = this.summarize(text);

    const categoryDir = path.join(this.dbDir, category);
    fs.mkdirSync(categoryDir, { recursive: true });

    const baseName = this.uniqueBaseName(categoryDir, this.safeFileName(title));
    const pdfPath = path.join(categoryDir, `${baseName}.pdf`);
    const textPath = path.join(categoryDir, `${baseName}.txt`);
    const metadataPath = path.join(categoryDir, `${baseName}.json`);

    fs.copyFileSync(cachePath, pdfPath);
    fs.writeFileSync(textPath, text, 'utf8');

    const record: PaperRecord = {
      id: `${params.chatId}-${params.topic}-${now}`,
      chatId: params.chatId,
      topic: params.topic,
      title,
      category,
      pdfPath,
      textPath,
      summary,
      createdAt: now
    };

    fs.writeFileSync(metadataPath, JSON.stringify(record, null, 2), 'utf8');
    this.appendIndex(record);

    return record;
  }

  getPaperByPath(paperPath: string): PaperRecord | null {
    if (!paperPath) {
      return null;
    }

    const metadataPath = paperPath.endsWith('.pdf') ? paperPath.replace(/\.pdf$/i, '.json') : `${paperPath}.json`;
    if (!fs.existsSync(metadataPath)) {
      return null;
    }

    try {
      return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as PaperRecord;
    } catch {
      return null;
    }
  }

  listRecent(chatId: number, topic: string, limit = 8): PaperRecord[] {
    const index = this.readIndex();
    return index.filter((item) => item.chatId === chatId && item.topic === topic).slice(0, limit);
  }

  listRecentAll(chatId: number, limit = 8): PaperRecord[] {
    const index = this.readIndex();
    return index.filter((item) => item.chatId === chatId).slice(0, limit);
  }

  answerQuestion(record: PaperRecord, question: string): string {
    if (!fs.existsSync(record.textPath)) {
      return '未找到论文文本内容，无法回答。';
    }

    const text = fs.readFileSync(record.textPath, 'utf8');
    const snippets = this.retrieveSnippets(text, question, 5);
    if (snippets.length === 0) {
      return `未在《${record.title}》中检索到与你问题直接相关的段落。`;
    }

    return [
      `基于《${record.title}》的检索结果：`,
      ...snippets.map((line, idx) => `${idx + 1}. ${line}`),
      '提示：这是基于文本检索的答案，如需更深入推理可在 Copilot Chat 中继续分析。'
    ].join('\n');
  }

  buildCopilotQaContext(record: PaperRecord, question: string): string {
    if (!fs.existsSync(record.textPath)) {
      return [
        `论文标题：${record.title}`,
        `分类：${record.category}`,
        '未找到论文文本内容文件，请基于已有摘要谨慎回答。',
        `摘要：${record.summary}`,
        `用户问题：${question}`
      ].join('\n');
    }

    const text = fs.readFileSync(record.textPath, 'utf8');
    const snippets = this.retrieveSnippets(text, question, 8);

    const lines = [
      `论文标题：${record.title}`,
      `分类：${record.category}`,
      `摘要：${record.summary}`,
      `用户问题：${question}`,
      '候选证据段落（按相关度排序）：'
    ];

    if (snippets.length === 0) {
      lines.push('1. 未检索到与问题直接匹配的段落，请结合论文整体内容谨慎推理，并明确不确定性。');
    } else {
      for (let index = 0; index < snippets.length; index += 1) {
        lines.push(`${index + 1}. ${snippets[index]}`);
      }
    }

    return lines.join('\n');
  }

  private appendIndex(record: PaperRecord): void {
    const indexPath = path.join(this.dbDir, 'index.json');
    const current = fs.existsSync(indexPath)
      ? (JSON.parse(fs.readFileSync(indexPath, 'utf8')) as PaperRecord[])
      : [];

    current.unshift(record);
    fs.writeFileSync(indexPath, JSON.stringify(current.slice(0, 500), null, 2), 'utf8');
  }

  private readIndex(): PaperRecord[] {
    const indexPath = path.join(this.dbDir, 'index.json');
    if (!fs.existsSync(indexPath)) {
      return [];
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as PaperRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private retrieveSnippets(text: string, question: string, limit: number): string[] {
    const terms = question
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1);

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 20 && line.length < 300);

    const scored = lines
      .map((line) => {
        const lower = line.toLowerCase();
        const score = terms.reduce((acc, term) => acc + (lower.includes(term) ? 1 : 0), 0);
        return { line, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.line);

    return scored;
  }

  private extractTitle(text: string, fileName: string): string {
    const candidates = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 6 && line.length < 160)
      .slice(0, 20);

    const title = candidates.find((line) => !/^arxiv|^doi|^https?:\/\//i.test(line));
    if (title) {
      return title.replace(/\s+/g, ' ').trim();
    }

    return (fileName || 'untitled-paper.pdf').replace(/\.pdf$/i, '');
  }

  private summarize(text: string): string {
    const abstractIndex = text.toLowerCase().indexOf('abstract');
    if (abstractIndex >= 0) {
      const start = Math.max(0, abstractIndex);
      return text.slice(start, start + 1000).replace(/\s+/g, ' ').trim();
    }

    return text.slice(0, 900).replace(/\s+/g, ' ').trim();
  }

  private classify(text: string): string {
    const lower = text.toLowerCase();

    let bestCategory = 'Other';
    let bestScore = 0;
    for (const rule of CATEGORY_RULES) {
      const score = rule.keywords.reduce((acc, keyword) => acc + (lower.includes(keyword) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        bestCategory = rule.category;
      }
    }

    return bestCategory;
  }

  private safeFileName(input: string): string {
    const cleaned = input
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) {
      return 'paper';
    }

    return cleaned.slice(0, 100);
  }

  private uniqueBaseName(directory: string, base: string): string {
    const normalized = base.replace(/\.pdf$/i, '').trim() || 'paper';
    let candidate = normalized;
    let count = 1;

    while (fs.existsSync(path.join(directory, `${candidate}.pdf`))) {
      count += 1;
      candidate = `${normalized}-${count}`;
    }

    return candidate;
  }
}
