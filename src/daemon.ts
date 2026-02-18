import { loadConfig } from './config.js';
import { ModelCatalog } from './modelCatalog.js';
import { PaperManager } from './paperManager.js';
import { SessionStore } from './sessionStore.js';
import { TelegramClient } from './telegram.js';
import { parseTelegramText } from './topic.js';
import { TelegramUpdate } from './types.js';

function formatModelList(catalog: ModelCatalog): string {
  const lines = catalog.list().map((item) => `- ${item.id} | ${item.name} | ${item.provider}\n  计费：${item.pricing}`);
  return ['当前可选 Copilot 大模型：', ...lines].join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleMessage(
  telegram: TelegramClient,
  store: SessionStore,
  catalog: ModelCatalog,
  papers: PaperManager,
  message: NonNullable<TelegramUpdate['message']>,
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  const chatId = message.chat.id;
  const profile = store.getCurrentProfile(chatId, config.defaultTopic);
  const selectedModel = store.getSelectedModel(chatId, profile.topic);
  const text = message.text ?? message.caption ?? '';
  const parsed = parseTelegramText(text, config, profile.topic, profile.agent, selectedModel);

  if (message.document && isPdf(message.document.file_name, message.document.mime_type)) {
    await sendChunks(telegram, chatId, '已收到 PDF，正在阅读并分析，请稍候...');
    await handlePdfDocument(telegram, store, papers, message, parsed.topic, parsed.agent);
    return;
  }

  if (parsed.command === 'start') {
    await sendChunks(telegram, chatId, parsed.text);
    return;
  }

  if (parsed.command === 'models') {
    await sendChunks(telegram, chatId, formatModelList(catalog));
    return;
  }

  if (parsed.command === 'model') {
    const model = catalog.findById(parsed.modelId);
    if (!model) {
      await sendChunks(telegram, chatId, `未找到模型：${parsed.modelId}。请先执行 /models 查看可用模型。`);
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

    await sendChunks(telegram, chatId, `已切换模型为 ${parsed.modelId}`);
    return;
  }

  if (parsed.command === 'paper') {
    const paperPath = store.getTopicState(chatId, parsed.topic, 'active_paper_path');
    const paper = paperPath ? papers.getPaperByPath(paperPath) : null;
    if (!paper) {
      await sendChunks(telegram, chatId, '当前话题还没有激活论文。请先发送 PDF 文件。');
      return;
    }

    await sendChunks(
      telegram,
      chatId,
      [`当前论文：${paper.title}`, `分类：${paper.category}`, `摘要：${paper.summary.slice(0, 1200)}`, '提问方式：/ask 你的问题'].join('\n')
    );
    return;
  }

  if (parsed.command === 'ask') {
    const paperPath = store.getTopicState(chatId, parsed.topic, 'active_paper_path');
    const paper = paperPath ? papers.getPaperByPath(paperPath) : null;
    if (!paper) {
      await sendChunks(telegram, chatId, '当前没有可问答的论文，请先发送 PDF。');
      return;
    }

    const answer = papers.answerQuestion(paper, parsed.question ?? '');
    store.append({
      chatId,
      topic: parsed.topic,
      role: 'assistant',
      agent: parsed.agent,
      content: `[paper-qa] ${parsed.question} => ${answer.slice(0, 3000)}`
    });
    await sendChunks(telegram, chatId, answer);
    return;
  }

  if (parsed.command === 'history') {
    const records = parsed.keyword
      ? store.search({ chatId, keyword: parsed.keyword, limit: 8 })
      : store.getHistory({ chatId, topic: parsed.topic, limit: 8 });

    if (records.length === 0) {
      await sendChunks(telegram, chatId, '未找到历史记录。');
      return;
    }

    const preview = records
      .slice(-8)
      .map((item) => `${item.role}: ${item.content.replace(/\s+/g, ' ').slice(0, 120)}`)
      .join('\n');

    await sendChunks(telegram, chatId, `历史记录预览：\n${preview}`);
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

  await sendChunks(
    telegram,
    chatId,
    `已收到消息并写入会话（topic=${parsed.topic}, agent=${parsed.agent}, model=${parsed.modelId}）。\n` +
      '当前为低消耗待机模式：守护进程会持续监听，但不会自动调用 Copilot。\n' +
      '如需让 Copilot 生成回复，请在 VS Code Copilot Chat 中调用 /telegram-copilot-bridge 处理该会话。'
  );
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
  const document = message.document;
  if (!document?.file_id) {
    await sendChunks(telegram, message.chat.id, '未能识别 PDF 文件信息。');
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
      [
        `论文已入库：${record.title}`,
        `分类：${record.category}`,
        `保存路径：${record.pdfPath}`,
        `摘要：${record.summary.slice(0, 1000)}`,
        '可继续提问：/ask 你的问题'
      ].join('\n')
    );
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await sendChunks(telegram, message.chat.id, `PDF 处理失败：${messageText}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const telegram = new TelegramClient(config);
  const store = new SessionStore(config);
  const catalog = new ModelCatalog(config.modelCatalogPath);
  const papers = new PaperManager(config);

  let offset = store.getOffset();

  process.stdout.write('Daemon started: waiting Telegram updates...\n');

  while (true) {
    try {
      const updates = await telegram.getUpdates(offset || undefined);

      for (const update of updates) {
        const message = update.message;
        if (!message?.chat?.id) {
          offset = Math.max(offset, update.update_id + 1);
          continue;
        }

        await handleMessage(telegram, store, catalog, papers, message, config);
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
