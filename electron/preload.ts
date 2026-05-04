import { contextBridge, ipcRenderer, IpcRendererEvent, shell } from 'electron';

// Type definitions for IPC payloads
export interface SerialPortInfo {
  path: string;
  serialNumber?: string;
  manufacturer?: string;
  productId?: string;
}

export interface GatewayStatus {
  status: 'online' | 'offline';
  error?: string;
}

export interface FlashProgress {
  erase: number;
  write: number;
  verify: number;
}

export interface DownloadProgress {
  percent: number;
  transferred: number;
  total: number;
}

export interface FirmwareItem {
  name: string;
  description?: string;
  article?: string;
  video?: string;
  repository?: string;
  images?: Array<{ url: string; title: string }>;
  articles?: Array<{
    title: string;
    description: string;
    url: string;
    video?: string;
    images?: Array<{ url: string; title: string }>;
  }>;
  versions?: Array<{ name: string; url: string }>;
  tags: string[];
}

export interface FlashParams {
  firmware: string;
  port: string;
  version?: string;
}

export interface FileDialogResult {
  filePath: string | null;
  canceled: boolean;
}

export interface AIChatMessageInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIChatSendPayload {
  requestId: string;
  model: string;
  messages: AIChatMessageInput[];
}

export interface AIChatModelOption {
  id: string;
  label: string;
  free: boolean;
}

export interface AIChatConfig {
  hasApiKey: boolean;
  model: string;
  defaultModel: string;
  modelOptions: AIChatModelOption[];
  encryptionAvailable: boolean;
}

export interface AIChatChunkPayload {
  requestId: string;
  delta: string;
}

export interface AIChatDonePayload {
  requestId: string;
}

export interface AIChatErrorPayload {
  requestId: string;
  error: string;
}

export interface DocsIngestStatus {
  state: 'idle' | 'running' | 'success' | 'error';
  message: string;
  sourceId: string;
  targetDir: string;
  manifestPath: string;
  treeSha: string;
  totalFiles: number;
  completedFiles: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string;
}

// Helper to create unsubscribe function for event listeners
function createListener<T>(channel: string, callback: (data: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, data: T) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// ElectronAPI interface
export interface ElectronAPI {
  settings: {
    get: (key: string) => Promise<unknown>;
    getSync: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
    getAll: () => Promise<Record<string, unknown>>;
    onValue: (key: string, callback: (value: unknown) => void) => () => void;
    onAll: (callback: (settings: Record<string, unknown>) => void) => () => void;
  };
  gateway: {
    connect: (port: string) => void;
    disconnect: () => void;
    getStatus: () => void;
    getDevice: () => void;
    getPortList: () => void;
    onStatus: (callback: (status: GatewayStatus) => void) => () => void;
    onDevice: (callback: (device: string) => void) => () => void;
    onPortList: (callback: (ports: SerialPortInfo[]) => void) => () => void;
  };
  firmware: {
    runFlash: (params: FlashParams) => void;
    getPortList: () => void;
    getList: () => void;
    openFileDialog: () => void;
    onProgress: (callback: (progress: FlashProgress) => void) => () => void;
    onPortList: (callback: (ports: SerialPortInfo[]) => void) => () => void;
    onList: (callback: (list: FirmwareItem[]) => void) => () => void;
    onError: (callback: (error: string) => void) => () => void;
    onDone: (callback: () => void) => () => void;
    onDownload: (callback: (progress: DownloadProgress) => void) => () => void;
    onFileDialogResult: (callback: (result: FileDialogResult) => void) => () => void;
  };
  nodered: {
    getStatus: () => void;
    onStatus: (callback: (status: string) => void) => () => void;
  };
  broker: {
    getStatus: () => void;
    onStatus: (callback: (status: string) => void) => () => void;
  };
  iframe: {
    onVisible: (id: string, callback: (visible: boolean) => void) => () => void;
    onReload: (id: string, callback: () => void) => () => void;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  app: {
    getVersion: () => Promise<string>;
    getPath: (name: string) => Promise<string>;
  };
  zoom: {
    zoomIn: () => void;
    zoomOut: () => void;
    reset: () => void;
    get: () => Promise<number>;
  };
  aiChat: {
    getConfig: () => Promise<AIChatConfig>;
    setApiKey: (apiKey: string) => Promise<{ encrypted: boolean }>;
    clearApiKey: () => Promise<{ ok: boolean }>;
    setModel: (model: string) => Promise<{ ok: boolean; model: string }>;
    send: (payload: AIChatSendPayload) => void;
    cancel: (requestId: string) => void;
    onChunk: (callback: (payload: AIChatChunkPayload) => void) => () => void;
    onDone: (callback: (payload: AIChatDonePayload) => void) => () => void;
    onError: (callback: (payload: AIChatErrorPayload) => void) => () => void;
    onCancelled: (callback: (payload: AIChatDonePayload) => void) => () => void;
  };
  docsIngest: {
    getStatus: () => Promise<DocsIngestStatus>;
    downloadHardwareDocs: () => Promise<DocsIngestStatus>;
    onStatus: (callback: (status: DocsIngestStatus) => void) => () => void;
  };
}

const electronAPI: ElectronAPI = {
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings/get', key),
    getSync: (key: string) => ipcRenderer.sendSync('settings/get-sync', key),
    set: (key: string, value: unknown) => ipcRenderer.send('settings/set', { key, value }),
    getAll: () => ipcRenderer.invoke('settings/getAll'),
    onValue: (key: string, callback: (value: unknown) => void) =>
      createListener(`settings/value/${key}`, callback),
    onAll: (callback: (settings: Record<string, unknown>) => void) =>
      createListener('settings/all', callback),
  },

  gateway: {
    connect: (port: string) => ipcRenderer.send('gateway/connect', port),
    disconnect: () => ipcRenderer.send('gateway/disconnect'),
    getStatus: () => ipcRenderer.send('gateway/status/get'),
    getDevice: () => ipcRenderer.send('gateway/device/get'),
    getPortList: () => ipcRenderer.send('gateway/port-list/get'),
    onStatus: (callback: (status: GatewayStatus) => void) =>
      createListener('gateway/status', callback),
    onDevice: (callback: (device: string) => void) =>
      createListener('gateway/device', callback),
    onPortList: (callback: (ports: SerialPortInfo[]) => void) =>
      createListener('gateway/port-list', callback),
  },

  firmware: {
    runFlash: (params: FlashParams) => ipcRenderer.send('firmware:run-flash', params),
    getPortList: () => ipcRenderer.send('firmware:get-port-list'),
    getList: () => ipcRenderer.send('firmware:get-list'),
    openFileDialog: () => ipcRenderer.send('firmware:open-file-dialog'),
    onProgress: (callback: (progress: FlashProgress) => void) =>
      createListener('firmware:progress', callback),
    onPortList: (callback: (ports: SerialPortInfo[]) => void) =>
      createListener('firmware:port-list', callback),
    onList: (callback: (list: FirmwareItem[]) => void) =>
      createListener('firmware:list', callback),
    onError: (callback: (error: string) => void) =>
      createListener('firmware:error', callback),
    onDone: (callback: () => void) =>
      createListener('firmware:done', callback),
    onDownload: (callback: (progress: DownloadProgress) => void) =>
      createListener('firmware:download', callback),
    onFileDialogResult: (callback: (result: FileDialogResult) => void) =>
      createListener('firmware:file-dialog-result', callback),
  },

  nodered: {
    getStatus: () => ipcRenderer.send('nodered/status/get'),
    onStatus: (callback: (status: string) => void) =>
      createListener('nodered/status', callback),
  },

  broker: {
    getStatus: () => ipcRenderer.send('broker/status/get'),
    onStatus: (callback: (status: string) => void) =>
      createListener('broker/status', callback),
  },

  iframe: {
    onVisible: (id: string, callback: (visible: boolean) => void) =>
      createListener(`iframe:${id}:visible`, callback),
    onReload: (id: string, callback: () => void) =>
      createListener(`iframe:${id}:reload`, callback),
  },

  shell: {
    openExternal: async (url: string) => {
      // Validate URL before sending to main process
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          await shell.openExternal(url);
        }
      } catch {
        console.error('Invalid URL:', url);
      }
    },
  },

  app: {
    getVersion: () => ipcRenderer.invoke('app/getVersion'),
    getPath: (name: string) => ipcRenderer.invoke('app/getPath', name),
  },

  zoom: {
    zoomIn: () => ipcRenderer.send('zoom:in'),
    zoomOut: () => ipcRenderer.send('zoom:out'),
    reset: () => ipcRenderer.send('zoom:reset'),
    get: () => ipcRenderer.invoke('zoom:get'),
  },

  aiChat: {
    getConfig: () => ipcRenderer.invoke('ai-chat/get-config'),
    setApiKey: (apiKey: string) => ipcRenderer.invoke('ai-chat/set-api-key', apiKey),
    clearApiKey: () => ipcRenderer.invoke('ai-chat/clear-api-key'),
    setModel: (model: string) => ipcRenderer.invoke('ai-chat/set-model', model),
    send: (payload: AIChatSendPayload) => ipcRenderer.send('ai-chat/send', payload),
    cancel: (requestId: string) => ipcRenderer.send('ai-chat/cancel', requestId),
    onChunk: (callback: (payload: AIChatChunkPayload) => void) =>
      createListener('ai-chat/chunk', callback),
    onDone: (callback: (payload: AIChatDonePayload) => void) =>
      createListener('ai-chat/done', callback),
    onError: (callback: (payload: AIChatErrorPayload) => void) =>
      createListener('ai-chat/error', callback),
    onCancelled: (callback: (payload: AIChatDonePayload) => void) =>
      createListener('ai-chat/cancelled', callback),
  },

  docsIngest: {
    getStatus: () => ipcRenderer.invoke('docs-ingest/get-status'),
    downloadHardwareDocs: () => ipcRenderer.invoke('docs-ingest/download-hardware-docs'),
    onStatus: (callback: (status: DocsIngestStatus) => void) =>
      createListener('docs-ingest/status', callback),
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
