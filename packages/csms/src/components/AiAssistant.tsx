// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Sparkles, X, Send, Pencil, Copy, Check, RotateCcw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  reply: string;
  apiCallsMade: number;
}

export function AiAssistant(): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (open && textareaRef.current != null) {
      textareaRef.current.focus();
    }
  }, [open]);

  useEffect(() => {
    if (editingIndex != null && editRef.current != null) {
      editRef.current.focus();
      editRef.current.setSelectionRange(editRef.current.value.length, editRef.current.value.length);
    }
  }, [editingIndex]);

  const chatMutation = useMutation({
    mutationFn: (body: { message: string; history: ChatMessage[] }) =>
      api.post<ChatResponse>('/v1/assistant/chat', body),
    onSuccess: (data) => {
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
    },
    onError: (err: unknown) => {
      let errorMessage = t('chatbotAi.error');
      if (err instanceof ApiError) {
        if (err.status === 429) {
          errorMessage = t('chatbotAi.rateLimited');
        } else if (err.status === 400) {
          const body = err.body as { code?: string } | undefined;
          if (body?.code === 'AI_NOT_CONFIGURED') {
            errorMessage = t('chatbotAi.notConfigured');
          }
        }
      }
      setMessages((prev) => [...prev, { role: 'assistant', content: errorMessage }]);
    },
  });

  function sendMessage(text: string, history: ChatMessage[]): void {
    const userMessage: ChatMessage = { role: 'user', content: text };
    setMessages([...history, userMessage]);
    setInput('');
    if (textareaRef.current != null) {
      textareaRef.current.style.height = 'auto';
    }
    chatMutation.mutate({ message: text, history });
  }

  function handleSend(): void {
    const trimmed = input.trim();
    if (trimmed === '' || chatMutation.isPending) return;
    sendMessage(trimmed, messages);
  }

  function handleEditSave(index: number): void {
    const trimmed = editValue.trim();
    if (trimmed === '' || chatMutation.isPending) return;
    // Truncate history to before this message, discard everything after
    const historyBefore = messages.slice(0, index);
    setEditingIndex(null);
    setEditValue('');
    sendMessage(trimmed, historyBefore);
  }

  function handleResend(index: number): void {
    if (chatMutation.isPending) return;
    const msg = messages[index];
    if (msg == null || msg.role !== 'user') return;
    const historyBefore = messages.slice(0, index);
    sendMessage(msg.content, historyBefore);
  }

  function handleCopy(index: number): void {
    const msg = messages[index];
    if (msg == null) return;
    void navigator.clipboard.writeText(msg.content);
    setCopiedIndex(index);
    setTimeout(() => {
      setCopiedIndex(null);
    }, 2000);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleEditKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>, index: number): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleEditSave(index);
    }
    if (e.key === 'Escape') {
      setEditingIndex(null);
      setEditValue('');
    }
  }

  function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>): void {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${String(Math.min(el.scrollHeight, 72))}px`;
  }

  return (
    <>
      {/* Trigger button */}
      {!open && (
        <Button
          variant="default"
          size="icon"
          className="fixed bottom-6 right-6 z-40 rounded-full h-12 w-12 shadow-lg"
          aria-label={t('chatbotAi.title')}
          onClick={() => {
            setOpen(true);
          }}
        >
          <Sparkles className="h-5 w-5" />
        </Button>
      )}

      {/* Chat panel */}
      <div
        className={cn(
          'fixed bottom-0 right-0 h-full w-full sm:w-[400px] z-40 flex flex-col bg-card shadow-lg border-l border-border transition-transform duration-200',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">{t('chatbotAi.title')}</h2>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('common.close')}
            onClick={() => {
              setOpen(false);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              <div className="group relative max-w-[85%]">
                {/* Edit mode for user messages */}
                {editingIndex === i && msg.role === 'user' ? (
                  <div className="flex flex-col gap-1">
                    <textarea
                      ref={editRef}
                      value={editValue}
                      onChange={(e) => {
                        setEditValue(e.target.value);
                      }}
                      onKeyDown={(e) => {
                        handleEditKeyDown(e, i);
                      }}
                      rows={2}
                      className="w-full rounded-lg border border-primary bg-primary/10 px-3 py-2 text-sm resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <div className="flex gap-1 justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={() => {
                          setEditingIndex(null);
                          setEditValue('');
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="h-6 px-2 text-xs"
                        disabled={editValue.trim() === '' || chatMutation.isPending}
                        onClick={() => {
                          handleEditSave(i);
                        }}
                      >
                        Send
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div
                      className={cn(
                        'rounded-lg px-3 py-2 text-sm',
                        msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted',
                      )}
                    >
                      {msg.role === 'assistant' ? (
                        <div className="prose prose-sm dark:prose-invert max-w-none [&_p]:my-0 [&_code]:rounded [&_code]:bg-border/50 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_code]:font-semibold [&_code]:before:content-none [&_code]:after:content-none [&_pre]:my-1 [&_ul]:my-1 [&_li]:my-0 [&_table]:text-xs [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1 [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_td]:border [&_td]:border-border [&_table]:w-max">
                          <div className="overflow-x-auto">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={{
                                a: ({ href, children }) => (
                                  <a
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary underline hover:text-primary/80"
                                  >
                                    {children}
                                  </a>
                                ),
                              }}
                            >
                              {msg.content}
                            </ReactMarkdown>
                          </div>
                        </div>
                      ) : (
                        <span className="whitespace-pre-wrap">{msg.content}</span>
                      )}
                    </div>
                    {/* Action buttons */}
                    <div
                      className={cn(
                        'flex gap-0.5 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity',
                        msg.role === 'user' ? 'justify-end' : 'justify-start',
                      )}
                    >
                      {msg.role === 'user' && (
                        <>
                          <button
                            type="button"
                            className="p-1 rounded hover:bg-muted text-muted-foreground"
                            title="Edit"
                            onClick={() => {
                              setEditingIndex(i);
                              setEditValue(msg.content);
                            }}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            className="p-1 rounded hover:bg-muted text-muted-foreground"
                            title="Resend"
                            onClick={() => {
                              handleResend(i);
                            }}
                          >
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="p-1 rounded hover:bg-muted text-muted-foreground"
                        title="Copy"
                        onClick={() => {
                          handleCopy(i);
                        }}
                      >
                        {copiedIndex === i ? (
                          <Check className="h-3 w-3 text-success" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
          {chatMutation.isPending && (
            <div className="flex justify-start">
              <div className="rounded-lg px-3 py-2 max-w-[80%] bg-muted text-sm text-muted-foreground">
                {t('chatbotAi.typing')}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="flex gap-2 p-4 border-t border-border">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            placeholder={t('chatbotAi.placeholder')}
            rows={1}
            className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            style={{ maxHeight: '72px' }}
          />
          <Button
            size="icon"
            disabled={input.trim() === '' || chatMutation.isPending}
            onClick={handleSend}
            aria-label={t('chatbotAi.send')}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  );
}
