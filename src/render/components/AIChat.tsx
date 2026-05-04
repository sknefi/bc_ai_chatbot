import { FormEvent, KeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { FiDownload, FiKey, FiRefreshCw, FiSend, FiSquare, FiTrash2 } from 'react-icons/fi';
import type { DocsIngestStatus } from '../../../electron/preload';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
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

function renderInlineMarkdown(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~|\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let tokenIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${keyBase}-${tokenIndex++}`;

    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code key={key} className="px-1 py-0.5 bg-gray-200 text-gray-900 rounded text-[0.9em] font-mono">
          {token.slice(1, -1)}
        </code>
      );
    } else if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (linkMatch) {
        const [, label, href] = linkMatch;
        nodes.push(
          <a
            key={key}
            href={href}
            className="text-hardwario-primary hover:underline"
            onClick={(event) => {
              event.preventDefault();
              void window.electronAPI.shell.openExternal(href);
            }}
          >
            {label}
          </a>
        );
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(token);
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function renderParagraph(text: string, keyBase: string) {
  const lines = text.split('\n');
  return lines.map((line, index) => (
    <span key={`${keyBase}-line-${index}`}>
      {renderInlineMarkdown(line, `${keyBase}-inline-${index}`)}
      {index < lines.length - 1 ? <br /> : null}
    </span>
  ));
}

function isUnorderedListLine(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line);
}

function isOrderedListLine(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line);
}

function isHeadingLine(line: string): boolean {
  return /^\s*#{1,6}\s+/.test(line);
}

function isQuoteLine(line: string): boolean {
  return /^\s*>\s?/.test(line);
}

function renderTextBlocks(text: string, keyBase: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let index = 0;
  let blockIndex = 0;

  const isSpecialLine = (line: string) =>
    isHeadingLine(line) || isQuoteLine(line) || isUnorderedListLine(line) || isOrderedListLine(line);

  while (index < lines.length) {
    const line = lines[index];
    if (!line || line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (isHeadingLine(line)) {
      const match = line.match(/^\s*(#{1,6})\s+(.*)$/);
      const level = Math.min(6, match ? match[1].length : 1);
      const content = match ? match[2] : line;
      const title = renderInlineMarkdown(content, `${keyBase}-h-${blockIndex}`);
      const className = level <= 2 ? 'font-semibold text-base' : 'font-semibold text-sm';
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(
        <Tag key={`${keyBase}-heading-${blockIndex++}`} className={className}>
          {title}
        </Tag>
      );
      index += 1;
      continue;
    }

    if (isQuoteLine(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && isQuoteLine(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }

      blocks.push(
        <blockquote
          key={`${keyBase}-quote-${blockIndex++}`}
          className="border-l-2 border-gray-300 pl-3 text-gray-700"
        >
          {renderParagraph(quoteLines.join('\n'), `${keyBase}-quote-content-${blockIndex}`)}
        </blockquote>
      );
      continue;
    }

    if (isUnorderedListLine(line)) {
      const items: string[] = [];
      while (index < lines.length && isUnorderedListLine(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ''));
        index += 1;
      }

      blocks.push(
        <ul key={`${keyBase}-ul-${blockIndex++}`} className="list-disc pl-5 space-y-1">
          {items.map((item, itemIndex) => (
            <li key={`${keyBase}-ul-item-${itemIndex}`}>
              {renderInlineMarkdown(item, `${keyBase}-ul-inline-${itemIndex}`)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    if (isOrderedListLine(line)) {
      const items: string[] = [];
      while (index < lines.length && isOrderedListLine(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }

      blocks.push(
        <ol key={`${keyBase}-ol-${blockIndex++}`} className="list-decimal pl-5 space-y-1">
          {items.map((item, itemIndex) => (
            <li key={`${keyBase}-ol-item-${itemIndex}`}>
              {renderInlineMarkdown(item, `${keyBase}-ol-inline-${itemIndex}`)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index];
      if (!candidate || candidate.trim().length === 0 || isSpecialLine(candidate)) {
        break;
      }
      paragraphLines.push(candidate);
      index += 1;
    }

    blocks.push(
      <p key={`${keyBase}-p-${blockIndex++}`} className="leading-relaxed">
        {renderParagraph(paragraphLines.join('\n'), `${keyBase}-p-content-${blockIndex}`)}
      </p>
    );
  }

  return blocks;
}

function renderMarkdown(content: string, keyBase: string): ReactNode {
  const nodes: ReactNode[] = [];
  const codeRegex = /```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g;
  let cursor = 0;
  let sectionIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeRegex.exec(content)) !== null) {
    const before = content.slice(cursor, match.index);
    if (before.trim().length > 0) {
      nodes.push(
        <div key={`${keyBase}-text-${sectionIndex++}`} className="space-y-2">
          {renderTextBlocks(before, `${keyBase}-text-block-${sectionIndex}`)}
        </div>
      );
    }

    const language = match[1]?.trim();
    const code = (match[2] || '').replace(/\n$/, '');
    nodes.push(
      <div key={`${keyBase}-code-wrap-${sectionIndex++}`} className="rounded-md overflow-hidden border border-gray-300">
        <div className="px-3 py-1 text-xs bg-gray-800 text-gray-300">{language || 'code'}</div>
        <pre className="m-0 p-3 bg-gray-900 text-gray-100 overflow-x-auto text-xs">
          <code>{code}</code>
        </pre>
      </div>
    );

    cursor = codeRegex.lastIndex;
  }

  const tail = content.slice(cursor);
  if (tail.trim().length > 0) {
    nodes.push(
      <div key={`${keyBase}-tail-${sectionIndex++}`} className="space-y-2">
        {renderTextBlocks(tail, `${keyBase}-tail-block-${sectionIndex}`)}
      </div>
    );
  }

  if (nodes.length === 0) {
    return <span>{content}</span>;
  }

  return <div className="space-y-3">{nodes}</div>;
}

export default function AIChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [encryptionAvailable, setEncryptionAvailable] = useState(false);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<{ id: string; label: string; free: boolean }[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [statusText, setStatusText] = useState<string>('');
  const [errorText, setErrorText] = useState<string>('');
  const [docsStatus, setDocsStatus] = useState<DocsIngestStatus>({
    state: 'idle',
    message: 'No documentation downloaded yet.',
    sourceId: 'hardwario-docs',
    targetDir: '',
    manifestPath: '',
    treeSha: '',
    totalFiles: 0,
    completedFiles: 0,
    startedAt: null,
    finishedAt: null,
    error: '',
  });

  const currentRequestIdRef = useRef<string | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

    window.electronAPI.docsIngest
      .getStatus()
      .then((status) => {
        setDocsStatus(status);
      })
      .catch((error) => {
        console.error('Failed to load docs ingestion status.', error);
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

      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? { ...message, content: message.content + payload.delta }
            : message
        )
      );
    });

    const unsubDone = window.electronAPI.aiChat.onDone((payload) => {
      if (payload.requestId !== currentRequestIdRef.current) {
        return;
      }

      setIsSending(false);
      setStatusText('');
      currentRequestIdRef.current = null;
      currentAssistantIdRef.current = null;
    });

    const unsubCancelled = window.electronAPI.aiChat.onCancelled((payload) => {
      if (payload.requestId !== currentRequestIdRef.current) {
        return;
      }

      setIsSending(false);
      setMessages((prev) => dropEmptyAssistant(prev, currentAssistantIdRef.current));
      setStatusText('Generation cancelled.');
      currentRequestIdRef.current = null;
      currentAssistantIdRef.current = null;
    });

    const unsubError = window.electronAPI.aiChat.onError((payload) => {
      if (payload.requestId && payload.requestId !== currentRequestIdRef.current) {
        return;
      }

      setIsSending(false);
      setMessages((prev) => dropEmptyAssistant(prev, currentAssistantIdRef.current));
      setErrorText(payload.error || 'Unknown chat error');
      setStatusText('');
      currentRequestIdRef.current = null;
      currentAssistantIdRef.current = null;
    });

    return () => {
      unsubChunk();
      unsubDone();
      unsubCancelled();
      unsubError();
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSending]);

  useEffect(() => {
    const unsubDocsStatus = window.electronAPI.docsIngest.onStatus((status) => {
      setDocsStatus(status);
    });

    return () => {
      unsubDocsStatus();
    };
  }, []);

  const canSend = useMemo(() => {
    return hasApiKey && !isSending && prompt.trim().length > 0 && model.length > 0;
  }, [hasApiKey, isSending, prompt, model]);

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

  const sendPrompt = () => {
    if (!canSend) {
      return;
    }

    const userContent = prompt.trim();
    const requestId = makeId('req');
    const userMessage: ChatMessage = { id: makeId('u'), role: 'user', content: userContent };
    const assistantMessage: ChatMessage = { id: makeId('a'), role: 'assistant', content: '' };

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

    window.electronAPI.aiChat.send({
      requestId,
      model,
      messages: history,
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
    if (isSending) {
      handleCancel();
    }
    setMessages([]);
    setPrompt('');
    setErrorText('');
    setStatusText('');
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

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="p-4 border-b border-gray-200 bg-white space-y-3">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-3">
          <div>
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

          <div>
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
        </div>

        <div className="rounded border border-gray-200 bg-gray-50 p-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-gray-900">Documentation Ingestion</h3>
              <p className="text-xs text-gray-500">
                Temporary testing control for downloading `tower/hardware-modules/` from GitHub, excluding `images/`.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleDownloadDocs()}
              disabled={docsStatus.state === 'running'}
              className="h-10 px-4 bg-gray-900 text-white font-medium rounded hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {docsStatus.state === 'running' ? (
                <>
                  <FiRefreshCw className="w-4 h-4 animate-spin" />
                  Downloading
                </>
              ) : (
                <>
                  <FiDownload className="w-4 h-4" />
                  Download Docs
                </>
              )}
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 text-xs text-gray-600">
            <div className="rounded border border-gray-200 bg-white px-3 py-2">
              <div className="font-medium text-gray-800">Status</div>
              <div>{docsStatus.message}</div>
            </div>
            <div className="rounded border border-gray-200 bg-white px-3 py-2">
              <div className="font-medium text-gray-800">Progress</div>
              <div>{docsProgressLabel}</div>
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
            <p className="text-xs text-red-600">{docsStatus.error}</p>
          ) : null}
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
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Start a conversation</h3>
              <p className="text-sm text-gray-500">
                Save your OpenRouter API key, select a model, and send your first message.
              </p>
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`max-w-[85%] px-4 py-3 rounded-lg shadow-sm break-words ${
                message.role === 'user'
                  ? 'ml-auto bg-hardwario-primary text-white'
                  : 'mr-auto bg-white border border-gray-200 text-gray-900'
              }`}
            >
              {message.role === 'assistant'
                ? renderMarkdown(message.content || (isSending ? '...' : ''), message.id)
                : <div className="whitespace-pre-wrap">{message.content}</div>}
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
            placeholder={hasApiKey ? 'Ask anything...' : 'Add OpenRouter API key first'}
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
            className="h-10 px-3 bg-gray-100 text-gray-700 font-medium rounded hover:bg-gray-200 transition-colors"
            title="Clear chat"
          >
            <FiTrash2 className="w-4 h-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
