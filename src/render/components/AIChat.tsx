import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { FiDownload, FiKey, FiMessageSquare, FiPlus, FiRefreshCw, FiSend, FiSettings, FiSquare, FiTrash2, FiX } from 'react-icons/fi';
import remarkGfm from 'remark-gfm';
import type { AIChatConversation, AIChatStoredMessage, DocsChunkingStatus, DocsEmbeddingsStatus, DocsIngestStatus } from '../../../electron/preload';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dropEmptyAssistant(messages: ChatMessage[], assistantId: string | null): ChatMessage[] {
  if (!assistantId) {
    return messages;
  }

  return messages.filter((message) => !(message.id === assistantId && message.role === 'assistant' && message.content.trim().length === 0));
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none prose-headings:text-gray-900 prose-p:text-inherit prose-strong:text-inherit prose-code:text-gray-900 prose-pre:hidden prose-a:text-hardwario-primary prose-a:no-underline hover:prose-a:underline">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href) {
                  void window.electronAPI.shell.openExternal(href);
                }
              }}
            >
              {children}
            </a>
          ),
          blockquote: ({ children, ...props }) => (
            <blockquote {...props} className="border-l-2 border-gray-300 pl-3 text-gray-700 italic">
              {children}
            </blockquote>
          ),
          code: ({ className, children, ...props }) => {
            const languageMatch = /language-([\w-]+)/.exec(className || '');
            const code = String(children).replace(/\n$/, '');

            if (!languageMatch) {
              return (
                <code
                  {...props}
                  className="px-1 py-0.5 bg-gray-200 text-gray-900 rounded text-[0.9em] font-mono"
                >
                  {children}
                </code>
              );
            }

            return (
              <div className="rounded-md overflow-hidden border border-gray-300 my-3">
                <div className="px-3 py-1 text-xs bg-gray-800 text-gray-300">{languageMatch[1]}</div>
                <pre className="m-0 p-3 bg-gray-900 text-gray-100 overflow-x-auto text-xs">
                  <code>{code}</code>
                </pre>
              </div>
            );
          },
          table: ({ children, ...props }) => (
            <div className="my-3 overflow-x-auto">
              <table {...props} className="min-w-full border-collapse border border-gray-300 text-sm">
                {children}
              </table>
            </div>
          ),
          thead: ({ children, ...props }) => (
            <thead {...props} className="bg-gray-100">
              {children}
            </thead>
          ),
          th: ({ children, ...props }) => (
            <th {...props} className="border border-gray-300 px-3 py-2 text-left font-semibold text-gray-900">
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td {...props} className="border border-gray-300 px-3 py-2 align-top text-gray-900">
              {children}
            </td>
          ),
          ul: ({ children, ...props }) => (
            <ul {...props} className="list-disc pl-5 space-y-1">
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol {...props} className="list-decimal pl-5 space-y-1">
              {children}
            </ol>
          ),
          p: ({ children, ...props }) => (
            <p {...props} className="leading-relaxed">
              {children}
            </p>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function formatConversationDate(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function AIChat() {
  const [conversations, setConversations] = useState<AIChatConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [encryptionAvailable, setEncryptionAvailable] = useState(false);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<{ id: string; label: string; free: boolean }[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingConversationTitle, setEditingConversationTitle] = useState('');
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [statusText, setStatusText] = useState<string>('');
  const [errorText, setErrorText] = useState<string>('');
  const [docsStatus, setDocsStatus] = useState<DocsIngestStatus>({
    state: 'idle',
    message: 'Documentation corpus not downloaded yet.',
    sourceId: 'hardwario-docs',
    targetDir: '',
    manifestPath: '',
    treeSha: '',
    totalFiles: 0,
    completedFiles: 0,
    startedAt: null,
    finishedAt: null,
    error: '',
    hasLocalDocs: false,
  });
  const [docsChunkingStatus, setDocsChunkingStatus] = useState<DocsChunkingStatus>({
    state: 'idle',
    message: 'Chunks not built yet.',
    sourceId: 'hardwario-docs',
    outputPath: '',
    manifestPath: '',
    totalFiles: 0,
    completedFiles: 0,
    chunkCount: 0,
    treeSha: '',
    startedAt: null,
    finishedAt: null,
    error: '',
    hasChunks: false,
  });
  const [docsEmbeddingsStatus, setDocsEmbeddingsStatus] = useState<DocsEmbeddingsStatus>({
    state: 'idle',
    message: 'Embeddings not built yet.',
    sourceId: 'hardwario-docs',
    outputPath: '',
    manifestPath: '',
    totalChunks: 0,
    completedChunks: 0,
    embeddingCount: 0,
    embeddingModel: 'openai/text-embedding-3-small',
    startedAt: null,
    finishedAt: null,
    error: '',
    hasEmbeddings: false,
  });

  const currentRequestIdRef = useRef<string | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);
  const currentAssistantContentRef = useRef('');
  const currentConversationIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const conversationTitleInputRef = useRef<HTMLInputElement | null>(null);
  const deleteConfirmRef = useRef<HTMLDivElement | null>(null);

  const mapStoredMessage = (message: AIChatStoredMessage): ChatMessage => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  });

  const loadDocsStatus = async () => {
    try {
      const status = await window.electronAPI.docsIngest.getStatus();
      setDocsStatus(status);
    } catch (error) {
      console.error('Failed to refresh docs ingestion status.', error);
    }
  };

  const loadDocsChunkingStatus = async () => {
    try {
      const status = await window.electronAPI.docsChunking.getStatus();
      setDocsChunkingStatus(status);
    } catch (error) {
      console.error('Failed to refresh docs chunking status.', error);
    }
  };

  const loadDocsEmbeddingsStatus = async () => {
    try {
      const status = await window.electronAPI.docsEmbeddings.getStatus();
      setDocsEmbeddingsStatus(status);
    } catch (error) {
      console.error('Failed to refresh docs embeddings status.', error);
    }
  };

  const loadMessagesForConversation = async (conversationId: string) => {
    const storedMessages = await window.electronAPI.aiChatStore.getMessages(conversationId);
    setMessages(storedMessages.map(mapStoredMessage));
    setActiveConversationId(conversationId);
  };

  const syncConversationList = async (): Promise<AIChatConversation[]> => {
    let nextConversations = await window.electronAPI.aiChatStore.listConversations();

    if (nextConversations.length === 0) {
      const conversation = await window.electronAPI.aiChatStore.createConversation({ model });
      nextConversations = [conversation];
    }

    setConversations(nextConversations);
    return nextConversations;
  };

  const refreshConversations = async (preferredConversationId?: string | null) => {
    const nextConversations = await syncConversationList();

    const nextConversationId =
      (preferredConversationId && nextConversations.some((conversation) => conversation.id === preferredConversationId)
        ? preferredConversationId
        : null) ||
      (activeConversationId && nextConversations.some((conversation) => conversation.id === activeConversationId)
        ? activeConversationId
        : null) ||
      nextConversations[0].id;

    if (nextConversationId) {
      await loadMessagesForConversation(nextConversationId);
    }
  };

  const persistAssistantMessage = async () => {
    const conversationId = currentConversationIdRef.current;
    const content = currentAssistantContentRef.current.trim();
    const assistantId = currentAssistantIdRef.current;

    if (!conversationId || !assistantId || !content) {
      return;
    }

    const storedMessage = await window.electronAPI.aiChatStore.addMessage({
      conversationId,
      role: 'assistant',
      content,
      model,
    });

    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId
          ? mapStoredMessage(storedMessage)
          : message
      )
    );

    await syncConversationList();
  };

  useEffect(() => {
    window.electronAPI.aiChat
      .getConfig()
      .then((config) => {
        setHasApiKey(config.hasApiKey);
        setEncryptionAvailable(config.encryptionAvailable);
        setModels(config.modelOptions);
        setModel(config.model || config.defaultModel);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to load chat configuration.';
        setErrorText(message);
      });

    void loadDocsStatus();
    void loadDocsChunkingStatus();
    void loadDocsEmbeddingsStatus();
    void refreshConversations().finally(() => {
      setIsLoadingConversations(false);
    });
  }, []);

  useEffect(() => {
    const unsubChunk = window.electronAPI.aiChat.onChunk((payload) => {
      if (payload.requestId !== currentRequestIdRef.current) {
        return;
      }

      const assistantId = currentAssistantIdRef.current;
      if (!assistantId) {
        return;
      }

      currentAssistantContentRef.current += payload.delta;

      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? { ...message, content: message.content + payload.delta }
            : message
        )
      );
    });

    const finalizeStreamingState = (nextStatusText: string, nextErrorText = '') => {
      setIsSending(false);
      setStatusText(nextStatusText);
      if (nextErrorText) {
        setErrorText(nextErrorText);
      }
      currentRequestIdRef.current = null;
      currentAssistantIdRef.current = null;
      currentConversationIdRef.current = null;
      currentAssistantContentRef.current = '';
    };

    const unsubDone = window.electronAPI.aiChat.onDone((payload) => {
      if (payload.requestId !== currentRequestIdRef.current) {
        return;
      }

      void persistAssistantMessage().finally(() => {
        finalizeStreamingState('');
      });
    });

    const unsubCancelled = window.electronAPI.aiChat.onCancelled((payload) => {
      if (payload.requestId !== currentRequestIdRef.current) {
        return;
      }

      const hasAssistantDraft = currentAssistantContentRef.current.trim().length > 0;
      const persistPromise = hasAssistantDraft ? persistAssistantMessage() : Promise.resolve();

      void persistPromise.finally(() => {
        setMessages((prev) => dropEmptyAssistant(prev, currentAssistantIdRef.current));
        finalizeStreamingState('Generation cancelled.');
      });
    });

    const unsubError = window.electronAPI.aiChat.onError((payload) => {
      if (payload.requestId && payload.requestId !== currentRequestIdRef.current) {
        return;
      }

      const hasAssistantDraft = currentAssistantContentRef.current.trim().length > 0;
      const persistPromise = hasAssistantDraft ? persistAssistantMessage() : Promise.resolve();

      void persistPromise.finally(() => {
        setMessages((prev) => dropEmptyAssistant(prev, currentAssistantIdRef.current));
        finalizeStreamingState('', payload.error || 'Unknown chat error');
      });
    });

    return () => {
      unsubChunk();
      unsubDone();
      unsubCancelled();
      unsubError();
    };
  }, [model]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSending]);

  useEffect(() => {
    const unsubDocsStatus = window.electronAPI.docsIngest.onStatus((status) => {
      setDocsStatus(status);
      if (status.state !== 'running') {
        void loadDocsChunkingStatus();
      }
    });
    const unsubDocsChunkingStatus = window.electronAPI.docsChunking.onStatus((status) => {
      setDocsChunkingStatus(status);
      if (status.state !== 'running') {
        void loadDocsEmbeddingsStatus();
      }
    });
    const unsubDocsEmbeddingsStatus = window.electronAPI.docsEmbeddings.onStatus((status) => {
      setDocsEmbeddingsStatus(status);
    });

    const handleWindowFocus = () => {
      void loadDocsStatus();
      void loadDocsChunkingStatus();
      void loadDocsEmbeddingsStatus();
    };

    window.addEventListener('focus', handleWindowFocus);

    return () => {
      unsubDocsStatus();
      unsubDocsChunkingStatus();
      unsubDocsEmbeddingsStatus();
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, []);

  const canSend = useMemo(() => {
    return hasApiKey && !isSending && prompt.trim().length > 0 && model.length > 0 && Boolean(activeConversationId);
  }, [activeConversationId, hasApiKey, isSending, prompt, model]);

  const saveApiKey = async () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setErrorText('OpenRouter API key cannot be empty.');
      return;
    }

    try {
      await window.electronAPI.aiChat.setApiKey(trimmed);
      setHasApiKey(true);
      setApiKeyInput('');
      setErrorText('');
      setStatusText('API key saved.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save API key.';
      setErrorText(message);
    }
  };

  const clearApiKey = async () => {
    try {
      await window.electronAPI.aiChat.clearApiKey();
      setHasApiKey(false);
      setApiKeyInput('');
      setStatusText('API key removed.');
      setErrorText('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to clear API key.';
      setErrorText(message);
    }
  };

  const handleModelChange = async (value: string) => {
    setModel(value);
    try {
      const result = await window.electronAPI.aiChat.setModel(value);
      setModel(result.model);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save selected model.';
      setErrorText(message);
    }
  };

  const handleDownloadDocs = async () => {
    try {
      const status = await window.electronAPI.docsIngest.downloadHardwareDocs();
      setDocsStatus(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start documentation download.';
      setDocsStatus((prev) => ({
        ...prev,
        state: 'error',
        message,
        error: message,
      }));
    }
  };

  const handleBuildChunks = async () => {
    try {
      const status = await window.electronAPI.docsChunking.buildChunks();
      setDocsChunkingStatus(status);
      void loadDocsEmbeddingsStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start chunk build.';
      setDocsChunkingStatus((prev) => ({
        ...prev,
        state: 'error',
        message,
        error: message,
      }));
    }
  };

  const handleBuildEmbeddings = async () => {
    try {
      const status = await window.electronAPI.docsEmbeddings.buildEmbeddings();
      setDocsEmbeddingsStatus(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start embedding build.';
      setDocsEmbeddingsStatus((prev) => ({
        ...prev,
        state: 'error',
        message,
        error: message,
      }));
    }
  };

  const handleCreateConversation = async () => {
    const conversation = await window.electronAPI.aiChatStore.createConversation({ model });
    await refreshConversations(conversation.id);
    setPrompt('');
    setErrorText('');
    setStatusText('');
    setIsDeleteConfirmOpen(false);
  };

  const handleDeleteConversation = async (conversationId: string) => {
    await window.electronAPI.aiChatStore.deleteConversation(conversationId);
    await refreshConversations();
    setPrompt('');
    setErrorText('');
    setStatusText('');
    setIsDeleteConfirmOpen(false);
  };

  const startRenamingConversation = (conversation: AIChatConversation) => {
    if (isSending) {
      return;
    }
    setEditingConversationId(conversation.id);
    setEditingConversationTitle(conversation.title);
    setErrorText('');
  };

  const cancelRenamingConversation = () => {
    setEditingConversationId(null);
    setEditingConversationTitle('');
  };

  const submitConversationRename = async (conversationId: string) => {
    const trimmedTitle = editingConversationTitle.trim();
    if (!trimmedTitle) {
      setErrorText('Conversation name cannot be empty.');
      queueMicrotask(() => {
        conversationTitleInputRef.current?.focus();
        conversationTitleInputRef.current?.select();
      });
      return;
    }

    try {
      await window.electronAPI.aiChatStore.renameConversation({
        conversationId,
        title: trimmedTitle,
      });
      setErrorText('');
      await refreshConversations(conversationId);
      cancelRenamingConversation();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rename the conversation.';
      setErrorText(message);
    }
  };

  useEffect(() => {
    if (!editingConversationId) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const input = conversationTitleInputRef.current;
      const target = event.target as Node | null;
      if (!input || !target || input.contains(target)) {
        return;
      }

      void submitConversationRename(editingConversationId);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [editingConversationId, editingConversationTitle]);

  useEffect(() => {
    if (!isDeleteConfirmOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const container = deleteConfirmRef.current;
      const target = event.target as Node | null;
      if (!container || !target || container.contains(target)) {
        return;
      }

      setIsDeleteConfirmOpen(false);
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsDeleteConfirmOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isDeleteConfirmOpen]);

  const sendPrompt = () => {
    if (!canSend || !activeConversationId) {
      return;
    }

    const userContent = prompt.trim();
    const requestId = makeId('req');
    const assistantMessage: ChatMessage = {
      id: makeId('a'),
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    };

    void window.electronAPI.aiChatStore.addMessage({
      conversationId: activeConversationId,
      role: 'user',
      content: userContent,
      model,
    }).then(async (storedUserMessage) => {
      const userMessage = mapStoredMessage(storedUserMessage);
      const history = [...messages, userMessage].map((message) => ({
        role: message.role,
        content: message.content,
      }));

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setPrompt('');
      setIsSending(true);
      setErrorText('');
      setStatusText('Generating response...');
      currentRequestIdRef.current = requestId;
      currentAssistantIdRef.current = assistantMessage.id;
      currentConversationIdRef.current = activeConversationId;
      currentAssistantContentRef.current = '';

      await syncConversationList();

      window.electronAPI.aiChat.send({
        requestId,
        model,
        messages: history,
      });
    }).catch((error) => {
      const message = error instanceof Error ? error.message : 'Failed to save the user message.';
      setErrorText(message);
    });
  };

  const handleSend = (event: FormEvent) => {
    event.preventDefault();
    sendPrompt();
  };

  const handleCancel = () => {
    const requestId = currentRequestIdRef.current;
    if (!requestId) {
      return;
    }

    window.electronAPI.aiChat.cancel(requestId);
  };

  const clearChat = () => {
    if (isSending || !activeConversationId) {
      if (isSending) {
        handleCancel();
      }
      return;
    }

    void window.electronAPI.aiChatStore.clearConversation(activeConversationId).then(async () => {
      setMessages([]);
      setPrompt('');
      setErrorText('');
      setStatusText('');
      await refreshConversations(activeConversationId);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : 'Failed to clear the conversation.';
      setErrorText(message);
    });
  };

  const handleSelectConversation = (conversationId: string) => {
    if (isSending || conversationId === activeConversationId) {
      return;
    }

    setIsDeleteConfirmOpen(false);
    void loadMessagesForConversation(conversationId);
  };

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendPrompt();
    }
  };

  const docsProgressLabel = docsStatus.totalFiles > 0
    ? `${docsStatus.completedFiles}/${docsStatus.totalFiles} files`
    : 'No files downloaded yet';
  const docsActionLabel = docsStatus.hasLocalDocs ? 'Refresh Docs' : 'Download Docs';
  const docsStateBadgeClassName = docsStatus.state === 'running'
    ? 'bg-amber-100 text-amber-800'
    : docsStatus.hasLocalDocs
      ? 'bg-green-100 text-green-800'
      : docsStatus.state === 'error'
        ? 'bg-red-100 text-red-800'
        : 'bg-gray-200 text-gray-700';
  const docsStateBadgeLabel = docsStatus.state === 'running'
    ? 'Downloading'
    : docsStatus.hasLocalDocs
      ? 'Ready'
      : docsStatus.state === 'error'
        ? 'Unavailable'
        : 'Missing';
  const docsChunkingProgressLabel = docsChunkingStatus.totalFiles > 0
    ? `${docsChunkingStatus.completedFiles}/${docsChunkingStatus.totalFiles} files`
    : 'No chunks built yet';
  const docsChunkingActionLabel = docsChunkingStatus.hasChunks ? 'Rebuild Chunks' : 'Build Chunks';
  const docsChunkingStateBadgeClassName = docsChunkingStatus.state === 'running'
    ? 'bg-amber-100 text-amber-800'
    : docsChunkingStatus.hasChunks
      ? 'bg-green-100 text-green-800'
      : docsChunkingStatus.state === 'error'
        ? 'bg-red-100 text-red-800'
        : 'bg-gray-200 text-gray-700';
  const docsChunkingStateBadgeLabel = docsChunkingStatus.state === 'running'
    ? 'Building'
    : docsChunkingStatus.hasChunks
      ? 'Ready'
      : docsChunkingStatus.state === 'error'
        ? 'Unavailable'
        : 'Missing';
  const docsEmbeddingsProgressLabel = docsEmbeddingsStatus.totalChunks > 0
    ? `${docsEmbeddingsStatus.completedChunks}/${docsEmbeddingsStatus.totalChunks} chunks`
    : 'No embeddings built yet';
  const docsEmbeddingsActionLabel = docsEmbeddingsStatus.hasEmbeddings ? 'Rebuild Embeddings' : 'Build Embeddings';
  const docsEmbeddingsStateBadgeClassName = docsEmbeddingsStatus.state === 'running'
    ? 'bg-amber-100 text-amber-800'
    : docsEmbeddingsStatus.hasEmbeddings
      ? 'bg-green-100 text-green-800'
      : docsEmbeddingsStatus.state === 'error'
        ? 'bg-red-100 text-red-800'
        : 'bg-gray-200 text-gray-700';
  const docsEmbeddingsStateBadgeLabel = docsEmbeddingsStatus.state === 'running'
    ? 'Building'
    : docsEmbeddingsStatus.hasEmbeddings
      ? 'Ready'
      : docsEmbeddingsStatus.state === 'error'
        ? 'Unavailable'
        : 'Missing';
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) || null;

  return (
    <div className="h-full flex bg-gray-50">
      <aside className="w-[260px] border-r border-gray-200 bg-white flex flex-col">
        <div className="p-3 border-b border-gray-200 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Conversations</h3>
            <p className="text-xs text-gray-500">Stored locally in SQLite on this device.</p>
          </div>
          <button
            type="button"
            onClick={() => void handleCreateConversation()}
            disabled={isSending}
            className="w-full h-10 px-3 bg-hardwario-primary text-white font-medium rounded hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <FiPlus className="w-4 h-4" />
            New Chat
          </button>
          <button
            type="button"
            onClick={() => setIsOptionsOpen(true)}
            className="w-full h-10 px-3 bg-gray-100 text-gray-700 font-medium rounded hover:bg-gray-200 transition-colors flex items-center justify-center gap-2"
          >
            <FiSettings className="w-4 h-4" />
            Options
          </button>
        </div>

        <div className="flex-1 overflow-auto p-2 space-y-2">
          {conversations.map((conversation) => {
            const isActive = conversation.id === activeConversationId;
            return (
              <div
                key={conversation.id}
                className={`rounded border transition-colors ${
                  isActive ? 'border-hardwario-primary bg-blue-50/50' : 'border-gray-200 bg-white hover:bg-gray-50'
                }`}
              >
                <button
                  type="button"
                  disabled={isSending}
                  onClick={() => handleSelectConversation(conversation.id)}
                  className="w-full text-left px-3 py-3 disabled:cursor-not-allowed"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-sm text-gray-900 truncate">{conversation.title}</div>
                      <div className="text-xs text-gray-500 truncate">
                        {conversation.lastMessagePreview || 'No messages yet'}
                      </div>
                    </div>
                    <FiMessageSquare className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  </div>
                  <div className="mt-2 text-[11px] text-gray-400">
                    {formatConversationDate(conversation.updatedAt)}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-4 border-b border-gray-200 bg-white space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              {activeConversation && editingConversationId === activeConversation.id ? (
                <input
                  autoFocus
                  ref={conversationTitleInputRef}
                  value={editingConversationTitle}
                  onChange={(event) => setEditingConversationTitle(event.target.value)}
                  onBlur={() => void submitConversationRename(activeConversation.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void submitConversationRename(activeConversation.id);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelRenamingConversation();
                    }
                  }}
                  className="w-full max-w-[420px] px-2 py-1 text-base font-semibold text-gray-900 border border-hardwario-primary rounded focus:outline-none focus:ring-2 focus:ring-hardwario-primary"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (activeConversation) {
                      startRenamingConversation(activeConversation);
                    }
                  }}
                  className="text-left text-base font-semibold text-gray-900 hover:text-hardwario-primary"
                  title="Rename conversation"
                >
                  {activeConversation ? activeConversation.title : 'AI Chat'}
                </button>
              )}
              <p className="text-xs text-gray-500">
                {activeConversation ? `Updated ${formatConversationDate(activeConversation.updatedAt)}` : 'Create a conversation to get started.'}
              </p>
            </div>
            <div ref={deleteConfirmRef} className="flex-shrink-0">
              {isDeleteConfirmOpen ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 whitespace-nowrap">Delete this conversation?</span>
                  <button
                    type="button"
                    onClick={() => setIsDeleteConfirmOpen(false)}
                    className="h-10 w-10 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors flex items-center justify-center"
                    title="Cancel deletion"
                    aria-label="Cancel deletion"
                  >
                    <FiX className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    disabled={isSending || !activeConversationId || conversations.length === 1}
                    onClick={() => activeConversationId && void handleDeleteConversation(activeConversationId)}
                    className="h-10 w-10 bg-red-50 text-red-700 rounded hover:bg-red-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                    title="Confirm deletion"
                    aria-label="Confirm deletion"
                  >
                    <FiTrash2 className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={isSending || !activeConversationId || conversations.length === 1}
                  onClick={() => setIsDeleteConfirmOpen(true)}
                  className="h-10 w-10 bg-red-50 text-red-700 rounded hover:bg-red-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                  title="Delete conversation"
                  aria-label="Delete conversation"
                >
                  <FiTrash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {(statusText || errorText) && (
            <div className="text-sm">
              {statusText && <p className="text-gray-600">{statusText}</p>}
              {errorText && <p className="text-red-600">{errorText}</p>}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-3">
          {messages.length === 0 ? (
            <div className="h-full flex items-center justify-center text-center px-6">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                  {activeConversation ? activeConversation.title : 'Start a conversation'}
                </h3>
                <p className="text-sm text-gray-500">
                  {isLoadingConversations
                    ? 'Loading conversations...'
                    : 'Save your OpenRouter API key, select a model, and send your first message.'}
                </p>
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] px-4 py-3 rounded-lg shadow-sm break-words ${
                    message.role === 'user'
                      ? 'bg-hardwario-primary text-white'
                      : 'bg-white border border-gray-200 text-gray-900'
                  }`}
                >
                  {message.role === 'assistant'
                    ? <MarkdownMessage content={message.content || (isSending ? '...' : '')} />
                    : <div className="whitespace-pre-wrap">{message.content}</div>}
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={handleSend} className="p-4 border-t border-gray-200 bg-white">
          <div className="flex items-end gap-2">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handlePromptKeyDown}
              rows={3}
              placeholder={hasApiKey ? 'Ask anything in this conversation...' : 'Add OpenRouter API key first'}
              className="flex-1 px-3 py-2 border border-gray-300 bg-white text-gray-900 resize-none focus:outline-none focus:ring-2 focus:ring-hardwario-primary focus:border-transparent"
            />
            {isSending ? (
              <button
                type="button"
                onClick={handleCancel}
                className="h-10 px-4 bg-gray-100 text-gray-700 font-medium rounded hover:bg-gray-200 transition-colors flex items-center gap-2"
              >
                <FiSquare className="w-4 h-4" />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                className="h-10 px-4 bg-hardwario-primary text-white font-medium rounded hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <FiSend className="w-4 h-4" />
                Send
              </button>
            )}
            <button
              type="button"
              onClick={clearChat}
              disabled={isSending || !activeConversationId}
              className="h-10 px-3 bg-gray-100 text-gray-700 font-medium rounded hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Clear conversation"
            >
              <FiTrash2 className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>

      {isOptionsOpen ? (
        <div
          className="absolute inset-0 z-30 bg-black/35 flex justify-end"
          onClick={() => setIsOptionsOpen(false)}
        >
          <div
            className="w-full max-w-[560px] h-full bg-white border-l border-gray-200 shadow-2xl overflow-auto"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Options</h3>
                <p className="text-xs text-gray-500">Chat settings and documentation ingestion controls.</p>
              </div>
              <button
                type="button"
                onClick={() => setIsOptionsOpen(false)}
                className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
                title="Close options"
              >
                <FiX className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div className="rounded border border-gray-200 bg-gray-50 p-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">OpenRouter API Key</label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(event) => setApiKeyInput(event.target.value)}
                    placeholder={hasApiKey ? 'Saved key (enter a new one to replace)' : 'sk-or-v1-...'}
                    className="flex-1 px-3 py-2 border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-hardwario-primary focus:border-transparent"
                  />
                  <button
                    onClick={saveApiKey}
                    className="px-3 py-2 bg-hardwario-primary text-white text-sm font-medium hover:opacity-90 transition-opacity rounded"
                    type="button"
                    title="Save API key"
                  >
                    <FiKey className="w-4 h-4" />
                  </button>
                  <button
                    onClick={clearApiKey}
                    className="px-3 py-2 bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 transition-colors rounded"
                    type="button"
                    title="Clear API key"
                  >
                    <FiTrash2 className="w-4 h-4" />
                  </button>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Key is stored on this device {encryptionAvailable ? 'using OS encryption.' : 'in local app settings (unencrypted fallback).'}
                </p>
                <p className="mt-1 text-xs">
                  <a
                    href="https://openrouter.ai/keys"
                    className="text-hardwario-primary hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      void window.electronAPI.shell.openExternal('https://openrouter.ai/keys');
                    }}
                  >
                    Create or manage OpenRouter key
                  </a>
                </p>
              </div>

              <div className="rounded border border-gray-200 bg-gray-50 p-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                <select
                  value={model}
                  onChange={(event) => void handleModelChange(event.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-hardwario-primary focus:border-transparent"
                >
                  {models.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-500">Use a free model for testing, then switch to GPT-4.1 Mini.</p>
              </div>

              <div className="rounded border border-gray-200 bg-gray-50 p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-gray-900">Documentation Ingestion</h3>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${docsStateBadgeClassName}`}>
                        {docsStateBadgeLabel}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">
                      Local-first testing control for `tower/hardware-modules/` from GitHub, excluding `images/`.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDownloadDocs()}
                    disabled={docsStatus.state === 'running'}
                    className="min-w-[180px] h-10 px-4 bg-gray-900 text-white font-medium rounded hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {docsStatus.state === 'running' ? (
                      <>
                        <FiRefreshCw className="w-4 h-4 animate-spin" />
                        Downloading
                      </>
                    ) : (
                      <>
                        <FiDownload className="w-4 h-4" />
                        {docsActionLabel}
                      </>
                    )}
                  </button>
                </div>
                {(docsStatus.startedAt || docsStatus.finishedAt) ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                    {docsStatus.startedAt ? (
                      <span>Started: {formatConversationDate(docsStatus.startedAt)}</span>
                    ) : null}
                    {docsStatus.finishedAt ? (
                      <span>Finished: {formatConversationDate(docsStatus.finishedAt)}</span>
                    ) : null}
                  </div>
                ) : null}

                <div className="grid grid-cols-1 gap-2 text-xs text-gray-600">
                  <div className="rounded border border-gray-200 bg-white px-3 py-2">
                    <div className="font-medium text-gray-800">Status</div>
                    <div>{docsStatus.message}</div>
                  </div>
                  <div className="rounded border border-gray-200 bg-white px-3 py-2">
                    <div className="font-medium text-gray-800">Progress</div>
                    <div>{docsProgressLabel}</div>
                  </div>
                  <div className="rounded border border-gray-200 bg-white px-3 py-2">
                    <div className="font-medium text-gray-800">Local Availability</div>
                    <div>{docsStatus.hasLocalDocs ? 'Local corpus available on disk' : 'No local corpus yet'}</div>
                  </div>
                  {docsStatus.targetDir ? (
                    <div className="rounded border border-gray-200 bg-white px-3 py-2">
                      <div className="font-medium text-gray-800">Raw Docs Path</div>
                      <div className="font-mono break-all">{docsStatus.targetDir}</div>
                    </div>
                  ) : null}
                  {docsStatus.manifestPath ? (
                    <div className="rounded border border-gray-200 bg-white px-3 py-2">
                      <div className="font-medium text-gray-800">Manifest Path</div>
                      <div className="font-mono break-all">{docsStatus.manifestPath}</div>
                    </div>
                  ) : null}
                </div>

                {docsStatus.error ? (
                  <p className="text-xs text-red-600">
                    {docsStatus.hasLocalDocs
                      ? `Refresh failed, but the previous local corpus is still available: ${docsStatus.error}`
                      : docsStatus.error}
                  </p>
                ) : null}
              </div>

              <div className="rounded border border-gray-200 bg-gray-50 p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-gray-900">Chunk Generation</h3>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${docsChunkingStateBadgeClassName}`}>
                        {docsChunkingStateBadgeLabel}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">
                      Build persisted chunk records directly from the downloaded raw markdown.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleBuildChunks()}
                    disabled={docsChunkingStatus.state === 'running' || !docsStatus.hasLocalDocs}
                    className="min-w-[180px] h-10 px-4 bg-gray-900 text-white font-medium rounded hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {docsChunkingStatus.state === 'running' ? (
                      <>
                        <FiRefreshCw className="w-4 h-4 animate-spin" />
                        Building
                      </>
                    ) : (
                      <>
                        <FiRefreshCw className="w-4 h-4" />
                        {docsChunkingActionLabel}
                      </>
                    )}
                  </button>
                </div>
                {(docsChunkingStatus.startedAt || docsChunkingStatus.finishedAt) ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                    {docsChunkingStatus.startedAt ? (
                      <span>Started: {formatConversationDate(docsChunkingStatus.startedAt)}</span>
                    ) : null}
                    {docsChunkingStatus.finishedAt ? (
                      <span>Finished: {formatConversationDate(docsChunkingStatus.finishedAt)}</span>
                    ) : null}
                  </div>
                ) : null}

                <div className="grid grid-cols-1 gap-2 text-xs text-gray-600">
                  <div className="rounded border border-gray-200 bg-white px-3 py-2">
                    <div className="font-medium text-gray-800">Status</div>
                    <div>{docsChunkingStatus.message}</div>
                  </div>
                  <div className="rounded border border-gray-200 bg-white px-3 py-2">
                    <div className="font-medium text-gray-800">Progress</div>
                    <div>{docsChunkingProgressLabel}</div>
                  </div>
                  <div className="rounded border border-gray-200 bg-white px-3 py-2">
                    <div className="font-medium text-gray-800">Chunk Count</div>
                    <div>{docsChunkingStatus.chunkCount}</div>
                  </div>
                  {docsChunkingStatus.outputPath ? (
                    <div className="rounded border border-gray-200 bg-white px-3 py-2">
                      <div className="font-medium text-gray-800">Chunks Output Path</div>
                      <div className="font-mono break-all">{docsChunkingStatus.outputPath}</div>
                    </div>
                  ) : null}
                  {docsChunkingStatus.manifestPath ? (
                    <div className="rounded border border-gray-200 bg-white px-3 py-2">
                      <div className="font-medium text-gray-800">Chunks Manifest Path</div>
                      <div className="font-mono break-all">{docsChunkingStatus.manifestPath}</div>
                    </div>
                  ) : null}
                </div>

                {docsChunkingStatus.error ? (
                  <p className="text-xs text-red-600">
                    {docsChunkingStatus.hasChunks
                      ? `Chunk rebuild failed, but the previous chunk set is still available: ${docsChunkingStatus.error}`
                      : docsChunkingStatus.error}
                  </p>
                ) : null}
              </div>

              <div className="rounded border border-gray-200 bg-gray-50 p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-gray-900">Embeddings</h3>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${docsEmbeddingsStateBadgeClassName}`}>
                        {docsEmbeddingsStateBadgeLabel}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">
                      Generate a persistent semantic vector index for the current chunk set using OpenRouter embeddings.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleBuildEmbeddings()}
                    disabled={docsEmbeddingsStatus.state === 'running' || !docsChunkingStatus.hasChunks || !hasApiKey}
                    className="min-w-[180px] h-10 px-4 bg-gray-900 text-white font-medium rounded hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {docsEmbeddingsStatus.state === 'running' ? (
                      <>
                        <FiRefreshCw className="w-4 h-4 animate-spin" />
                        Building
                      </>
                    ) : (
                      <>
                        <FiRefreshCw className="w-4 h-4" />
                        {docsEmbeddingsActionLabel}
                      </>
                    )}
                  </button>
                </div>
                {(docsEmbeddingsStatus.startedAt || docsEmbeddingsStatus.finishedAt) ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                    {docsEmbeddingsStatus.startedAt ? (
                      <span>Started: {formatConversationDate(docsEmbeddingsStatus.startedAt)}</span>
                    ) : null}
                    {docsEmbeddingsStatus.finishedAt ? (
                      <span>Finished: {formatConversationDate(docsEmbeddingsStatus.finishedAt)}</span>
                    ) : null}
                  </div>
                ) : null}

                <div className="grid grid-cols-1 gap-2 text-xs text-gray-600">
                  <div className="rounded border border-gray-200 bg-white px-3 py-2">
                    <div className="font-medium text-gray-800">Status</div>
                    <div>{docsEmbeddingsStatus.message}</div>
                  </div>
                  <div className="rounded border border-gray-200 bg-white px-3 py-2">
                    <div className="font-medium text-gray-800">Progress</div>
                    <div>{docsEmbeddingsProgressLabel}</div>
                  </div>
                  <div className="rounded border border-gray-200 bg-white px-3 py-2">
                    <div className="font-medium text-gray-800">Embedding Count</div>
                    <div>{docsEmbeddingsStatus.embeddingCount}</div>
                  </div>
                  <div className="rounded border border-gray-200 bg-white px-3 py-2">
                    <div className="font-medium text-gray-800">Embedding Model</div>
                    <div className="font-mono break-all">{docsEmbeddingsStatus.embeddingModel}</div>
                  </div>
                  {docsEmbeddingsStatus.outputPath ? (
                    <div className="rounded border border-gray-200 bg-white px-3 py-2">
                      <div className="font-medium text-gray-800">Embeddings Output Path</div>
                      <div className="font-mono break-all">{docsEmbeddingsStatus.outputPath}</div>
                    </div>
                  ) : null}
                  {docsEmbeddingsStatus.manifestPath ? (
                    <div className="rounded border border-gray-200 bg-white px-3 py-2">
                      <div className="font-medium text-gray-800">Embeddings Manifest Path</div>
                      <div className="font-mono break-all">{docsEmbeddingsStatus.manifestPath}</div>
                    </div>
                  ) : null}
                </div>

                {docsEmbeddingsStatus.error ? (
                  <p className="text-xs text-red-600">
                    {docsEmbeddingsStatus.hasEmbeddings
                      ? `Embedding rebuild failed, but the previous embedding set is still available: ${docsEmbeddingsStatus.error}`
                      : docsEmbeddingsStatus.error}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
