import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AppConfig, ContinueContextResult, SessionMessage, SessionQuery, SessionThread } from './types.js';

export class SessionStore {
  private readonly db: Database.Database;

  constructor(private readonly config: AppConfig) {
    const directory = path.dirname(config.dbPath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        topic TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_lookup
        ON session_messages(chat_id, topic, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_search
        ON session_messages(content);
      CREATE TABLE IF NOT EXISTS bridge_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  append(message: SessionMessage): SessionMessage {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO session_messages (chat_id, topic, role, content, agent, created_at)
      VALUES (@chatId, @topic, @role, @content, @agent, @createdAt)
    `);

    const result = stmt.run({
      ...message,
      createdAt: now
    });

    this.pruneThread(message.chatId, message.topic);
    this.pruneByTime();

    return {
      ...message,
      id: Number(result.lastInsertRowid),
      createdAt: now
    };
  }

  listThreads(chatId?: number): SessionThread[] {
    const sql = chatId
      ? `
          SELECT chat_id as chatId, topic, COUNT(*) as messageCount, MAX(created_at) as updatedAt
          FROM session_messages
          WHERE chat_id = ?
          GROUP BY chat_id, topic
          ORDER BY updatedAt DESC
        `
      : `
          SELECT chat_id as chatId, topic, COUNT(*) as messageCount, MAX(created_at) as updatedAt
          FROM session_messages
          GROUP BY chat_id, topic
          ORDER BY updatedAt DESC
        `;

    const rows = chatId ? this.db.prepare(sql).all(chatId) : this.db.prepare(sql).all();
    return rows as SessionThread[];
  }

  getHistory(query: SessionQuery): SessionMessage[] {
    const limit = query.limit ?? this.config.sessionRetentionMessages;
    const topic = query.topic ?? this.config.defaultTopic;

    const rows = this.db
      .prepare(`
        SELECT id, chat_id as chatId, topic, role, content, agent, created_at as createdAt
        FROM session_messages
        WHERE chat_id = ? AND topic = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(query.chatId, topic, limit) as SessionMessage[];

    return [...rows].reverse();
  }

  search(query: SessionQuery): SessionMessage[] {
    if (!query.keyword) {
      return [];
    }

    const limit = query.limit ?? this.config.sessionRetentionMessages;

    const rows = this.db
      .prepare(`
        SELECT id, chat_id as chatId, topic, role, content, agent, created_at as createdAt
        FROM session_messages
        WHERE chat_id = ? AND content LIKE ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(query.chatId, `%${query.keyword}%`, limit) as SessionMessage[];

    return rows;
  }

  continueContext(chatId: number, topic: string, limit = 20): ContinueContextResult {
    const messages = this.getHistory({ chatId, topic, limit });
    const agent = messages.length > 0 ? messages[messages.length - 1].agent : this.config.defaultAgent;
    const modelId = this.getSelectedModel(chatId, topic);
    const summary = this.summarize(messages);

    return {
      chatId,
      topic,
      agent,
      modelId,
      messages,
      summary
    };
  }

  getCurrentProfile(chatId: number, topic: string): { topic: string; agent: string } {
    const row = this.db
      .prepare(`
        SELECT topic, agent
        FROM session_messages
        WHERE chat_id = ? AND topic = ?
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(chatId, topic) as { topic: string; agent: string } | undefined;

    return row ?? { topic, agent: this.config.defaultAgent };
  }

  close(): void {
    this.db.close();
  }

  getOffset(): number {
    const row = this.db
      .prepare('SELECT value FROM bridge_state WHERE key = ? LIMIT 1')
      .get('telegram_offset') as { value: string } | undefined;

    return row ? Number(row.value) : 0;
  }

  setOffset(offset: number): number {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO bridge_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key)
        DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run('telegram_offset', String(offset), now);

    return offset;
  }

  getSelectedModel(chatId: number, topic: string): string {
    return this.getTopicState(chatId, topic, 'selected_model') ?? this.config.defaultModel;
  }

  setSelectedModel(chatId: number, topic: string, modelId: string): string {
    this.setTopicState(chatId, topic, 'selected_model', modelId);
    return modelId;
  }

  getTopicState(chatId: number, topic: string, key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM bridge_state WHERE key = ? LIMIT 1')
      .get(this.makeTopicKey(chatId, topic, key)) as { value: string } | undefined;

    return row?.value;
  }

  setTopicState(chatId: number, topic: string, key: string, value: string): string {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO bridge_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key)
        DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(this.makeTopicKey(chatId, topic, key), value, now);

    return value;
  }

  private summarize(messages: SessionMessage[]): string {
    if (messages.length === 0) {
      return 'No previous context.';
    }

    const lines = messages
      .slice(-6)
      .map((item) => `${item.role}: ${item.content.replace(/\s+/g, ' ').slice(0, 180)}`);

    return lines.join('\n');
  }

  private pruneThread(chatId: number, topic: string): void {
    const keep = this.config.sessionRetentionMessages;
    this.db
      .prepare(`
        DELETE FROM session_messages
        WHERE id IN (
          SELECT id
          FROM session_messages
          WHERE chat_id = ? AND topic = ?
          ORDER BY created_at DESC
          LIMIT -1 OFFSET ?
        )
      `)
      .run(chatId, topic, keep);
  }

  private pruneByTime(): void {
    const cutoff = Date.now() - this.config.sessionRetentionDays * 24 * 60 * 60 * 1000;
    this.db.prepare('DELETE FROM session_messages WHERE created_at < ?').run(cutoff);
  }

  private makeTopicKey(chatId: number, topic: string, key: string): string {
    return `${key}:${chatId}:${topic}`;
  }
}
