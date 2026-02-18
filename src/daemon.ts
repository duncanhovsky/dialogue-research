import { loadConfig } from './config.js';
import { ModelCatalog } from './modelCatalog.js';
import { SessionStore } from './sessionStore.js';
import { TelegramClient } from './telegram.js';
import { parseTelegramText } from './topic.js';

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
  chatId: number,
  text: string,
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  const profile = store.getCurrentProfile(chatId, config.defaultTopic);
  const selectedModel = store.getSelectedModel(chatId, profile.topic);
  const parsed = parseTelegramText(text, config, profile.topic, profile.agent, selectedModel);

  if (parsed.command === 'start') {
    await telegram.sendMessage(chatId, parsed.text);
    return;
  }

  if (parsed.command === 'models') {
    await telegram.sendMessage(chatId, formatModelList(catalog));
    return;
  }

  if (parsed.command === 'model') {
    const model = catalog.findById(parsed.modelId);
    if (!model) {
      await telegram.sendMessage(chatId, `未找到模型：${parsed.modelId}。请先执行 /models 查看可用模型。`);
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

    await telegram.sendMessage(chatId, `已切换模型为 ${parsed.modelId}`);
    return;
  }

  if (parsed.command === 'history') {
    const records = parsed.keyword
      ? store.search({ chatId, keyword: parsed.keyword, limit: 8 })
      : store.getHistory({ chatId, topic: parsed.topic, limit: 8 });

    if (records.length === 0) {
      await telegram.sendMessage(chatId, '未找到历史记录。');
      return;
    }

    const preview = records
      .slice(-8)
      .map((item) => `${item.role}: ${item.content.replace(/\s+/g, ' ').slice(0, 120)}`)
      .join('\n');

    await telegram.sendMessage(chatId, `历史记录预览：\n${preview}`);
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

    await telegram.sendMessage(chatId, parsed.text);
    return;
  }

  store.append({
    chatId,
    topic: parsed.topic,
    role: 'user',
    agent: parsed.agent,
    content: parsed.text
  });

  await telegram.sendMessage(
    chatId,
    `已收到消息并写入会话（topic=${parsed.topic}, agent=${parsed.agent}, model=${parsed.modelId}）。\n` +
      '当前为低消耗待机模式：守护进程会持续监听，但不会自动调用 Copilot。\n' +
      '如需让 Copilot 生成回复，请在 VS Code Copilot Chat 中调用 /telegram-copilot-bridge 处理该会话。'
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const telegram = new TelegramClient(config);
  const store = new SessionStore(config);
  const catalog = new ModelCatalog(config.modelCatalogPath);

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

        await handleMessage(telegram, store, catalog, message.chat.id, message.text ?? '', config);
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
