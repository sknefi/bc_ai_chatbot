"use strict";

const { ipcMain, safeStorage } = require("electron");
const { settings } = require("./Settings");

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const API_KEY_ENCRYPTED_KEY = "openrouter.apiKeyEncrypted";
const API_KEY_PLAIN_KEY = "openrouter.apiKeyPlain";
const SELECTED_MODEL_KEY = "openrouter.model";

const MODEL_OPTIONS = [
  { id: "openai/gpt-4.1-mini", label: "OpenAI GPT-4.1 Mini", free: false },
  { id: "anthropic/claude-sonnet-4.5", label: "Anthropic Claude Sonnet 4.5", free: false },
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
const RELATED_LINKS_FALLBACK_THRESHOLD = 0.20;
const RELATED_LINKS_FALLBACK_LIMIT = 2;
const CHAT_SYSTEM_PROMPT = [
  "You are an AI assistant inside HARDWARIO Playground focused on HARDWARIO hardware and related application guidance.",
  "When retrieved documentation context is provided, use it as the primary source for HARDWARIO-specific claims and recommendations.",
  "Prefer higher-relevance retrieved chunks over lower-relevance chunks.",
  "If the retrieved context is insufficient, ambiguous, or weak, do not invent details.",
  "For general conceptual questions that are not specifically about HARDWARIO products or documentation, you may answer from general knowledge.",
  "Do not answer HARDWARIO-specific hardware, firmware, connectors, wiring, APIs, product capabilities, or Node-RED questions from generic world knowledge when the retrieved documentation does not support the claim.",
  "For broad beginner questions that are not clearly asking for a specific HARDWARIO product or documented detail, you may give general practical guidance in a clear and helpful way.",
  "Default to a beginner-friendly explanation, but remain technically correct and professional.",
  "For beginners, define uncommon terms briefly and keep explanations clear and concrete.",
  "For advanced users, stay concise and precise, include relevant constraints and caveats, and do not over-explain basics.",
  "Start with the direct answer. Then add a short explanation. Add practical next steps or examples only when they help.",
  "Do not mention retrieval, embeddings, top-k, similarity scores, or documentation-context internals to the user unless the user explicitly asks about them.",
  "If HARDWARIO-specific support is weak, either ask a short clarifying question or give a clearly labeled general answer without pretending it is confirmed by HARDWARIO documentation.",
  "If the user asks a follow-up question that depends on earlier HARDWARIO context, use the retrieved context and recent user conversation context together. Ask for clarification only when the product or intent is still genuinely ambiguous.",
  "If the user wants to buy hardware, wants a product recommendation, or asks which HARDWARIO module they should start with, and the retrieved context identifies a relevant HARDWARIO product, recommend the relevant HARDWARIO product and provide the retrieved store link directly when available.",
  "When you mention a specific HARDWARIO product or module and a retrieved store URL is available for it, write the product or module name as a clickable markdown link to that store URL.",
  "When exact URLs are provided in the retrieved context, use only those exact URLs. Never invent, guess, rewrite, or normalize HARDWARIO store URLs or other resource URLs.",
  "Valid HARDWARIO product store links in this application use the format 'https://www.hardwario.store/p/...'.",
  "Treat the 'Available links' list in the retrieved context as the authoritative set of URLs for the current answer.",
  "If you mention any link related to the question, you must use only exact links from the 'Available links' list in the retrieved context.",
  "If an 'Available links' list is provided in the retrieved context, use only links from that list when you include URLs in the answer.",
  "If no suitable link exists in the 'Available links' list, do not output a URL.",
  "Do not invent store URLs for generic categories, broad product groups, or ambiguous product mentions.",
  "If you mention links for more than one product or module, group the links under the corresponding product or module name.",
  "Never output an unlabeled flat list of links. If you mention more than one product, every store link or resource link must clearly say which product or module it belongs to.",
  "If you mention more than one store link, write them in a form like 'Temperature Tag store: ...' and 'Climate Module store: ...'.",
  "When you mention a link, make the destination clear in the visible text so the user knows where the link leads.",
  "Do not generate your own sections titled Sources, Useful links, or References unless the user explicitly asks for them. The application may render structured sources and links separately.",
  "When relevant, cite the source path and section heading you used.",
  "Use useful links only when they help answer the question or when the user asks for them, and always state which HARDWARIO product or module each link belongs to.",
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

function getRecentUserMessages(messages, limit = 2) {
  const userMessages = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      userMessages.push(messages[index]);
      if (userMessages.length >= limit) {
        break;
      }
    }
  }

  return userMessages.reverse();
}

function getPreviousAssistantMessage(messages) {
  let seenLatestUser = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }

    if (!seenLatestUser) {
      if (message.role === "user") {
        seenLatestUser = true;
      }
      continue;
    }

    if (message.role === "assistant" && typeof message.content === "string" && message.content.trim().length > 0) {
      return message;
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

function selectRetrievedGroups(results) {
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

  return { grouped, selected };
}

function describeLinkDestination(url) {
  const normalized = String(url || "").toLowerCase();

  if (normalized.includes("hardwario.store")) {
    return "HARDWARIO Store";
  }

  if (normalized.includes("sdk.hardwario.com")) {
    return "HARDWARIO SDK";
  }

  if (normalized.includes("github.com")) {
    return "GitHub";
  }

  if (normalized.includes("hackster.io")) {
    return "Hackster";
  }

  if (normalized.includes("docs.hardwario.com")) {
    return "HARDWARIO Docs";
  }

  return "External Link";
}

function formatAppendixLinkLabel(link) {
  const baseLabel = cleanupInlineMarkdown(link.label || link.kind || "Link");
  return `${baseLabel} (${describeLinkDestination(link.url)})`;
}

function formatRetrievedChunk(result, index) {
  const lines = [
    `${index}. Path: ${result.path}`,
    `   Heading: ${result.heading}`,
    `   Score: ${result.score.toFixed(4)}`,
    `   Text: ${result.text}`,
  ];

  return lines.join("\n");
}

function buildAvailableLinks(results) {
  const { selected } = selectRetrievedGroups(results);
  const selectedItems = selected.flatMap((group) => group.items);
  const linksByUrl = new Map();

  for (const item of selectedItems) {
    const title = item.title || item.heading || item.path;
    for (const link of item.relatedLinks || []) {
      if (!link?.url) {
        continue;
      }

      if (!linksByUrl.has(link.url)) {
        linksByUrl.set(link.url, {
          title,
          label: cleanupInlineMarkdown(link.label || link.kind || "Link"),
          destination: describeLinkDestination(link.url),
          url: link.url,
        });
      }
    }
  }

  return Array.from(linksByUrl.values());
}

function buildRetrievalContext(query, retrievalResult) {
  const results = Array.isArray(retrievalResult?.results) ? retrievalResult.results : [];
  const { grouped, selected } = selectRetrievedGroups(results);
  const availableLinks = buildAvailableLinks(results);

  if (selected.length === 0) {
    return "";
  }

  const lines = [
    "Retrieved documentation context for the current user question:",
    `Question: ${query}`,
    `Embedding model: ${retrievalResult.embeddingModel}`,
    "Use High relevance chunks as primary evidence. Use Medium relevance chunks as supporting evidence. Use Low relevance chunks cautiously.",
  ];

  if (grouped.high.length === 0 && grouped.medium.length === 0 && grouped.low.length > 0) {
    lines.push("Only low-confidence supporting chunks were retrieved. Answer cautiously and avoid unsupported HARDWARIO-specific claims.");
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

  if (availableLinks.length > 0) {
    lines.push("");
    lines.push("Available links:");
    for (const link of availableLinks) {
      lines.push(`- ${link.title} | ${link.label} (${link.destination}) | ${link.url}`);
    }
  }

  return lines.join("\n");
}

function buildRetrievalQuery(messages) {
  const recentUserMessages = getRecentUserMessages(messages, 2);
  const latestUserMessage = recentUserMessages[recentUserMessages.length - 1];

  if (!latestUserMessage?.content) {
    return "";
  }

  const lines = [`Current user question: ${latestUserMessage.content}`];
  if (recentUserMessages.length > 1) {
    lines.push(`Previous user question: ${recentUserMessages[0].content}`);
  }

  const latestUserWordCount = latestUserMessage.content.trim().split(/\s+/).filter(Boolean).length;
  if (latestUserWordCount > 0 && latestUserWordCount < 5) {
    const previousAssistantMessage = getPreviousAssistantMessage(messages);
    if (previousAssistantMessage?.content) {
      lines.push(`Previous assistant answer: ${previousAssistantMessage.content}`);
    }
  }

  return lines.join("\n");
}

function buildRelatedLinkGroups(retrievalResult) {
  const results = Array.isArray(retrievalResult?.results) ? retrievalResult.results : [];
  const { selected } = selectRetrievedGroups(results);
  let selectedItems = selected.flatMap((group) => group.items);

  if (selectedItems.length === 0) {
    selectedItems = results
      .filter((item) =>
        item.score >= RELATED_LINKS_FALLBACK_THRESHOLD &&
        Array.isArray(item.relatedLinks) &&
        item.relatedLinks.some((link) => Boolean(link?.url))
      )
      .slice(0, RELATED_LINKS_FALLBACK_LIMIT);
  }

  if (selectedItems.length === 0) {
    return [];
  }

  const linksByTitle = new Map();
  for (const item of selectedItems) {
    const title = item.title || item.heading || item.path;
    if (!linksByTitle.has(title)) {
      linksByTitle.set(title, []);
    }

    const titleLinks = linksByTitle.get(title);
    for (const link of item.relatedLinks || []) {
      if (!link?.url) {
        continue;
      }

      if (titleLinks.some((existing) => existing.url === link.url)) {
        continue;
      }

      titleLinks.push({
        label: formatAppendixLinkLabel(link),
        url: link.url,
      });
    }
  }

  return Array.from(linksByTitle.entries())
    .map(([title, links]) => ({ title, links }))
    .filter((group) => group.links.length > 0);
}

async function buildAugmentedMessages(messages) {
  const latestUserMessage = getLatestUserMessage(messages);
  const retrievalQuery = buildRetrievalQuery(messages);
  const finalMessages = [
    { role: "system", content: CHAT_SYSTEM_PROMPT },
  ];
  let relatedLinkGroups = [];

  if (latestUserMessage?.content && retrievalQuery) {
    try {
      const DocsRetrieval = require("./DocsRetrieval");
      const retrievalResult = await DocsRetrieval.retrieveChunks({
        query: retrievalQuery,
        topK: RETRIEVAL_TOP_K,
      });

      const retrievalContext = buildRetrievalContext(retrievalQuery, retrievalResult);
      if (retrievalContext) {
        finalMessages.push({
          role: "system",
          content: retrievalContext,
        });
      }
      relatedLinkGroups = buildRelatedLinkGroups(retrievalResult);
    } catch (error) {
      console.error("ai-chat: failed to retrieve documentation context", error);
      finalMessages.push({
        role: "system",
        content: "Documentation support for this answer is currently unavailable. Do not mention retrieval internals. If the question is HARDWARIO-specific, avoid unsupported claims; otherwise give a general helpful answer.",
      });
    }
  }

  return {
    messages: finalMessages.concat(messages),
    relatedLinkGroups,
  };
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

async function handleStream({ sender, requestId, apiKey, model, messages, relatedLinkGroups = [] }) {
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

    if (Array.isArray(relatedLinkGroups) && relatedLinkGroups.length > 0) {
      sendSafe(sender, "ai-chat/related-links", { requestId, groups: relatedLinkGroups });
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

  ipcMain.handle("ai-chat/build-prompt-preview", async (_event, payload) => {
    const model = isModelAllowed(payload?.model) ? payload.model : getSelectedModel();
    const messages = normalizeMessages(payload?.messages);

    if (messages.length === 0) {
      throw new Error("Message is empty.");
    }

    const { messages: augmentedMessages, relatedLinkGroups } = await buildAugmentedMessages(messages);

    return {
      model,
      retrievalTopK: RETRIEVAL_TOP_K,
      messages: augmentedMessages,
      relatedLinkGroups,
    };
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
        const { messages: augmentedMessages, relatedLinkGroups } = await buildAugmentedMessages(messages);
        sendSafe(event.sender, "ai-chat/prompt-debug", {
          requestId,
          model,
          retrievalTopK: RETRIEVAL_TOP_K,
          messages: augmentedMessages,
          relatedLinkGroups,
        });
        await handleStream({
          sender: event.sender,
          requestId,
          apiKey,
          model,
          messages: augmentedMessages,
          relatedLinkGroups,
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
