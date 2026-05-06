"use strict";

const { app, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const notifyAll = require("../utils/notifyAll");

const STATUS_TOPIC = "docs-ingest/status";
const REPO_OWNER = "hardwario";
const REPO_NAME = "docs";
const REPO_BRANCH = "main";
const SOURCE_ID = "hardwario-docs";
const SOURCE_PREFIX = "tower/hardware-modules/";
const EXCLUDED_SEGMENT = "/images/";
const TREE_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${REPO_BRANCH}?recursive=1`;
const RAW_BASE_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}`;

let currentStatus = {
  state: "idle",
  message: "Documentation corpus not downloaded yet.",
  sourceId: SOURCE_ID,
  targetDir: "",
  manifestPath: "",
  treeSha: "",
  totalFiles: 0,
  completedFiles: 0,
  startedAt: null,
  finishedAt: null,
  error: "",
  hasLocalDocs: false,
};

let downloadPromise = null;

function getRagBasePath() {
  const basePath = path.join(app.getPath("userData"), "rag");
  fs.mkdirSync(basePath, { recursive: true });
  return basePath;
}

function getSourceRootPath() {
  const sourceRoot = path.join(getRagBasePath(), "sources", "github", SOURCE_ID);
  fs.mkdirSync(sourceRoot, { recursive: true });
  return sourceRoot;
}

function getRawDocsPath() {
  return path.join(getSourceRootPath(), "raw");
}

function getManifestPath() {
  return path.join(getSourceRootPath(), "manifest.json");
}

function publishStatus(nextStatusPatch) {
  currentStatus = {
    ...currentStatus,
    ...nextStatusPatch,
  };
  notifyAll(STATUS_TOPIC, currentStatus);
}

function getHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "HARDWARIO-Playground",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: getHeaders(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub request failed (${response.status}): ${body}`);
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "HARDWARIO-Playground",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Raw file download failed (${response.status}): ${body}`);
  }

  return response.text();
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

// Keep only the documentation files we want to persist locally for later chunking
function collectTargetFiles(treeItems) {
  return treeItems
    .filter((item) => item && item.type === "blob" && typeof item.path === "string")
    .filter((item) => item.path.startsWith(SOURCE_PREFIX))
    .filter((item) => !item.path.includes(EXCLUDED_SEGMENT))
    .filter((item) => !path.basename(item.path).startsWith("."))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function loadManifestSummary() {
  const manifestPath = getManifestPath();
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error("docs-ingest: failed to read manifest", error);
    return null;
  }
}

function countFilesRecursively(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return 0;
  }

  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += countFilesRecursively(entryPath);
    } else if (entry.isFile()) {
      total += 1;
    }
  }

  return total;
}

function buildStoredCorpusStatus(manifest) {
  const targetDir = getRawDocsPath();
  const manifestPath = getManifestPath();
  const storedFileCount = countFilesRecursively(targetDir);
  const fileCount = Number(manifest?.fileCount || 0);

  if (!manifest || storedFileCount <= 0 || fileCount <= 0) {
    return null;
  }

  return {
    state: "success",
    message: `Local documentation corpus ready (${fileCount} files).`,
    sourceId: SOURCE_ID,
    targetDir,
    manifestPath,
    treeSha: manifest.treeSha || "",
    totalFiles: fileCount,
    completedFiles: fileCount,
    startedAt: null,
    finishedAt: manifest.downloadedAt || null,
    error: "",
    hasLocalDocs: true,
  };
}

function resolveCurrentStatus() {
  const manifest = loadManifestSummary();
  const storedStatus = buildStoredCorpusStatus(manifest);

  if (storedStatus) {
    return {
      ...storedStatus,
      startedAt: currentStatus.startedAt,
      error: currentStatus.state === "error" ? currentStatus.error : "",
      message: currentStatus.state === "error" && currentStatus.error
        ? "Local documentation corpus ready, but the last refresh attempt failed."
        : storedStatus.message,
    };
  }

  return {
    ...currentStatus,
    state: currentStatus.state === "error" ? "error" : "idle",
    message: currentStatus.state === "error" && currentStatus.error
      ? currentStatus.error
      : "Documentation corpus not downloaded yet.",
    targetDir: getRawDocsPath(),
    manifestPath: getManifestPath(),
    treeSha: "",
    totalFiles: 0,
    completedFiles: 0,
    finishedAt: null,
    hasLocalDocs: false,
  };
}

async function downloadHardwareDocs() {
  const targetDir = getRawDocsPath();
  const sourceRoot = getSourceRootPath();
  const tempRoot = `${sourceRoot}.download`;
  const tempRawDir = path.join(tempRoot, "raw");
  const manifestPath = getManifestPath();
  const existingStoredStatus = buildStoredCorpusStatus(loadManifestSummary());

  // Download into a temp directory first so a failed refresh never leaves a partial corpus
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRawDir, { recursive: true });

  publishStatus({
    state: "running",
    message: "Fetching GitHub file list...",
    sourceId: SOURCE_ID,
    targetDir,
    manifestPath,
    treeSha: "",
    totalFiles: 0,
    completedFiles: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: "",
    hasLocalDocs: Boolean(existingStoredStatus),
  });

  const treePayload = await fetchJson(TREE_URL);
  const files = collectTargetFiles(Array.isArray(treePayload.tree) ? treePayload.tree : []);

  if (files.length === 0) {
    throw new Error("No documentation files matched the selected GitHub folder.");
  }

  publishStatus({
    message: `Downloading ${files.length} files...`,
    treeSha: typeof treePayload.sha === "string" ? treePayload.sha : "",
    totalFiles: files.length,
    completedFiles: 0,
  });

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const relativePath = file.path;
    const destinationPath = path.join(tempRawDir, relativePath);
    const rawUrl = `${RAW_BASE_URL}/${relativePath}`;

    publishStatus({
      message: `Downloading ${relativePath}`,
      completedFiles: index,
    });

    const content = await fetchText(rawUrl);
    ensureParentDir(destinationPath);
    fs.writeFileSync(destinationPath, content, "utf8");
  }

  // The manifest describes exactly which source snapshot was downloaded to disk.
  const manifest = {
    sourceId: SOURCE_ID,
    provider: "github",
    owner: REPO_OWNER,
    repo: REPO_NAME,
    branch: REPO_BRANCH,
    prefix: SOURCE_PREFIX,
    excludedSegment: EXCLUDED_SEGMENT,
    treeSha: typeof treePayload.sha === "string" ? treePayload.sha : "",
    downloadedAt: new Date().toISOString(),
    fileCount: files.length,
    files: files.map((file) => ({
      path: file.path,
      sha: file.sha,
      size: file.size,
      url: file.url,
    })),
  };

  fs.writeFileSync(path.join(tempRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  // Replace the previous corpus only after the new download is fully complete.
  fs.rmSync(sourceRoot, { recursive: true, force: true });
  fs.renameSync(tempRoot, sourceRoot);

  publishStatus({
    state: "success",
    message: `Local documentation corpus ready (${files.length} files).`,
    targetDir,
    manifestPath,
    totalFiles: files.length,
    completedFiles: files.length,
    finishedAt: manifest.downloadedAt,
    error: "",
    hasLocalDocs: true,
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
  ipcMain.handle("docs-ingest/get-status", () => {
    currentStatus = getStatus();
    return currentStatus;
  });

  ipcMain.handle("docs-ingest/download-hardware-docs", async () => {
    // Reuse the active promise so repeated button clicks do not start duplicate downloads.
    if (downloadPromise) {
      return currentStatus;
    }

    downloadPromise = downloadHardwareDocs()
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Unknown documentation download error.";
        const storedStatus = buildStoredCorpusStatus(loadManifestSummary());
        publishStatus({
          state: storedStatus ? "success" : "error",
          message: storedStatus
            ? "Local documentation corpus ready, but the last refresh attempt failed."
            : message,
          finishedAt: new Date().toISOString(),
          error: message,
          hasLocalDocs: Boolean(storedStatus),
        });
        return currentStatus;
      })
      .finally(() => {
        downloadPromise = null;
      });

    return currentStatus;
  });
}

module.exports = { setup };
