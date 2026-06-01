import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { FiChevronDown, FiChevronRight, FiDownload, FiKey, FiPlus, FiRefreshCw, FiSend, FiSettings, FiSquare, FiTrash2, FiX } from 'react-icons/fi';
import remarkGfm from 'remark-gfm';
import * as i18n from '../../utils/i18n';
import type {
  AIChatConversation,
  AIChatPromptDebugPayload,
  AIChatRelatedLinkGroup,
  AIChatRelatedLinksPayload,
  AIChatStoredMessage,
  DocsChunkingStatus,
  DocsEmbeddingsStatus,
  DocsIngestStatus,
  DocsRetrievalResponse,
} from '../../../electron/preload';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  relatedLinkGroups?: AIChatRelatedLinkGroup[];
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
          a: ({ href, children, ...props }) => {
            const isStoreLink = typeof href === 'string' && href.includes('hardwario.store');

            return (
              <a
                {...props}
                href={href}
                className={isStoreLink
                  ? 'inline-flex items-center rounded-md border border-hardwario-primary/20 bg-blue-50 px-2 py-0.5 font-medium text-hardwario-primary no-underline transition-colors hover:border-hardwario-primary/35 hover:bg-blue-100'
                  : 'text-hardwario-primary underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current'}
                onClick={(event) => {
                  event.preventDefault();
                  if (href) {
                    void window.electronAPI.shell.openExternal(href);
                  }
                }}
              >
                {children}
              </a>
            );
          },
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

function formatPromptDebugTranscript(payload: AIChatPromptDebugPayload): string {
  return payload.messages
    .map((message, index) => {
      return [
        `# Message ${index + 1}`,
        `role: ${message.role}`,
        'content:',
        message.content,
      ].join('\n');
    })
    .join('\n\n');
}

function formatConversationDate(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

const DEFAULT_RETRIEVAL_TOP_K = '6';

export default function AIChat() {
  const t = i18n.__;
  const [openOptionSections, setOpenOptionSections] = useState({
    docs: false,
    chunks: false,
    embeddings: false,
    retrieval: false,
    promptDebug: false,
  });
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
    message: i18n.__('Documentation corpus not downloaded yet.'),
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
    message: i18n.__('Chunks not built yet.'),
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
    message: i18n.__('Embeddings not built yet.'),
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
  const [retrievalQuery, setRetrievalQuery] = useState('');
  const [retrievalTopK, setRetrievalTopK] = useState(DEFAULT_RETRIEVAL_TOP_K);
  const [retrievalResult, setRetrievalResult] = useState<DocsRetrievalResponse | null>(null);
  const [retrievalError, setRetrievalError] = useState('');
  const [isRetrieving, setIsRetrieving] = useState(false);
  const [promptDebugPayload, setPromptDebugPayload] = useState<AIChatPromptDebugPayload | null>(null);
  const [openRelatedLinksByMessageId, setOpenRelatedLinksByMessageId] = useState<Record<string, boolean>>({});

  const currentRequestIdRef = useRef<string | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);
  const currentAssistantContentRef = useRef('');
  const currentAssistantRelatedLinkGroupsRef = useRef<AIChatRelatedLinkGroup[]>([]);
  const currentConversationIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const conversationTitleInputRef = useRef<HTMLInputElement | null>(null);
  const deleteConfirmRef = useRef<HTMLDivElement | null>(null);

  const mapStoredMessage = (message: AIChatStoredMessage): ChatMessage => ({
    id: message.id,
    role: message.role,
    content: message.content,
    relatedLinkGroups: Array.isArray(message.relatedLinkGroups) ? message.relatedLinkGroups : undefined,
    createdAt: message.createdAt,
  });

  const toggleOptionsSection = (section: keyof typeof openOptionSections) => {
    setOpenOptionSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const toggleRelatedLinks = (messageId: string) => {
    setOpenRelatedLinksByMessageId((prev) => ({
      ...prev,
      [messageId]: !prev[messageId],
    }));
  };

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
      relatedLinkGroups: currentAssistantRelatedLinkGroupsRef.current,
    });

    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantId
          ? {
              ...mapStoredMessage(storedMessage),
              relatedLinkGroups: message.relatedLinkGroups,
            }
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
        const message = error instanceof Error ? error.message : t('Failed to load chat configuration.');
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
    const unsubPromptDebug = window.electronAPI.aiChat.onPromptDebug((payload) => {
      setPromptDebugPayload(payload);
    });

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

    const unsubRelatedLinks = window.electronAPI.aiChat.onRelatedLinks((payload: AIChatRelatedLinksPayload) => {
      if (payload.requestId !== currentRequestIdRef.current) {
        return;
      }

      const assistantId = currentAssistantIdRef.current;
      if (!assistantId) {
        return;
      }

      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? { ...message, relatedLinkGroups: payload.groups }
            : message
        )
      );
      currentAssistantRelatedLinkGroupsRef.current = payload.groups;
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
      currentAssistantRelatedLinkGroupsRef.current = [];
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
        finalizeStreamingState(t('Generation cancelled.'));
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
        finalizeStreamingState('', payload.error || t('Unknown chat error'));
      });
    });

    return () => {
      unsubPromptDebug();
      unsubChunk();
      unsubRelatedLinks();
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
      setErrorText(t('OpenRouter API key cannot be empty.'));
      return;
    }

    try {
      await window.electronAPI.aiChat.setApiKey(trimmed);
      setHasApiKey(true);
      setApiKeyInput('');
      setErrorText('');
      setStatusText(t('API key saved.'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('Failed to save API key.');
      setErrorText(message);
    }
  };

  const clearApiKey = async () => {
    try {
      await window.electronAPI.aiChat.clearApiKey();
      setHasApiKey(false);
      setApiKeyInput('');
      setStatusText(t('API key removed.'));
      setErrorText('');
    } catch (error) {
      const message = error instanceof Error ? error.message : t('Failed to clear API key.');
      setErrorText(message);
    }
  };

  const handleModelChange = async (value: string) => {
    setModel(value);
    try {
      const result = await window.electronAPI.aiChat.setModel(value);
      setModel(result.model);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('Failed to save selected model.');
      setErrorText(message);
    }
  };

  const handleDownloadDocs = async () => {
    try {
      const status = await window.electronAPI.docsIngest.downloadHardwareDocs();
      setDocsStatus(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('Failed to start documentation download.');
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
      const message = error instanceof Error ? error.message : t('Failed to start chunk build.');
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
      const message = error instanceof Error ? error.message : t('Failed to start embedding build.');
      setDocsEmbeddingsStatus((prev) => ({
        ...prev,
        state: 'error',
        message,
        error: message,
      }));
    }
  };

  const handleRetrieveChunks = async () => {
    const query = retrievalQuery.trim();
    if (!query) {
      setRetrievalError(t('Retrieval query cannot be empty.'));
      return;
    }

    setIsRetrieving(true);
    setRetrievalError('');

    try {
      const result = await window.electronAPI.docsRetrieval.retrieveChunks({
        query,
        topK: Number(retrievalTopK) || Number(DEFAULT_RETRIEVAL_TOP_K),
      });
      setRetrievalResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('Failed to retrieve chunks.');
      setRetrievalError(message);
      setRetrievalResult(null);
    } finally {
      setIsRetrieving(false);
    }
  };

  const handleRetrievalQueryKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleRetrieveChunks();
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
      setErrorText(t('Conversation name cannot be empty.'));
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
      const message = error instanceof Error ? error.message : t('Failed to rename the conversation.');
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
      setStatusText(t('Generating response...'));
      currentRequestIdRef.current = requestId;
      currentAssistantIdRef.current = assistantMessage.id;
      currentConversationIdRef.current = activeConversationId;
      currentAssistantContentRef.current = '';
      currentAssistantRelatedLinkGroupsRef.current = [];

      await syncConversationList();

      window.electronAPI.aiChat.send({
        requestId,
        model,
        messages: history,
      });
    }).catch((error) => {
      const message = error instanceof Error ? error.message : t('Failed to save the user message.');
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
      const message = error instanceof Error ? error.message : t('Failed to clear the conversation.');
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
    ? `${docsStatus.completedFiles}/${docsStatus.totalFiles} ${t('files')}`
    : t('No files downloaded yet');
  const docsActionLabel = docsStatus.hasLocalDocs ? t('Refresh Docs') : t('Download Docs');
  const docsStateBadgeClassName = docsStatus.state === 'running'
    ? 'bg-amber-100 text-amber-800'
    : docsStatus.hasLocalDocs
      ? 'bg-green-100 text-green-800'
      : docsStatus.state === 'error'
        ? 'bg-red-100 text-red-800'
        : 'bg-gray-200 text-gray-700';
  const docsStateBadgeLabel = docsStatus.state === 'running'
    ? t('Downloading')
    : docsStatus.hasLocalDocs
      ? t('Ready')
      : docsStatus.state === 'error'
        ? t('Unavailable')
        : t('Missing');
  const docsChunkingProgressLabel = docsChunkingStatus.totalFiles > 0
    ? `${docsChunkingStatus.completedFiles}/${docsChunkingStatus.totalFiles} ${t('files')}`
    : t('No chunks built yet');
  const docsChunkingActionLabel = docsChunkingStatus.hasChunks ? t('Rebuild Chunks') : t('Build Chunks');
  const docsChunkingStateBadgeClassName = docsChunkingStatus.state === 'running'
    ? 'bg-amber-100 text-amber-800'
    : docsChunkingStatus.hasChunks
      ? 'bg-green-100 text-green-800'
      : docsChunkingStatus.state === 'error'
        ? 'bg-red-100 text-red-800'
        : 'bg-gray-200 text-gray-700';
  const docsChunkingStateBadgeLabel = docsChunkingStatus.state === 'running'
    ? t('Building')
    : docsChunkingStatus.hasChunks
      ? t('Ready')
      : docsChunkingStatus.state === 'error'
        ? t('Unavailable')
        : t('Missing');
  const docsEmbeddingsProgressLabel = docsEmbeddingsStatus.totalChunks > 0
    ? `${docsEmbeddingsStatus.completedChunks}/${docsEmbeddingsStatus.totalChunks} ${t('chunks')}`
    : t('No embeddings built yet');
  const docsEmbeddingsActionLabel = docsEmbeddingsStatus.hasEmbeddings ? t('Rebuild Embeddings') : t('Build Embeddings');
  const docsEmbeddingsStateBadgeClassName = docsEmbeddingsStatus.state === 'running'
    ? 'bg-amber-100 text-amber-800'
    : docsEmbeddingsStatus.hasEmbeddings
      ? 'bg-green-100 text-green-800'
      : docsEmbeddingsStatus.state === 'error'
        ? 'bg-red-100 text-red-800'
        : 'bg-gray-200 text-gray-700';
  const docsEmbeddingsStateBadgeLabel = docsEmbeddingsStatus.state === 'running'
    ? t('Building')
    : docsEmbeddingsStatus.hasEmbeddings
      ? t('Ready')
      : docsEmbeddingsStatus.state === 'error'
        ? t('Unavailable')
        : t('Missing');
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) || null;

  return (
    <div className="h-full flex bg-gray-50">
      <aside className="w-[260px] border-r border-gray-200 bg-white flex flex-col">
        <div className="p-3 border-b border-gray-200 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">{t('Conversations')}</h3>
            <p className="text-xs text-gray-500">{t('Stored locally in SQLite on this device.')}</p>
          </div>
          <button
            type="button"
            onClick={() => void handleCreateConversation()}
            disabled={isSending}
            className="w-full h-10 px-3 bg-hardwario-primary text-white font-medium rounded hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <FiPlus className="w-4 h-4" />
            {t('New Chat')}
          </button>
          <button
            type="button"
            onClick={() => setIsOptionsOpen(true)}
            className="w-full h-10 px-3 bg-gray-100 text-gray-700 font-medium rounded hover:bg-gray-200 transition-colors flex items-center justify-center gap-2"
          >
            <FiSettings className="w-4 h-4" />
            {t('Options')}
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
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-gray-900 truncate">{conversation.title}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {conversation.lastMessagePreview || t('No messages yet')}
                    </div>
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
                  title={t('Rename conversation')}
                >
                  {activeConversation ? activeConversation.title : t('AI Chat')}
                </button>
              )}
              <p className="text-xs text-gray-500">
                {activeConversation ? `${t('Updated')} ${formatConversationDate(activeConversation.updatedAt)}` : t('Create a conversation to get started.')}
              </p>
            </div>
            <div ref={deleteConfirmRef} className="flex-shrink-0">
              {isDeleteConfirmOpen ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 whitespace-nowrap">{t('Delete this conversation?')}</span>
                  <button
                    type="button"
                    onClick={() => setIsDeleteConfirmOpen(false)}
                    className="h-10 w-10 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors flex items-center justify-center"
                    title={t('Cancel deletion')}
                    aria-label={t('Cancel deletion')}
                  >
                    <FiX className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    disabled={isSending || !activeConversationId || conversations.length === 1}
                    onClick={() => activeConversationId && void handleDeleteConversation(activeConversationId)}
                    className="h-10 w-10 bg-red-50 text-red-700 rounded hover:bg-red-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                    title={t('Confirm deletion')}
                    aria-label={t('Confirm deletion')}
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
                  title={t('Delete conversation')}
                  aria-label={t('Delete conversation')}
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
                  {activeConversation ? activeConversation.title : t('Start a conversation')}
                </h3>
                <p className="text-sm text-gray-500">
                  {isLoadingConversations
                    ? t('Loading conversations...')
                    : t('Save your OpenRouter API key, select a model, and send your first message.')}
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
                  {message.role === 'assistant' && message.relatedLinkGroups && message.relatedLinkGroups.length > 0 ? (
                    <div className="mt-3 border-t border-gray-200 pt-3">
                      <button
                        type="button"
                        onClick={() => toggleRelatedLinks(message.id)}
                        className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-hardwario-primary transition-colors"
                      >
                        {openRelatedLinksByMessageId[message.id] ? (
                          <FiChevronDown className="w-4 h-4" />
                        ) : (
                          <FiChevronRight className="w-4 h-4" />
                        )}
                        {t('Related links')}
                      </button>
                      {openRelatedLinksByMessageId[message.id] ? (
                        <div className="mt-3 space-y-3">
                          {message.relatedLinkGroups.map((group) => (
                            <div key={`${message.id}-${group.title}`} className="space-y-2">
                              <div className="text-sm font-semibold text-gray-900">{group.title}</div>
                              <div className="space-y-2">
                                {group.links.map((link) => (
                                  <button
                                    key={`${message.id}-${group.title}-${link.url}`}
                                    type="button"
                                    onClick={() => void window.electronAPI.shell.openExternal(link.url)}
                                    className="block w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-left hover:bg-gray-100 transition-colors"
                                    title={link.url}
                                  >
                                    <div className="text-sm font-medium text-hardwario-primary">{link.label}</div>
                                    <div className="mt-1 font-mono text-[11px] text-gray-500 break-all">{link.url}</div>
                                  </button>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
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
              placeholder={hasApiKey ? t('Ask anything in this conversation...') : t('Add OpenRouter API key first')}
              className="flex-1 px-3 py-2 border border-gray-300 bg-white text-gray-900 resize-none focus:outline-none focus:ring-2 focus:ring-hardwario-primary focus:border-transparent"
            />
            {isSending ? (
              <button
                type="button"
                onClick={handleCancel}
                className="h-10 px-4 bg-gray-100 text-gray-700 font-medium rounded hover:bg-gray-200 transition-colors flex items-center gap-2"
              >
                <FiSquare className="w-4 h-4" />
                {t('Stop')}
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                className="h-10 px-4 bg-hardwario-primary text-white font-medium rounded hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <FiSend className="w-4 h-4" />
                {t('Send')}
              </button>
            )}
            <button
              type="button"
              onClick={clearChat}
              disabled={isSending || !activeConversationId}
              className="h-10 px-3 bg-gray-100 text-gray-700 font-medium rounded hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={t('Clear conversation')}
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
                <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">{t('Options')}</h3>
                <p className="text-xs text-gray-500">{t('Chat settings and documentation ingestion controls.')}</p>
              </div>
              <button
                type="button"
                onClick={() => setIsOptionsOpen(false)}
                className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
                title={t('Close options')}
              >
                <FiX className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div className="rounded border border-gray-200 bg-gray-50 p-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('OpenRouter API Key')}</label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(event) => setApiKeyInput(event.target.value)}
                    placeholder={hasApiKey ? t('Saved key (enter a new one to replace)') : 'sk-or-v1-...'}
                    className="flex-1 px-3 py-2 border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-hardwario-primary focus:border-transparent"
                  />
                  <button
                    onClick={saveApiKey}
                    className="px-3 py-2 bg-hardwario-primary text-white text-sm font-medium hover:opacity-90 transition-opacity rounded"
                    type="button"
                    title={t('Save API key')}
                  >
                    <FiKey className="w-4 h-4" />
                  </button>
                  <button
                    onClick={clearApiKey}
                    className="px-3 py-2 bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 transition-colors rounded"
                    type="button"
                    title={t('Clear API key')}
                  >
                    <FiTrash2 className="w-4 h-4" />
                  </button>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {encryptionAvailable
                    ? t('Key is stored on this device using OS encryption.')
                    : t('Key is stored on this device in local app settings (unencrypted fallback).')}
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
                    {t('Create or manage OpenRouter key')}
                  </a>
                </p>
              </div>

              <div className="rounded border border-gray-200 bg-gray-50 p-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('Model')}</label>
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
                <p className="mt-1 text-xs text-gray-500">{t('Use a free model for testing, then switch to GPT-4.1 Mini.')}</p>
              </div>

              <div className="rounded border border-gray-200 bg-gray-50 p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => toggleOptionsSection('docs')}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      {openOptionSections.docs ? (
                        <FiChevronDown className="w-4 h-4 text-gray-500 shrink-0" />
                      ) : (
                        <FiChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
                      )}
                      <h3 className="text-sm font-medium text-gray-900">{t('Documentation Ingestion')}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${docsStateBadgeClassName}`}>
                        {docsStateBadgeLabel}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      {t('Local-first testing control for `tower/hardware-modules/` from GitHub, excluding `images/`.')}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDownloadDocs()}
                    disabled={docsStatus.state === 'running'}
                    className="min-w-[180px] h-10 px-4 bg-gray-900 text-white font-medium rounded hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {docsStatus.state === 'running' ? (
                      <>
                        <FiRefreshCw className="w-4 h-4 animate-spin" />
                        {t('Downloading')}
                      </>
                    ) : (
                      <>
                        <FiDownload className="w-4 h-4" />
                        {docsActionLabel}
                      </>
                    )}
                  </button>
                </div>
                {openOptionSections.docs && (docsStatus.startedAt || docsStatus.finishedAt) ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                    {docsStatus.startedAt ? (
                      <span>{t('Started')}: {formatConversationDate(docsStatus.startedAt)}</span>
                    ) : null}
                    {docsStatus.finishedAt ? (
                      <span>{t('Finished')}: {formatConversationDate(docsStatus.finishedAt)}</span>
                    ) : null}
                  </div>
                ) : null}

                {openOptionSections.docs ? (
                  <>
                    <div className="grid grid-cols-1 gap-2 text-xs text-gray-600">
                      <div className="rounded border border-gray-200 bg-white px-3 py-2">
                        <div className="font-medium text-gray-800">{t('Status')}</div>
                        <div>{docsStatus.message}</div>
                      </div>
                      <div className="rounded border border-gray-200 bg-white px-3 py-2">
                        <div className="font-medium text-gray-800">{t('Progress')}</div>
                        <div>{docsProgressLabel}</div>
                      </div>
                      <div className="rounded border border-gray-200 bg-white px-3 py-2">
                        <div className="font-medium text-gray-800">{t('Local Availability')}</div>
                        <div>{docsStatus.hasLocalDocs ? t('Local corpus available on disk') : t('No local corpus yet')}</div>
                      </div>
                      {docsStatus.targetDir ? (
                        <div className="rounded border border-gray-200 bg-white px-3 py-2">
                          <div className="font-medium text-gray-800">{t('Raw Docs Path')}</div>
                          <div className="font-mono break-all">{docsStatus.targetDir}</div>
                        </div>
                      ) : null}
                      {docsStatus.manifestPath ? (
                        <div className="rounded border border-gray-200 bg-white px-3 py-2">
                          <div className="font-medium text-gray-800">{t('Manifest Path')}</div>
                          <div className="font-mono break-all">{docsStatus.manifestPath}</div>
                        </div>
                      ) : null}
                    </div>

                    {docsStatus.error ? (
                      <p className="text-xs text-red-600">
                        {docsStatus.hasLocalDocs
                          ? `${t('Refresh failed, but the previous local corpus is still available:')} ${docsStatus.error}`
                          : docsStatus.error}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>

              <div className="rounded border border-gray-200 bg-gray-50 p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => toggleOptionsSection('chunks')}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      {openOptionSections.chunks ? (
                        <FiChevronDown className="w-4 h-4 text-gray-500 shrink-0" />
                      ) : (
                        <FiChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
                      )}
                      <h3 className="text-sm font-medium text-gray-900">{t('Chunk Generation')}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${docsChunkingStateBadgeClassName}`}>
                        {docsChunkingStateBadgeLabel}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      {t('Build persisted chunk records directly from the downloaded raw markdown.')}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleBuildChunks()}
                    disabled={docsChunkingStatus.state === 'running' || !docsStatus.hasLocalDocs}
                    className="min-w-[180px] h-10 px-4 bg-gray-900 text-white font-medium rounded hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {docsChunkingStatus.state === 'running' ? (
                      <>
                        <FiRefreshCw className="w-4 h-4 animate-spin" />
                        {t('Building')}
                      </>
                    ) : (
                      <>
                        <FiRefreshCw className="w-4 h-4" />
                        {docsChunkingActionLabel}
                      </>
                    )}
                  </button>
                </div>
                {openOptionSections.chunks && (docsChunkingStatus.startedAt || docsChunkingStatus.finishedAt) ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                    {docsChunkingStatus.startedAt ? (
                      <span>{t('Started')}: {formatConversationDate(docsChunkingStatus.startedAt)}</span>
                    ) : null}
                    {docsChunkingStatus.finishedAt ? (
                      <span>{t('Finished')}: {formatConversationDate(docsChunkingStatus.finishedAt)}</span>
                    ) : null}
                  </div>
                ) : null}

                {openOptionSections.chunks ? (
                  <>
                    <div className="grid grid-cols-1 gap-2 text-xs text-gray-600">
                      <div className="rounded border border-gray-200 bg-white px-3 py-2">
                        <div className="font-medium text-gray-800">{t('Status')}</div>
                        <div>{docsChunkingStatus.message}</div>
                      </div>
                      <div className="rounded border border-gray-200 bg-white px-3 py-2">
                        <div className="font-medium text-gray-800">{t('Progress')}</div>
                        <div>{docsChunkingProgressLabel}</div>
                      </div>
                      <div className="rounded border border-gray-200 bg-white px-3 py-2">
                        <div className="font-medium text-gray-800">{t('Chunk Count')}</div>
                        <div>{docsChunkingStatus.chunkCount}</div>
                      </div>
                      {docsChunkingStatus.outputPath ? (
                        <div className="rounded border border-gray-200 bg-white px-3 py-2">
                          <div className="font-medium text-gray-800">{t('Chunks Output Path')}</div>
                          <div className="font-mono break-all">{docsChunkingStatus.outputPath}</div>
                        </div>
                      ) : null}
                      {docsChunkingStatus.manifestPath ? (
                        <div className="rounded border border-gray-200 bg-white px-3 py-2">
                          <div className="font-medium text-gray-800">{t('Chunks Manifest Path')}</div>
                          <div className="font-mono break-all">{docsChunkingStatus.manifestPath}</div>
                        </div>
                      ) : null}
                    </div>

                    {docsChunkingStatus.error ? (
                      <p className="text-xs text-red-600">
                        {docsChunkingStatus.hasChunks
                          ? `${t('Chunk rebuild failed, but the previous chunk set is still available:')} ${docsChunkingStatus.error}`
                          : docsChunkingStatus.error}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>

              <div className="rounded border border-gray-200 bg-gray-50 p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => toggleOptionsSection('embeddings')}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      {openOptionSections.embeddings ? (
                        <FiChevronDown className="w-4 h-4 text-gray-500 shrink-0" />
                      ) : (
                        <FiChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
                      )}
                      <h3 className="text-sm font-medium text-gray-900">{t('Embeddings')}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${docsEmbeddingsStateBadgeClassName}`}>
                        {docsEmbeddingsStateBadgeLabel}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      {t('Generate a persistent semantic vector index for the current chunk set using OpenRouter embeddings.')}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleBuildEmbeddings()}
                    disabled={docsEmbeddingsStatus.state === 'running' || !docsChunkingStatus.hasChunks || !hasApiKey}
                    className="min-w-[180px] h-10 px-4 bg-gray-900 text-white font-medium rounded hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {docsEmbeddingsStatus.state === 'running' ? (
                      <>
                        <FiRefreshCw className="w-4 h-4 animate-spin" />
                        {t('Building')}
                      </>
                    ) : (
                      <>
                        <FiRefreshCw className="w-4 h-4" />
                        {docsEmbeddingsActionLabel}
                      </>
                    )}
                  </button>
                </div>
                {openOptionSections.embeddings && (docsEmbeddingsStatus.startedAt || docsEmbeddingsStatus.finishedAt) ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                    {docsEmbeddingsStatus.startedAt ? (
                      <span>{t('Started')}: {formatConversationDate(docsEmbeddingsStatus.startedAt)}</span>
                    ) : null}
                    {docsEmbeddingsStatus.finishedAt ? (
                      <span>{t('Finished')}: {formatConversationDate(docsEmbeddingsStatus.finishedAt)}</span>
                    ) : null}
                  </div>
                ) : null}

                {openOptionSections.embeddings ? (
                  <>
                    <div className="grid grid-cols-1 gap-2 text-xs text-gray-600">
                      <div className="rounded border border-gray-200 bg-white px-3 py-2">
                        <div className="font-medium text-gray-800">{t('Status')}</div>
                        <div>{docsEmbeddingsStatus.message}</div>
                      </div>
                      <div className="rounded border border-gray-200 bg-white px-3 py-2">
                        <div className="font-medium text-gray-800">{t('Progress')}</div>
                        <div>{docsEmbeddingsProgressLabel}</div>
                      </div>
                      <div className="rounded border border-gray-200 bg-white px-3 py-2">
                        <div className="font-medium text-gray-800">{t('Embedding Count')}</div>
                        <div>{docsEmbeddingsStatus.embeddingCount}</div>
                      </div>
                      <div className="rounded border border-gray-200 bg-white px-3 py-2">
                        <div className="font-medium text-gray-800">{t('Embedding Model')}</div>
                        <div className="font-mono break-all">{docsEmbeddingsStatus.embeddingModel}</div>
                      </div>
                      {docsEmbeddingsStatus.outputPath ? (
                        <div className="rounded border border-gray-200 bg-white px-3 py-2">
                          <div className="font-medium text-gray-800">{t('Embeddings Output Path')}</div>
                          <div className="font-mono break-all">{docsEmbeddingsStatus.outputPath}</div>
                        </div>
                      ) : null}
                      {docsEmbeddingsStatus.manifestPath ? (
                        <div className="rounded border border-gray-200 bg-white px-3 py-2">
                          <div className="font-medium text-gray-800">{t('Embeddings Manifest Path')}</div>
                          <div className="font-mono break-all">{docsEmbeddingsStatus.manifestPath}</div>
                        </div>
                      ) : null}
                    </div>

                    {docsEmbeddingsStatus.error ? (
                      <p className="text-xs text-red-600">
                        {docsEmbeddingsStatus.hasEmbeddings
                          ? `${t('Embedding rebuild failed, but the previous embedding set is still available:')} ${docsEmbeddingsStatus.error}`
                          : docsEmbeddingsStatus.error}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>

              <div className="rounded border border-gray-200 bg-gray-50 p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => toggleOptionsSection('retrieval')}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      {openOptionSections.retrieval ? (
                        <FiChevronDown className="w-4 h-4 text-gray-500 shrink-0" />
                      ) : (
                        <FiChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
                      )}
                      <h3 className="text-sm font-medium text-gray-900">{t('Semantic Retrieval')}</h3>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      {t('Test query embedding and top-k chunk retrieval against the stored semantic index.')}
                    </p>
                  </button>
                </div>

                {openOptionSections.retrieval ? (
                  <>
                    <div className="space-y-2">
                      <textarea
                        value={retrievalQuery}
                        onChange={(event) => setRetrievalQuery(event.target.value)}
                        onKeyDown={handleRetrievalQueryKeyDown}
                        placeholder={t('Ask a hardware question for retrieval testing...')}
                        rows={3}
                        className="w-full px-3 py-2 border border-gray-300 bg-white text-gray-900 resize-y focus:outline-none focus:ring-2 focus:ring-hardwario-primary focus:border-transparent"
                      />
                      <div className="flex flex-wrap items-start gap-2">
                        <label className="flex items-center gap-2 text-xs text-gray-600">
                          <span className="whitespace-nowrap">{t('Top-K')}</span>
                          <input
                            type="number"
                            min={1}
                            max={20}
                            value={retrievalTopK}
                            onChange={(event) => setRetrievalTopK(event.target.value)}
                            className="w-24 px-3 py-2 border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-hardwario-primary focus:border-transparent"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => void handleRetrieveChunks()}
                          disabled={isRetrieving || !docsEmbeddingsStatus.hasEmbeddings}
                          className="h-10 px-4 bg-gray-900 text-white font-medium rounded hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                          {isRetrieving ? (
                            <>
                              <FiRefreshCw className="w-4 h-4 animate-spin" />
                              {t('Retrieving')}
                            </>
                          ) : (
                            t('Retrieve Chunks')
                          )}
                        </button>
                      </div>
                    </div>

                    {retrievalError ? (
                      <p className="text-xs text-red-600">{retrievalError}</p>
                    ) : null}

                    {retrievalResult ? (
                      <div className="space-y-2">
                        <div className="text-xs text-gray-600">
                          {t('Returned')} {retrievalResult.resultCount} {t('chunks using')} `{retrievalResult.embeddingModel}`.
                        </div>
                        <div className="space-y-2">
                          {retrievalResult.results.map((result, index) => (
                            <div key={result.chunkId} className="rounded border border-gray-200 bg-white p-3 text-xs text-gray-700 space-y-2">
                              <div className="flex items-center justify-between gap-3">
                                <div className="font-medium text-gray-900">
                                  {index + 1}. {result.title} / {result.heading}
                                </div>
                                <div className="font-mono text-gray-500">
                                  {t('score')} {result.score.toFixed(4)}
                                </div>
                              </div>
                              <div className="font-mono break-all text-gray-500">{result.path}</div>
                              <div className="line-clamp-6 whitespace-pre-wrap">{result.text}</div>
                              {result.relatedLinks.length > 0 ? (
                                <div className="flex flex-wrap gap-2">
                                  {result.relatedLinks.map((link) => (
                                    <button
                                      key={`${result.chunkId}-${link.url}`}
                                      type="button"
                                      onClick={() => void window.electronAPI.shell.openExternal(link.url)}
                                      className="px-2 py-1 rounded border border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100 transition-colors"
                                      title={link.url}
                                    >
                                      {link.label.replace(/\*\*/g, '')}
                                    </button>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>

              <div className="rounded border border-gray-200 bg-gray-50 p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => toggleOptionsSection('promptDebug')}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      {openOptionSections.promptDebug ? (
                        <FiChevronDown className="w-4 h-4 text-gray-500 shrink-0" />
                      ) : (
                        <FiChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
                      )}
                      <h3 className="text-sm font-medium text-gray-900">{t('Prompt Debug')}</h3>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      {t('Inspect the exact augmented payload that was sent to the model for the last chat request.')}
                    </p>
                  </button>
                </div>

                {openOptionSections.promptDebug ? (
                  <>
                    {promptDebugPayload ? (
                      <div className="space-y-2">
                        <div className="grid grid-cols-1 gap-2 text-xs text-gray-600">
                          <div className="rounded border border-gray-200 bg-white px-3 py-2">
                            <div className="font-medium text-gray-800">{t('Request ID')}</div>
                            <div className="font-mono break-all">{promptDebugPayload.requestId}</div>
                          </div>
                          <div className="rounded border border-gray-200 bg-white px-3 py-2">
                            <div className="font-medium text-gray-800">{t('Model')}</div>
                            <div className="font-mono break-all">{promptDebugPayload.model}</div>
                          </div>
                          <div className="rounded border border-gray-200 bg-white px-3 py-2">
                            <div className="font-medium text-gray-800">{t('Retrieval Top K')}</div>
                            <div>{promptDebugPayload.retrievalTopK}</div>
                          </div>
                          <div className="rounded border border-gray-200 bg-white px-3 py-2">
                            <div className="font-medium text-gray-800">{t('Message Count')}</div>
                            <div>{promptDebugPayload.messages.length}</div>
                          </div>
                        </div>

                        <div className="rounded border border-gray-200 bg-white p-3">
                          <div className="mb-2 text-xs font-medium text-gray-800">{t('Exact Messages Sent To AI')}</div>
                          <pre className="mb-3 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded bg-gray-950 p-3 text-[11px] leading-relaxed text-gray-100">
                            {formatPromptDebugTranscript(promptDebugPayload)}
                          </pre>

                          <div className="mb-2 text-xs font-medium text-gray-800">{t('Raw Payload JSON')}</div>
                          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded bg-gray-950 p-3 text-[11px] leading-relaxed text-gray-100">
                            {JSON.stringify(promptDebugPayload, null, 2)}
                          </pre>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500">{t('Send a chat message first. The exact payload sent to the model will appear here.')}</p>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
