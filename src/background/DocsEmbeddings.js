"use strict";

const { app, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const notifyAll = require("../utils/notifyAll");
const { getApiKey } = require("./AIChat");

const STATUS_TOPIC = "docs-embeddings/status";
const SOURCE_ID = "hardwario-docs";
const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const BATCH_SIZE = 16;

let currentStatus = {
  state: "idle",
  message: "Embeddings not built yet.",
  sourceId: SOURCE_ID,
  outputPath: "",
  manifestPath: "",
  totalChunks: 0,
  completedChunks: 0,
  embeddingCount: 0,
  embeddingModel: EMBEDDING_MODEL,
  startedAt: null,
  finishedAt: null,
  error: "",
  hasEmbeddings: false,
};

let buildPromise = null;

function getRagBasePath() {
  const basePath = path.join(app.getPath("userData"), "rag");
  fs.mkdirSync(basePath, { recursive: true });
  return basePath;
}

function getChunksRootPath() {
  return path.join(getRagBasePath(), "chunks", SOURCE_ID);
}

function getChunksOutputPath() {
  return path.join(getChunksRootPath(), "chunks.jsonl");
}

function getChunksManifestPath() {
  return path.join(getChunksRootPath(), "manifest.json");
}

function getIndexRootPath() {
  const indexRoot = path.join(getRagBasePath(), "index", SOURCE_ID);
  fs.mkdirSync(indexRoot, { recursive: true });
  return indexRoot;
}

function getEmbeddingsOutputPath() {
  return path.join(getIndexRootPath(), "embeddings.jsonl");
}

function getEmbeddingsManifestPath() {
  return path.join(getIndexRootPath(), "manifest.json");
}

function loadJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error("docs-embeddings: failed to read json", filePath, error);
    return null;
  }
}

function publishStatus(nextStatusPatch) {
  currentStatus = {
    ...currentStatus,
    ...nextStatusPatch,
  };
  notifyAll(STATUS_TOPIC, currentStatus);
}

function countJsonlLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }

  const text = fs.readFileSync(filePath, "utf8").trim();
  return text ? text.split("\n").length : 0;
}

function buildStoredEmbeddingsStatus(chunksManifest, embeddingsManifest) {
  const outputPath = getEmbeddingsOutputPath();
  const manifestPath = getEmbeddingsManifestPath();
  const storedEmbeddingCount = Number(embeddingsManifest?.embeddingCount || 0) || countJsonlLines(outputPath);

  if (!embeddingsManifest || !fs.existsSync(outputPath) || storedEmbeddingCount <= 0) {
    return null;
  }

  const chunkCountMatches = !chunksManifest?.chunkCount || !embeddingsManifest.chunkCount || chunksManifest.chunkCount === embeddingsManifest.chunkCount;

  return {
    state: "success",
    message: chunkCountMatches
      ? `Embeddings ready (${storedEmbeddingCount} vectors).`
      : "Embeddings available, but the chunk set changed. Rebuild recommended.",
    sourceId: SOURCE_ID,
    outputPath,
    manifestPath,
    totalChunks: Number(embeddingsManifest.chunkCount || 0),
    completedChunks: Number(embeddingsManifest.chunkCount || 0),
    embeddingCount: storedEmbeddingCount,
    embeddingModel: embeddingsManifest.embeddingModel || EMBEDDING_MODEL,
    startedAt: null,
    finishedAt: embeddingsManifest.generatedAt || null,
    error: "",
    hasEmbeddings: true,
  };
}

function resolveCurrentStatus() {
  const chunksManifest = loadJsonFile(getChunksManifestPath());
  const embeddingsManifest = loadJsonFile(getEmbeddingsManifestPath());
  const storedStatus = buildStoredEmbeddingsStatus(chunksManifest, embeddingsManifest);

  if (storedStatus) {
    return {
      ...storedStatus,
      startedAt: currentStatus.startedAt,
      error: currentStatus.state === "error" ? currentStatus.error : "",
    };
  }

  return {
    ...currentStatus,
    state: currentStatus.state === "error" ? "error" : "idle",
    message: currentStatus.state === "error" && currentStatus.error
      ? currentStatus.error
      : "Embeddings not built yet.",
    outputPath: getEmbeddingsOutputPath(),
    manifestPath: getEmbeddingsManifestPath(),
    totalChunks: 0,
    completedChunks: 0,
    embeddingCount: 0,
    embeddingModel: EMBEDDING_MODEL,
    startedAt: null,
    finishedAt: null,
    error: currentStatus.state === "error" ? currentStatus.error : "",
    hasEmbeddings: false,
  };
}

function hasStoredEmbeddings() {
  return Boolean(
    buildStoredEmbeddingsStatus(
      loadJsonFile(getChunksManifestPath()),
      loadJsonFile(getEmbeddingsManifestPath())
    )
  );
}

function clearEmbeddings() {
  fs.rmSync(getIndexRootPath(), { recursive: true, force: true });
  currentStatus = resolveCurrentStatus();
  notifyAll(STATUS_TOPIC, currentStatus);
}

function getHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
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
    // Keep raw payload.
  }

  return typeof detail === "string" && detail.trim()
    ? detail.trim()
    : "Unknown provider error";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadChunks() {
  const chunksPath = getChunksOutputPath();
  if (!fs.existsSync(chunksPath)) {
    throw new Error("Chunks not found. Build chunks first.");
  }

  const text = fs.readFileSync(chunksPath, "utf8").trim();
  if (!text) {
    throw new Error("Chunk file is empty. Build chunks first.");
  }

  return text
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((chunk) => chunk && typeof chunk.chunkId === "string" && typeof chunk.text === "string" && chunk.text.trim());
}

async function requestEmbeddings(apiKey, inputs) {
  let attempt = 0;
  const maxAttempts = 2;

  while (attempt < maxAttempts) {
    attempt += 1;
    const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: "POST",
      headers: getHeaders(apiKey),
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: inputs,
        encoding_format: "float",
        input_type: "search_document",
      }),
    });

    if (response.ok) {
      return response.json();
    }

    const errorBody = await response.text();
    const detail = parseErrorDetail(errorBody);

    if (response.status === 429 && attempt < maxAttempts) {
      const retryAfterMs = parseRetryAfterMs(response.headers);
      const backoffMs = Math.min(Math.max(retryAfterMs ?? 1500, 500), 8000);
      await delay(backoffMs);
      continue;
    }

    throw new Error(`OpenRouter embeddings request failed (${response.status}): ${detail}`);
  }

  throw new Error("OpenRouter embeddings request failed.");
}

async function buildEmbeddings() {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("OpenRouter API key not set. Add your API key first.");
  }

  const chunks = loadChunks();
  const chunksManifest = loadJsonFile(getChunksManifestPath());
  const outputPath = getEmbeddingsOutputPath();
  const manifestPath = getEmbeddingsManifestPath();
  const indexRoot = getIndexRootPath();
  const tempRoot = `${indexRoot}.build`;
  const tempOutputPath = path.join(tempRoot, "embeddings.jsonl");
  const tempManifestPath = path.join(tempRoot, "manifest.json");

  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });

  publishStatus({
    state: "running",
    message: `Generating embeddings for ${chunks.length} chunks...`,
    sourceId: SOURCE_ID,
    outputPath,
    manifestPath,
    totalChunks: chunks.length,
    completedChunks: 0,
    embeddingCount: 0,
    embeddingModel: EMBEDDING_MODEL,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: "",
    hasEmbeddings: hasStoredEmbeddings(),
  });

  const lines = [];
  let dimensions = 0;

  for (let index = 0; index < chunks.length; index += BATCH_SIZE) {
    const batch = chunks.slice(index, index + BATCH_SIZE);
    const inputs = batch.map((chunk) => chunk.text);
    const response = await requestEmbeddings(apiKey, inputs);
    const items = Array.isArray(response?.data) ? response.data : [];

    if (items.length !== batch.length) {
      throw new Error("Embedding response size did not match the requested batch size.");
    }

    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      const vector = items[batchIndex]?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error("Embedding response did not include a valid vector.");
      }

      dimensions = dimensions || vector.length;
      lines.push(JSON.stringify({
        chunkId: batch[batchIndex].chunkId,
        vector,
      }));
    }

    publishStatus({
      message: `Embedded ${Math.min(index + batch.length, chunks.length)} of ${chunks.length} chunks...`,
      completedChunks: Math.min(index + batch.length, chunks.length),
      embeddingCount: lines.length,
    });
  }

  fs.writeFileSync(tempOutputPath, `${lines.join("\n")}\n`, "utf8");

  const manifest = {
    sourceId: SOURCE_ID,
    chunkCount: chunks.length,
    embeddingCount: lines.length,
    embeddingModel: EMBEDDING_MODEL,
    dimensions,
    generatedAt: new Date().toISOString(),
    chunksGeneratedAt: chunksManifest?.generatedAt || null,
  };

  fs.writeFileSync(tempManifestPath, JSON.stringify(manifest, null, 2), "utf8");

  fs.rmSync(indexRoot, { recursive: true, force: true });
  fs.renameSync(tempRoot, indexRoot);

  publishStatus({
    state: "success",
    message: `Embeddings ready (${lines.length} vectors).`,
    outputPath,
    manifestPath,
    totalChunks: chunks.length,
    completedChunks: chunks.length,
    embeddingCount: lines.length,
    embeddingModel: EMBEDDING_MODEL,
    finishedAt: manifest.generatedAt,
    error: "",
    hasEmbeddings: true,
  });

  return currentStatus;
}

function getStatus() {
  if (currentStatus.state === "running") {
    return currentStatus;
  }

  return resolveCurrentStatus();
}

function setup() {
  ipcMain.handle("docs-embeddings/get-status", () => {
    currentStatus = getStatus();
    return currentStatus;
  });

  ipcMain.handle("docs-embeddings/build-embeddings", async () => {
    if (buildPromise) {
      return currentStatus;
    }

    buildPromise = buildEmbeddings()
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Unknown embedding build error.";
        const storedStatus = buildStoredEmbeddingsStatus(
          loadJsonFile(getChunksManifestPath()),
          loadJsonFile(getEmbeddingsManifestPath())
        );

        publishStatus({
          state: storedStatus ? "success" : "error",
          message: storedStatus ? storedStatus.message : message,
          finishedAt: new Date().toISOString(),
          error: message,
          hasEmbeddings: Boolean(storedStatus),
        });
        return currentStatus;
      })
      .finally(() => {
        buildPromise = null;
      });

    return currentStatus;
  });
}

module.exports = {
  setup,
  buildEmbeddings,
  clearEmbeddings,
  hasStoredEmbeddings,
  getStatus,
};
