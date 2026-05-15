"use strict";

const { ipcMain, safeStorage } = require("electron");
const { settings } = require("./Settings");

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const API_KEY_ENCRYPTED_KEY = "openrouter.apiKeyEncrypted";
const API_KEY_PLAIN_KEY = "openrouter.apiKeyPlain";
const SELECTED_MODEL_KEY = "openrouter.model";

const MODEL_OPTIONS = [
  { id: "openai/gpt-4.1-mini", label: "OpenAI GPT-4.1 Mini", free: false },
  { id: "google/gemma-3-27b-it:free", label: "Google Gemma 3 27B (Free)", free: true },
  { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Meta Llama 3.3 70B (Free)", free: true },
  { id: "deepseek/deepseek-chat-v3-0324:free", label: "DeepSeek Chat V3 (Free)", free: true },
];

const DEFAULT_MODEL = MODEL_OPTIONS[0].id;
const activeRequests = new Map();
const RETRIEVAL_TOP_K = 6;
const HIGH_RELEVANCE_THRESHOLD = 0.75;
const MEDIUM_RELEVANCE_THRESHOLD = 0.60;
const LOW_RELEVANCE_THRESHOLD = 0.45;
const LOW_RELEVANCE_FALLBACK_LIMIT = 3;
const CHAT_SYSTEM_PROMPT = [
  "You are assisting with HARDWARIO documentation questions inside HARDWARIO Playground.",
  "When retrieved documentation context is provided, use it as the primary source for HARDWARIO-specific technical claims.",
  "Prefer higher-relevance retrieved chunks over lower-relevance chunks.",
  "If the retrieved context is insufficient or ambiguous, say that clearly instead of inventing details.",
  "Do not invent HARDWARIO product behavior, APIs, firmware details, wiring steps, or Node-RED behavior that are not supported by the retrieved context.",
  "When relevant, cite the source path and section heading you used.",
  "Use useful links only when they are relevant to the answer and come from the retrieved context.",
  "For simple greetings or general conversational messages that do not depend on documentation, you can answer normally.",
].join("\n");

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    function onAbort() {
      cleanup();
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    }

    function cleanup() {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function parseRetryAfterMs(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) {
    return null;
  }

  const seconds = Number(raw);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }

  return null;
}

function parseErrorDetail(errorBody) {
  let detail = errorBody;
  try {
    const parsed = JSON.parse(errorBody);
    detail = parsed?.error?.message || parsed?.message || errorBody;
  } catch (_error) {
    // Keep raw payload if not JSON.
  }

  if (typeof detail !== "string") {
    return "Unknown provider error";
  }

  return detail.trim() || "Unknown provider error";
}

function isModelAllowed(modelId) {
  return MODEL_OPTIONS.some((option) => option.id === modelId);
}

function getSelectedModel() {
  const stored = settings.get(SELECTED_MODEL_KEY);
  if (typeof stored === "string" && isModelAllowed(stored)) {
    return stored;
  }
  return DEFAULT_MODEL;
}

function setSelectedModel(modelId) {
  const resolved = isModelAllowed(modelId) ? modelId : DEFAULT_MODEL;
  settings.set(SELECTED_MODEL_KEY, resolved);
  return resolved;
}

function getApiKey() {
  const encrypted = settings.get(API_KEY_ENCRYPTED_KEY);
  if (typeof encrypted === "string" && encrypted.length > 0 && safeStorage.isEncryptionAvailable()) {
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      if (typeof decrypted === "string" && decrypted.length > 0) {
        return decrypted;
      }
    } catch (error) {
      console.error("ai-chat: failed to decrypt API key", error);
    }
  }

  const plain = settings.get(API_KEY_PLAIN_KEY);
  if (typeof plain === "string" && plain.length > 0) {
    return plain;
  }

  return null;
}

function setApiKey(apiKey) {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(apiKey);
    settings.set(API_KEY_ENCRYPTED_KEY, encrypted.toString("base64"));
    settings.set(API_KEY_PLAIN_KEY, "");
    return { encrypted: true };
  }

  settings.set(API_KEY_ENCRYPTED_KEY, "");
  settings.set(API_KEY_PLAIN_KEY, apiKey);
  return { encrypted: false };
}

function clearApiKey() {
  settings.set(API_KEY_ENCRYPTED_KEY, "");
  settings.set(API_KEY_PLAIN_KEY, "");
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const role = typeof item.role === "string" ? item.role : "";
      const content = typeof item.content === "string" ? item.content : "";
      if ((role === "system" || role === "user" || role === "assistant") && content.trim().length > 0) {
        return { role, content };
      }
      return null;
    })
    .filter(Boolean);
}

function getLatestUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return messages[index];
    }
  }

  return null;
}

function cleanupInlineMarkdown(text) {
  return String(text || "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function groupRetrievedResults(results) {
  const groups = {
    high: [],
    medium: [],
    low: [],
  };

  for (const result of results) {
    if (result.score >= HIGH_RELEVANCE_THRESHOLD) {
      groups.high.push(result);
      continue;
    }

    if (result.score >= MEDIUM_RELEVANCE_THRESHOLD) {
      groups.medium.push(result);
      continue;
    }

    if (result.score >= LOW_RELEVANCE_THRESHOLD) {
      groups.low.push(result);
    }
  }

  return groups;
}

function formatRetrievedChunk(result, index) {
  const lines = [
    `${index}. Path: ${result.path}`,
    `   Heading: ${result.heading}`,
    `   Score: ${result.score.toFixed(4)}`,
    `   Text: ${result.text}`,
  ];

  if (Array.isArray(result.relatedLinks) && result.relatedLinks.length > 0) {
    const links = result.relatedLinks
      .slice(0, 4)
      .map((link) => `${cleanupInlineMarkdown(link.label || link.kind || "Link")}: ${link.url}`)
      .join(" | ");

    if (links) {
      lines.push(`   Useful links: ${links}`);
    }
  }

  return lines.join("\n");
}

function buildRetrievalContext(query, retrievalResult) {
  const results = Array.isArray(retrievalResult?.results) ? retrievalResult.results : [];
  const grouped = groupRetrievedResults(results);
  const selected = [];

  if (grouped.high.length > 0) {
    selected.push({ label: "High relevance", items: grouped.high });
  }

  if (grouped.medium.length > 0) {
    selected.push({ label: "Medium relevance", items: grouped.medium });
  }

  if (selected.length === 0 && grouped.low.length > 0) {
    selected.push({
      label: "Low relevance only",
      items: grouped.low.slice(0, LOW_RELEVANCE_FALLBACK_LIMIT),
    });
  }

  if (selected.length === 0) {
    return [
      "Retrieved documentation context for the current user question:",
      `Question: ${query}`,
      "No sufficiently relevant documentation chunks were retrieved.",
      "If the question requires HARDWARIO-specific documentation, say that the retrieved documentation context is insufficient.",
    ].join("\n");
  }

  const lines = [
    "Retrieved documentation context for the current user question:",
    `Question: ${query}`,
    `Embedding model: ${retrievalResult.embeddingModel}`,
  ];

  if (grouped.high.length === 0 && grouped.medium.length === 0 && grouped.low.length > 0) {
    lines.push("Only low-relevance chunks were retrieved. Answer cautiously and say when documentation support is weak.");
  }

  let resultIndex = 1;
  for (const group of selected) {
    lines.push("");
    lines.push(`${group.label}:`);
    for (const item of group.items) {
      lines.push(formatRetrievedChunk(item, resultIndex));
      resultIndex += 1;
    }
  }

  return lines.join("\n");
}

async function buildAugmentedMessages(messages) {
  const latestUserMessage = getLatestUserMessage(messages);
  const finalMessages = [
    { role: "system", content: CHAT_SYSTEM_PROMPT },
  ];

  if (latestUserMessage?.content) {
    try {
      const DocsRetrieval = require("./DocsRetrieval");
      const retrievalResult = await DocsRetrieval.retrieveChunks({
        query: latestUserMessage.content,
        topK: RETRIEVAL_TOP_K,
      });

      finalMessages.push({
        role: "system",
        content: buildRetrievalContext(latestUserMessage.content, retrievalResult),
      });
    } catch (error) {
      console.error("ai-chat: failed to retrieve documentation context", error);
      finalMessages.push({
        role: "system",
        content: [
          "Retrieved documentation context for the current user question is unavailable.",
          "If the answer depends on HARDWARIO-specific documentation, say that the documentation context is unavailable or insufficient.",
        ].join("\n"),
      });
    }
  }

  return finalMessages.concat(messages);
}

function sendSafe(sender, channel, payload) {
  if (!sender || sender.isDestroyed()) {
    return;
  }

  try {
    sender.send(channel, payload);
  } catch (error) {
    console.error(`ai-chat: failed to send ${channel}`, error);
  }
}

function parseSseChunk(rawChunk, onData) {
  const lines = rawChunk.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const data = line.slice(5).trim();
    if (!data) {
      continue;
    }

    onData(data);
  }
}

async function handleStream({ sender, requestId, apiKey, model, messages }) {
  const controller = new AbortController();
  activeRequests.set(requestId, controller);

  try {
    let response = null;
    let attempt = 0;
    const maxAttempts = 2;

    while (attempt < maxAttempts) {
      attempt += 1;
      response = await fetch(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (response.ok) {
        break;
      }

      const errorBody = await response.text();
      const detail = parseErrorDetail(errorBody);

      if (response.status === 429 && attempt < maxAttempts) {
        const retryAfterMs = parseRetryAfterMs(response.headers);
        const backoffMs = Math.min(Math.max(retryAfterMs ?? 1500, 500), 8000);
        await delay(backoffMs, controller.signal);
        continue;
      }

      if (response.status === 429) {
        throw new Error(
          "OpenRouter rate limit reached for this provider/model. Wait a few seconds and retry, or switch model."
        );
      }

      throw new Error(`OpenRouter request failed (${response.status}): ${detail}`);
    }

    if (!response || !response.ok) {
      throw new Error("OpenRouter request failed.");
    }

    if (!response.body) {
      throw new Error("OpenRouter returned an empty response body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let isDone = false;

    while (!isDone) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        parseSseChunk(chunk, (data) => {
          if (data === "[DONE]") {
            isDone = true;
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              sendSafe(sender, "ai-chat/chunk", { requestId, delta });
            }
          } catch (error) {
            console.error("ai-chat: failed to parse stream chunk", error);
          }
        });

        if (isDone) {
          break;
        }
      }
    }

    if (buffer.length > 0 && !isDone) {
      parseSseChunk(buffer, (data) => {
        if (data === "[DONE]") {
          isDone = true;
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            sendSafe(sender, "ai-chat/chunk", { requestId, delta });
          }
        } catch (error) {
          console.error("ai-chat: failed to parse trailing stream chunk", error);
        }
      });
    }

    sendSafe(sender, "ai-chat/done", { requestId });
  } catch (error) {
    if (controller.signal.aborted) {
      sendSafe(sender, "ai-chat/cancelled", { requestId });
      return;
    }

    const message = error instanceof Error ? error.message : "Unexpected OpenRouter error";
    sendSafe(sender, "ai-chat/error", { requestId, error: message });
  } finally {
    activeRequests.delete(requestId);
  }
}

function setup() {
  ipcMain.handle("ai-chat/get-config", () => {
    return {
      hasApiKey: Boolean(getApiKey()),
      model: getSelectedModel(),
      defaultModel: DEFAULT_MODEL,
      modelOptions: MODEL_OPTIONS,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    };
  });

  ipcMain.handle("ai-chat/set-api-key", (_event, apiKey) => {
    const normalized = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!normalized) {
      throw new Error("API key is required.");
    }

    return setApiKey(normalized);
  });

  ipcMain.handle("ai-chat/clear-api-key", () => {
    clearApiKey();
    return { ok: true };
  });

  ipcMain.handle("ai-chat/set-model", (_event, modelId) => {
    const model = setSelectedModel(typeof modelId === "string" ? modelId : "");
    return { ok: true, model };
  });

  ipcMain.on("ai-chat/send", (event, payload) => {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!requestId) {
      sendSafe(event.sender, "ai-chat/error", {
        requestId: "",
        error: "Missing request id.",
      });
      return;
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      sendSafe(event.sender, "ai-chat/error", {
        requestId,
        error: "OpenRouter API key is not set.",
      });
      return;
    }

    const model = isModelAllowed(payload?.model) ? payload.model : getSelectedModel();
    const messages = normalizeMessages(payload?.messages);
    if (messages.length === 0) {
      sendSafe(event.sender, "ai-chat/error", {
        requestId,
        error: "Message is empty.",
      });
      return;
    }

    const existing = activeRequests.get(requestId);
    if (existing) {
      existing.abort();
      activeRequests.delete(requestId);
    }

    void (async () => {
      try {
        const augmentedMessages = await buildAugmentedMessages(messages);
        await handleStream({
          sender: event.sender,
          requestId,
          apiKey,
          model,
          messages: augmentedMessages,
        });
      } catch (error) {
        console.error("ai-chat: stream handling failed", error);
        sendSafe(event.sender, "ai-chat/error", {
          requestId,
          error: "Failed to process request.",
        });
      }
    })();
  });

  ipcMain.on("ai-chat/cancel", (event, requestId) => {
    if (typeof requestId !== "string" || !requestId) {
      return;
    }

    const controller = activeRequests.get(requestId);
    if (!controller) {
      return;
    }

    controller.abort();
    activeRequests.delete(requestId);
    sendSafe(event.sender, "ai-chat/cancelled", { requestId });
  });
}

module.exports = {
  setup,
  getApiKey,
};
