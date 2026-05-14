"use strict";

const { app, ipcMain } = require("electron");
const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");
const notifyAll = require("../utils/notifyAll");

const STATUS_TOPIC = "docs-chunking/status";
const SOURCE_ID = "hardwario-docs";
const DEFAULT_REPO_OWNER = "hardwario";
const DEFAULT_REPO_NAME = "docs";
const DEFAULT_BRANCH = "main";
const MAX_CHUNK_CHARS = 1800;

let currentStatus = {
  state: "idle",
  message: "Chunks not built yet.",
  sourceId: SOURCE_ID,
  outputPath: "",
  manifestPath: "",
  totalFiles: 0,
  completedFiles: 0,
  chunkCount: 0,
  treeSha: "",
  startedAt: null,
  finishedAt: null,
  error: "",
  hasChunks: false,
};

let buildPromise = null;

function getRagBasePath() {
  const basePath = path.join(app.getPath("userData"), "rag");
  fs.mkdirSync(basePath, { recursive: true });
  return basePath;
}

function getSourceRootPath() {
  return path.join(getRagBasePath(), "sources", "github", SOURCE_ID);
}

function getSourceManifestPath() {
  return path.join(getSourceRootPath(), "manifest.json");
}

function getRawDocsPath() {
  return path.join(getSourceRootPath(), "raw");
}

function getChunksRootPath() {
  const chunksRoot = path.join(getRagBasePath(), "chunks", SOURCE_ID);
  fs.mkdirSync(chunksRoot, { recursive: true });
  return chunksRoot;
}

function getChunksOutputPath() {
  return path.join(getChunksRootPath(), "chunks.jsonl");
}

function getChunksManifestPath() {
  return path.join(getChunksRootPath(), "manifest.json");
}

function loadJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error("docs-chunking: failed to read json", filePath, error);
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

function isMarkdownFile(filePath) {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}

function countJsonlLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }

  const text = fs.readFileSync(filePath, "utf8").trim();
  return text ? text.split("\n").length : 0;
}

function buildStoredChunksStatus(sourceManifest, chunksManifest) {
  const outputPath = getChunksOutputPath();
  const manifestPath = getChunksManifestPath();
  const storedChunkCount = Number(chunksManifest?.chunkCount || 0) || countJsonlLines(outputPath);

  if (!chunksManifest || !fs.existsSync(outputPath) || storedChunkCount <= 0) {
    return null;
  }

  const treeShaMatches = !sourceManifest?.treeSha || !chunksManifest.treeSha || sourceManifest.treeSha === chunksManifest.treeSha;

  return {
    state: "success",
    message: treeShaMatches
      ? `Chunks ready (${storedChunkCount} chunks).`
      : "Chunks available, but the local docs changed. Rebuild recommended.",
    sourceId: SOURCE_ID,
    outputPath,
    manifestPath,
    totalFiles: Number(chunksManifest.sourceFileCount || 0),
    completedFiles: Number(chunksManifest.sourceFileCount || 0),
    chunkCount: storedChunkCount,
    treeSha: chunksManifest.treeSha || "",
    startedAt: null,
    finishedAt: chunksManifest.generatedAt || null,
    error: "",
    hasChunks: true,
  };
}

function resolveCurrentStatus() {
  const sourceManifest = loadJsonFile(getSourceManifestPath());
  const chunksManifest = loadJsonFile(getChunksManifestPath());
  const storedStatus = buildStoredChunksStatus(sourceManifest, chunksManifest);

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
      : "Chunks not built yet.",
    outputPath: getChunksOutputPath(),
    manifestPath: getChunksManifestPath(),
    totalFiles: 0,
    completedFiles: 0,
    chunkCount: 0,
    treeSha: "",
    finishedAt: null,
    hasChunks: false,
  };
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtmlTags(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function slugify(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function deriveTitleFromPath(filePath) {
  const dirname = path.basename(path.dirname(filePath));
  const baseName = path.basename(filePath, path.extname(filePath));
  const source = baseName.toLowerCase() === "index" && dirname ? dirname : baseName;
  return source
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function extractMarkdownLinks(markdown) {
  const linksByUrl = new Map();
  const register = (url, label) => {
    if (typeof url !== "string") {
      return;
    }

    const trimmedUrl = url.trim();
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      return;
    }

    const nextLabel = normalizeWhitespace(label || trimmedUrl) || trimmedUrl;
    const existing = linksByUrl.get(trimmedUrl);
    if (!existing) {
      linksByUrl.set(trimmedUrl, {
        kind: classifyLink(trimmedUrl, nextLabel),
        label: nextLabel,
        url: trimmedUrl,
      });
      return;
    }

    if (!existing.label || existing.label === existing.url) {
      existing.label = nextLabel;
    }
  };

  const markdownLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let match = null;
  while ((match = markdownLinkRegex.exec(markdown)) !== null) {
    register(match[2], match[1]);
  }

  const htmlLinkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = htmlLinkRegex.exec(markdown)) !== null) {
    register(match[1], stripHtmlTags(match[2]));
  }

  return Array.from(linksByUrl.values()).sort((a, b) => a.url.localeCompare(b.url));
}

function classifyLink(url, label) {
  const normalizedUrl = String(url || "").toLowerCase();
  const normalizedLabel = String(label || "").toLowerCase();
  const haystack = `${normalizedLabel} ${normalizedUrl}`;

  if (/hardwario\.store/.test(normalizedUrl) || /\bstore\b/.test(haystack)) {
    return "store";
  }

  if (/\bschematics?\b/.test(haystack)) {
    return "schematics";
  }

  if (/\bsdk\b|\blibrary\b/.test(haystack)) {
    return "sdk";
  }

  if (/\bdatasheet\b/.test(haystack)) {
    return "datasheet";
  }

  if (/\bfirmware\b/.test(haystack)) {
    return "firmware";
  }

  if (/github\.com/.test(normalizedUrl)) {
    return "github";
  }

  if (/docs\./.test(normalizedUrl) || /\bdocs\b|\bdocumentation\b/.test(normalizedLabel)) {
    return "docs";
  }

  return "other";
}

function normalizeForChunking(markdown) {
  return normalizeWhitespace(
    stripHtmlTags(
      String(markdown || "")
        .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
        .replace(/`{3}([a-zA-Z0-9_-]+)?\n?/g, "\nCode$1\n")
        .replace(/`([^`\n]+)`/g, "$1")
    )
  );
}

function splitMarkdownIntoSections(markdown, fallbackTitle) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  const headingStack = [fallbackTitle];
  let currentSection = {
    heading: fallbackTitle,
    sectionPath: [fallbackTitle],
    lines: [],
  };

  const finalizeCurrentSection = () => {
    const text = normalizeForChunking(currentSection.lines.join("\n"));
    if (!text) {
      return;
    }

    sections.push({
      heading: currentSection.heading,
      sectionPath: [...currentSection.sectionPath],
      text,
    });
  };

  for (const line of lines) {
    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      finalizeCurrentSection();
      const level = headingMatch[1].length;
      const headingText = normalizeWhitespace(headingMatch[2]);
      headingStack.length = Math.max(1, level);
      headingStack[level - 1] = headingText;

      currentSection = {
        heading: headingText,
        sectionPath: headingStack.filter(Boolean),
        lines: [],
      };
      continue;
    }

    currentSection.lines.push(line);
  }

  finalizeCurrentSection();
  return sections;
}

function splitSectionIntoChunks(section) {
  const paragraphs = normalizeWhitespace(section.text)
    .split(/\n\s*\n/g)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return [];
  }

  const chunks = [];
  let currentParagraphs = [];
  let currentLength = 0;

  const flush = () => {
    if (currentParagraphs.length === 0) {
      return;
    }

    chunks.push(currentParagraphs.join("\n\n"));
    currentParagraphs = [];
    currentLength = 0;
  };

  for (const paragraph of paragraphs) {
    const nextLength = currentLength === 0
      ? paragraph.length
      : currentLength + 2 + paragraph.length;

    if (nextLength > MAX_CHUNK_CHARS && currentParagraphs.length > 0) {
      flush();
    }

    if (paragraph.length > MAX_CHUNK_CHARS) {
      flush();
      let start = 0;
      while (start < paragraph.length) {
        chunks.push(paragraph.slice(start, start + MAX_CHUNK_CHARS));
        start += MAX_CHUNK_CHARS;
      }
      continue;
    }

    currentParagraphs.push(paragraph);
    currentLength = currentLength === 0 ? paragraph.length : currentLength + 2 + paragraph.length;
  }

  flush();
  return chunks;
}

function estimateTokenCount(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return 0;
  }

  return Math.ceil(normalized.length / 4);
}

function buildGitHubUrls(sourceManifest, relativePath) {
  const owner = sourceManifest?.owner || DEFAULT_REPO_OWNER;
  const repoName = sourceManifest?.repo || DEFAULT_REPO_NAME;
  const branch = sourceManifest?.branch || DEFAULT_BRANCH;

  return {
    githubBlobUrl: `https://github.com/${owner}/${repoName}/blob/${branch}/${relativePath}`,
  };
}

function buildChunksForFile(file, markdown, sourceManifest) {
  const title = deriveTitleFromPath(file.path);
  const sections = splitMarkdownIntoSections(markdown, title);
  const relatedLinks = extractMarkdownLinks(markdown);
  const githubUrls = buildGitHubUrls(sourceManifest, file.path);
  const fileSha = typeof file.sha === "string" ? file.sha : "";
  const chunks = [];

  for (const section of sections) {
    const chunkTexts = splitSectionIntoChunks(section);
    const headingSlug = slugify(section.heading);

    for (let index = 0; index < chunkTexts.length; index += 1) {
      const chunkText = normalizeWhitespace([
        ...section.sectionPath,
        chunkTexts[index],
      ].filter(Boolean).join("\n\n"));
      const textHash = createHash("sha1").update(chunkText).digest("hex").slice(0, 10);

      chunks.push({
        chunkId: `${SOURCE_ID}:${file.path}:${headingSlug}:${String(index + 1).padStart(4, "0")}:${textHash}`,
        sourceId: SOURCE_ID,
        path: file.path,
        fileSha,
        title,
        sectionPath: [...section.sectionPath],
        heading: section.heading,
        chunkIndex: index + 1,
        tokenEstimate: estimateTokenCount(chunkText),
        text: chunkText,
        ...githubUrls,
        relatedLinks,
      });
    }
  }

  return chunks;
}

async function buildChunks() {
  const sourceManifest = loadJsonFile(getSourceManifestPath());
  if (!sourceManifest) {
    throw new Error("Documentation source manifest not found. Download docs first.");
  }

  const rawDocsPath = getRawDocsPath();
  if (!fs.existsSync(rawDocsPath)) {
    throw new Error("Raw documentation corpus not found. Download docs first.");
  }

  const outputPath = getChunksOutputPath();
  const manifestPath = getChunksManifestPath();
  const chunksRoot = getChunksRootPath();
  const tempRoot = `${chunksRoot}.build`;
  const tempOutputPath = path.join(tempRoot, "chunks.jsonl");
  const tempManifestPath = path.join(tempRoot, "manifest.json");
  const files = Array.isArray(sourceManifest.files)
    ? sourceManifest.files.filter((file) => file && typeof file.path === "string" && isMarkdownFile(file.path))
    : [];

  if (files.length === 0) {
    throw new Error("No markdown files found in the downloaded documentation corpus.");
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });

  publishStatus({
    state: "running",
    message: `Building chunks from ${files.length} markdown files...`,
    sourceId: SOURCE_ID,
    outputPath,
    manifestPath,
    totalFiles: files.length,
    completedFiles: 0,
    chunkCount: 0,
    treeSha: sourceManifest.treeSha || "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: "",
    hasChunks: Boolean(buildStoredChunksStatus(sourceManifest, loadJsonFile(manifestPath))),
  });

  const chunkLines = [];
  let chunkCount = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const sourcePath = path.join(rawDocsPath, file.path);
    const markdown = fs.readFileSync(sourcePath, "utf8");
    const chunks = buildChunksForFile(file, markdown, sourceManifest);

    for (const chunk of chunks) {
      chunkLines.push(JSON.stringify(chunk));
    }

    chunkCount += chunks.length;

    publishStatus({
      message: `Processed ${file.path}`,
      completedFiles: index + 1,
      chunkCount,
    });
  }

  fs.writeFileSync(tempOutputPath, `${chunkLines.join("\n")}\n`, "utf8");

  const chunksManifest = {
    sourceId: SOURCE_ID,
    repo: `${sourceManifest.owner || DEFAULT_REPO_OWNER}/${sourceManifest.repo || DEFAULT_REPO_NAME}`,
    branch: sourceManifest.branch || DEFAULT_BRANCH,
    treeSha: sourceManifest.treeSha || "",
    sourceFileCount: files.length,
    chunkCount,
    chunkerVersion: 1,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(tempManifestPath, JSON.stringify(chunksManifest, null, 2), "utf8");

  fs.rmSync(chunksRoot, { recursive: true, force: true });
  fs.renameSync(tempRoot, chunksRoot);

  publishStatus({
    state: "success",
    message: `Chunks ready (${chunkCount} chunks).`,
    outputPath,
    manifestPath,
    totalFiles: files.length,
    completedFiles: files.length,
    chunkCount,
    finishedAt: chunksManifest.generatedAt,
    error: "",
    hasChunks: true,
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
  ipcMain.handle("docs-chunking/get-status", () => {
    currentStatus = getStatus();
    return currentStatus;
  });

  ipcMain.handle("docs-chunking/build-chunks", async () => {
    if (buildPromise) {
      return currentStatus;
    }

    buildPromise = buildChunks()
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Unknown chunking error.";
        const storedStatus = buildStoredChunksStatus(
          loadJsonFile(getSourceManifestPath()),
          loadJsonFile(getChunksManifestPath())
        );

        publishStatus({
          state: storedStatus ? "success" : "error",
          message: storedStatus ? storedStatus.message : message,
          finishedAt: new Date().toISOString(),
          error: message,
          hasChunks: Boolean(storedStatus),
        });
        return currentStatus;
      })
      .finally(() => {
        buildPromise = null;
      });

    return currentStatus;
  });
}

module.exports = { setup };
