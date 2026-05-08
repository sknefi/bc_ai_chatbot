"use strict";

const { app, ipcMain } = require("electron");
const path = require("path");
const { randomUUID } = require("crypto");
const Database = require("better-sqlite3");

let db = null;

function getDb() {
  if (db) {
    return db;
  }

  const dbPath = path.join(app.getPath("userData"), "ai-chat.sqlite");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id_created_at
      ON messages (conversation_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
      ON conversations (updated_at DESC);
  `);

  return db;
}

function makeConversationRow(row) {
  return {
    id: row.id,
    title: row.title,
    model: row.model || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count || 0),
    lastMessagePreview: row.last_message_preview || "",
  };
}

function makeMessageRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listConversations() {
  const database = getDb();
  const rows = database.prepare(`
    SELECT
      c.id,
      c.title,
      c.model,
      c.created_at,
      c.updated_at,
      COUNT(m.id) AS message_count,
      (
        SELECT content
        FROM messages
        WHERE conversation_id = c.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) AS last_message_preview
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    GROUP BY c.id
    ORDER BY c.updated_at DESC, c.created_at DESC
  `).all();

  return rows.map(makeConversationRow);
}

function getConversationMessages(conversationId) {
  const database = getDb();
  const rows = database.prepare(`
    SELECT id, conversation_id, role, content, created_at, updated_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(conversationId);

  return rows.map(makeMessageRow);
}

function createConversation(input = {}) {
  const database = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const title = typeof input.title === "string" && input.title.trim().length > 0
    ? input.title.trim()
    : "New chat";
  const model = typeof input.model === "string" ? input.model.trim() : "";

  database.prepare(`
    INSERT INTO conversations (id, title, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, title, model, now, now);

  return {
    id,
    title,
    model,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastMessagePreview: "",
  };
}

function deleteConversation(conversationId) {
  const database = getDb();
  const result = database.prepare(`DELETE FROM conversations WHERE id = ?`).run(conversationId);
  return { deleted: result.changes > 0 };
}

function renameConversation(input) {
  const database = getDb();
  const conversationId = typeof input?.conversationId === "string" ? input.conversationId : "";
  const title = typeof input?.title === "string" ? input.title.trim() : "";

  if (!conversationId) {
    throw new Error("Conversation id is required.");
  }

  if (!title) {
    throw new Error("Conversation title cannot be empty.");
  }

  const now = new Date().toISOString();
  const result = database.prepare(`
    UPDATE conversations
    SET title = ?, updated_at = ?
    WHERE id = ?
  `).run(title, now, conversationId);

  if (!result.changes) {
    throw new Error("Conversation not found.");
  }

  return { renamed: true, title, updatedAt: now };
}

function clearConversation(conversationId) {
  const database = getDb();
  const now = new Date().toISOString();
  const clearTx = database.transaction(() => {
    database.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
    database.prepare(`
      UPDATE conversations
      SET title = ?, updated_at = ?
      WHERE id = ?
    `).run("New chat", now, conversationId);
  });

  clearTx();
  return { cleared: true };
}

function addMessage(input) {
  const database = getDb();
  const conversationId = typeof input?.conversationId === "string" ? input.conversationId : "";
  const role = input?.role === "assistant" ? "assistant" : "user";
  const content = typeof input?.content === "string" ? input.content : "";
  const model = typeof input?.model === "string" ? input.model.trim() : "";

  if (!conversationId) {
    throw new Error("Conversation id is required.");
  }

  if (!content.trim()) {
    throw new Error("Message content is required.");
  }

  const existingConversation = database.prepare(`
    SELECT id, title
    FROM conversations
    WHERE id = ?
  `).get(conversationId);

  if (!existingConversation) {
    throw new Error("Conversation not found.");
  }

  const now = new Date().toISOString();
  const messageId = randomUUID();

  const tx = database.transaction(() => {
    database.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(messageId, conversationId, role, content, now, now);

    const updateParams = [now, conversationId];
    let updateSql = `UPDATE conversations SET updated_at = ?`;

    if (role === "user" && existingConversation.title === "New chat") {
      const nextTitle = content.trim().replace(/\s+/g, " ").slice(0, 60) || "New chat";
      updateSql += `, title = ?`;
      updateParams.push(nextTitle);
    }

    if (model) {
      updateSql += `, model = ?`;
      updateParams.push(model);
    }

    updateSql += ` WHERE id = ?`;
    database.prepare(updateSql).run(...updateParams);
  });

  tx();

  return makeMessageRow({
    id: messageId,
    conversation_id: conversationId,
    role,
    content,
    created_at: now,
    updated_at: now,
  });
}

function setup() {
  getDb();

  ipcMain.handle("ai-chat-store/list-conversations", () => listConversations());
  ipcMain.handle("ai-chat-store/create-conversation", (_event, input) => createConversation(input));
  ipcMain.handle("ai-chat-store/delete-conversation", (_event, conversationId) => deleteConversation(conversationId));
  ipcMain.handle("ai-chat-store/rename-conversation", (_event, input) => renameConversation(input));
  ipcMain.handle("ai-chat-store/clear-conversation", (_event, conversationId) => clearConversation(conversationId));
  ipcMain.handle("ai-chat-store/get-messages", (_event, conversationId) => getConversationMessages(conversationId));
  ipcMain.handle("ai-chat-store/add-message", (_event, input) => addMessage(input));
}

module.exports = { setup };
