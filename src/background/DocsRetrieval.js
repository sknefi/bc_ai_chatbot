"use strict";

const { app, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { getApiKey } = require("./AIChat");

const SOURCE_ID = "hardwario-docs";
const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 20;

function getRagBasePath() {
  return path.join(app.getPath("userData"), "rag");
}

function getChunksPath() {
  return path.join(getRagBasePath(), "chunks", SOURCE_ID, "chunks.jsonl");
}

function getEmbeddingsPath() {
  return path.join(getRagBasePath(), "index", SOURCE_ID, "embeddings.jsonl");
}

function getEmbeddingsManifestPath() {
  return path.join(getRagBasePath(), "index", SOURCE_ID, "manifest.json");
}

function loadJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error("docs-retrieval: failed to read json", filePath, error);
    return null;
  }
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

async function requestQueryEmbedding(apiKey, model, query) {
  let attempt = 0;
  const maxAttempts = 2;

  while (attempt < maxAttempts) {
    attempt += 1;
    const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: query,
        encoding_format: "float",
        input_type: "search_query",
      }),
    });

    if (response.ok) {
      const payload = await response.json();
      const vector = payload?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error("Embedding response did not include a valid query vector.");
      }
      return vector;
    }

    const errorBody = await response.text();
    const detail = parseErrorDetail(errorBody);

    if (response.status === 429 && attempt < maxAttempts) {
      const retryAfterMs = parseRetryAfterMs(response.headers);
      const backoffMs = Math.min(Math.max(retryAfterMs ?? 1500, 500), 8000);
      await delay(backoffMs);
      continue;
    }

    throw new Error(`OpenRouter query embedding failed (${response.status}): ${detail}`);
  }

  throw new Error("OpenRouter query embedding failed.");
}

function loadChunks() {
  const chunksPath = getChunksPath();
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
    .filter((chunk) => chunk && typeof chunk.chunkId === "string");
}

function loadEmbeddings() {
  const embeddingsPath = getEmbeddingsPath();
  if (!fs.existsSync(embeddingsPath)) {
    throw new Error("Embeddings not found. Build embeddings first.");
  }

  const text = fs.readFileSync(embeddingsPath, "utf8").trim();
  if (!text) {
    throw new Error("Embeddings file is empty. Build embeddings first.");
  }

  return text
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((row) => row && typeof row.chunkId === "string" && Array.isArray(row.vector));
}

function dotProduct(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    sum += a[index] * b[index];
  }
  return sum;
}

function magnitude(vector) {
  return Math.sqrt(dotProduct(vector, vector));
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return -1;
  }

  const denom = magnitude(a) * magnitude(b);
  if (!denom) {
    return -1;
  }

  return dotProduct(a, b) / denom;
}

async function retrieveChunks(input) {
  const query = typeof input?.query === "string" ? input.query.trim() : "";
  const requestedTopK = Number(input?.topK || DEFAULT_TOP_K);
  const topK = Number.isFinite(requestedTopK)
    ? Math.min(Math.max(Math.round(requestedTopK), 1), MAX_TOP_K)
    : DEFAULT_TOP_K;

  if (!query) {
    throw new Error("Query is required.");
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("OpenRouter API key not set. Add your API key first.");
  }

  const manifest = loadJsonFile(getEmbeddingsManifestPath());
  const embeddingModel = manifest?.embeddingModel || DEFAULT_EMBEDDING_MODEL;
  const chunks = loadChunks();
  const embeddings = loadEmbeddings();
  const embeddingsByChunkId = new Map(embeddings.map((row) => [row.chunkId, row.vector]));
  const queryVector = await requestQueryEmbedding(apiKey, embeddingModel, query);

  const results = chunks
    .map((chunk) => {
      const vector = embeddingsByChunkId.get(chunk.chunkId);
      const score = cosineSimilarity(queryVector, vector);
      return score > -1
        ? {
            chunkId: chunk.chunkId,
            path: chunk.path,
            title: chunk.title,
            heading: chunk.heading,
            sectionPath: Array.isArray(chunk.sectionPath) ? chunk.sectionPath : [],
            text: chunk.text,
            tokenEstimate: chunk.tokenEstimate,
            githubBlobUrl: chunk.githubBlobUrl || "",
            relatedLinks: Array.isArray(chunk.relatedLinks) ? chunk.relatedLinks : [],
            score,
          }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    query,
    topK,
    embeddingModel,
    resultCount: results.length,
    results,
  };
}

function setup() {
  ipcMain.handle("docs-retrieval/retrieve-chunks", (_event, input) => retrieveChunks(input));
}

module.exports = {
  setup,
  retrieveChunks,
};
