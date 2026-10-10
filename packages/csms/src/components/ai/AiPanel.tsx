// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { History, Plus, Send, Sparkles, Square, Upload, X } from 'lucide-react';
import type { AiStreamEvent } from '@evtivity/lib/ai-stream';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { api, getApiErrorCode } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { cn } from '@/lib/utils';
import {
  applyAiStreamEvent,
  emptyAssistantMessage,
  finishInterrupted,
  messagesFromHistory,
  userMessage,
} from './ai-turn';
import type { AiAttachmentChip, AiMessageView, StoredAiMessage } from './ai-turn';
import { deleteAiAttachment, uploadAiAttachment } from './ai-attachments';
import {
  AttachmentPickerButton,
  AttachmentPreviews,
  addPendingFiles,
  releasePreview,
  useReleasePreviews,
} from './AttachmentPicker';
import type { PendingAttachment } from './AttachmentPicker';
import { AI_CONVERSATIONS_KEY, ConversationList } from './ConversationList';
import type { AiConversationItem } from './ConversationList';
import { MessageList } from './MessageList';
import { SuggestedPrompts } from './SuggestedPrompts';
import { useAiStream } from './use-ai-stream';
import type { AiStreamOutcome } from './use-ai-stream';

const conversationPath = (id: string): string =>
  `/v1/assistant/conversations/${encodeURIComponent(id)}`;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface AiPanelProps {
  onClose: () => void;
}

/**
 * The AI assistant panel (plan 3.10): streaming chat with Stop, tool steps,
 * write confirmation, attachments, conversation history and suggested prompts.
 * Full screen below `md`, a side panel above.
 */
export function AiPanel({ onClose }: AiPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('aiAssistant:write');
  const { run, stop, streaming } = useAiStream();

  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiMessageView[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [panelError, setPanelError] = useState<unknown>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useReleasePreviews(attachments);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const uploading = attachments.some((a) => a.status === 'uploading');
  const busy = streaming;

  const updateMessage = useCallback((key: string, update: (m: AiMessageView) => AiMessageView) => {
    setMessages((prev) => prev.map((m) => (m.key === key ? update(m) : m)));
  }, []);

  /** Streams one turn into a new assistant message. */
  const streamInto = useCallback(
    async (path: string, body: unknown): Promise<AiStreamOutcome> => {
      const assistant = emptyAssistantMessage();
      setMessages((prev) => [...prev, assistant]);
      const outcome = await run(path, body, (event: AiStreamEvent) => {
        updateMessage(assistant.key, (m) => applyAiStreamEvent(m, event));
      });
      if (outcome.kind === 'failed') {
        const code = getApiErrorCode(outcome.error) ?? 'AI_ERROR';
        updateMessage(assistant.key, (m) => finishInterrupted({ ...m, errorCode: code }, false));
      } else {
        updateMessage(assistant.key, (m) => finishInterrupted(m, outcome.kind === 'stopped'));
      }
      void queryClient.invalidateQueries({ queryKey: AI_CONVERSATIONS_KEY });
      return outcome;
    },
    [run, updateMessage, queryClient],
  );

  async function ensureConversation(): Promise<string> {
    if (conversationId != null) return conversationId;
    const created = await api.post<AiConversationItem>('/v1/assistant/conversations', {});
    setConversationId(created.id);
    void queryClient.invalidateQueries({ queryKey: AI_CONVERSATIONS_KEY });
    return created.id;
  }

  /** Uploads one queued file; the server sniffs and sanitizes it on confirm. */
  async function uploadOne(att: PendingAttachment): Promise<void> {
    try {
      const stored = await uploadAiAttachment(att.file);
      setAttachments((prev) =>
        prev.map((a) =>
          a.localId === att.localId ? { ...a, status: 'ready', attachmentId: stored.id } : a,
        ),
      );
    } catch (err) {
      console.warn('Upload an AI attachment failed', err);
      setAttachments((prev) =>
        prev.map((a) =>
          a.localId === att.localId
            ? {
                ...a,
                status: 'error',
                error: 'ai.attachmentErrors.uploadFailed',
                errorCode: getApiErrorCode(err),
              }
            : a,
        ),
      );
    }
  }

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '' || busy || uploading || !canWrite) return;
    setPanelError(null);
    let id: string;
    try {
      id = await ensureConversation();
    } catch (err) {
      setPanelError(err);
      return;
    }
    const sent = attachments.filter((a) => a.status === 'ready' && a.attachmentId != null);
    const chips: AiAttachmentChip[] = sent.map((a) => ({
      id: a.attachmentId ?? '',
      name: a.file.name,
      kind: a.kind,
    }));
    sent.forEach(releasePreview);
    // Files that failed stay listed with their error until the user removes them.
    setAttachments((prev) => prev.filter((a) => !sent.includes(a)));
    setInput('');
    if (textareaRef.current != null) textareaRef.current.style.height = 'auto';
    setMessages((prev) => [...prev, userMessage(trimmed, chips)]);
    await streamInto(`${conversationPath(id)}/messages`, {
      text: trimmed,
      ...(chips.length > 0 ? { attachmentIds: chips.map((c) => c.id) } : {}),
    });
    textareaRef.current?.focus();
  }

  async function decide(message: AiMessageView, verb: 'confirm' | 'reject'): Promise<void> {
    const confirmation = message.confirmation;
    if (confirmation == null || conversationId == null || busy) return;
    const { actionId, nonce } = confirmation.event;
    updateMessage(message.key, (m) =>
      m.confirmation == null
        ? m
        : {
            ...m,
            confirmation: {
              ...m.confirmation,
              state: verb === 'confirm' ? 'confirming' : 'rejecting',
            },
          },
    );
    const outcome = await streamInto(
      `${conversationPath(conversationId)}/actions/${encodeURIComponent(actionId)}/${verb}`,
      { nonce },
    );
    const decided = outcome.kind === 'completed';
    updateMessage(message.key, (m) =>
      m.confirmation == null
        ? m
        : {
            ...m,
            confirmation: {
              ...m.confirmation,
              state: decided ? (verb === 'confirm' ? 'confirmed' : 'rejected') : 'pending',
            },
          },
    );
  }

  async function openConversation(id: string): Promise<void> {
    if (busy) return;
    setView('chat');
    setPanelError(null);
    setLoadingConversation(true);
    try {
      const detail = await api.get<AiConversationItem & { messages: StoredAiMessage[] }>(
        conversationPath(id),
      );
      setConversationId(detail.id);
      setMessages(messagesFromHistory(detail.messages));
    } catch (err) {
      setPanelError(err);
    } finally {
      setLoadingConversation(false);
    }
  }

  function newChat(): void {
    if (busy) return;
    setConversationId(null);
    setMessages([]);
    setPanelError(null);
    setView('chat');
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function addFiles(files: File[]): void {
    if (files.length === 0 || !canWrite) return;
    const next = addPendingFiles(attachments, files);
    setAttachments(next);
    for (const att of next.slice(attachments.length)) {
      if (att.status === 'uploading') void uploadOne(att);
    }
  }

  function removeAttachment(localId: string): void {
    const gone = attachments.find((a) => a.localId === localId);
    if (gone == null) return;
    releasePreview(gone);
    setAttachments((prev) => prev.filter((a) => a.localId !== localId));
    if (gone.attachmentId != null) {
      // fail-open: an unused attachment is pruned with the retention job anyway.
      deleteAiAttachment(gone.attachmentId).catch((err: unknown) => {
        console.warn('Delete an unused AI attachment failed', err);
      });
    }
  }

  function onPanelKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (streaming) stop();
      else onClose();
      return;
    }
    if (e.key !== 'Tab' || panelRef.current == null) return;
    // Focus stays in the panel while it is open (returned to the launcher on close).
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null,
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first == null || last == null) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
      return;
    }
    if (e.key === 'ArrowUp' && input === '') {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUser != null) {
        e.preventDefault();
        setInput(lastUser.text);
      }
    }
  }

  function onInputChange(e: React.ChangeEvent<HTMLTextAreaElement>): void {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${String(Math.min(el.scrollHeight, 160))}px`;
  }

  const showEmpty = messages.length === 0 && !loadingConversation;
  const inHistory = view === 'history';
  const historyToggleLabel = inHistory ? t('ai.backToChat') : t('ai.history');

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-panel-title"
      data-testid="ai-panel"
      onKeyDown={onPanelKeyDown}
      onDragOver={(e) => {
        if (!canWrite || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setDragging(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
      className="fixed inset-0 z-50 flex flex-col bg-card text-card-foreground shadow-lg animate-slide-in-from-right md:inset-y-0 md:left-auto md:right-0 md:w-[440px] md:border-l md:border-border"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Sparkles className="h-5 w-5 text-primary" aria-hidden="true" />
        <h2 id="ai-panel-title" className="flex-1 text-base font-semibold">
          {t('ai.title')}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={historyToggleLabel}
          aria-pressed={view === 'history'}
          onClick={() => {
            setView((v) => (v === 'history' ? 'chat' : 'history'));
          }}
        >
          <History className="h-4 w-4" />
        </Button>
        {canWrite && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('ai.newChat')}
            disabled={busy}
            onClick={newChat}
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {view === 'history' ? (
        <div className="min-h-0 flex-1">
          <ConversationList
            activeId={conversationId}
            canWrite={canWrite}
            onOpen={(id) => {
              void openConversation(id);
            }}
            onNew={newChat}
            onDeleted={(id) => {
              if (id === conversationId) newChat();
            }}
          />
        </div>
      ) : (
        <>
          <div
            role="log"
            aria-live="polite"
            aria-busy={streaming}
            aria-label={t('ai.messages')}
            className="relative min-h-0 flex-1 overflow-y-auto p-4"
          >
            {loadingConversation && (
              <div className="flex justify-center p-6">
                <Spinner className="h-5 w-5" />
              </div>
            )}
            {showEmpty && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">{t('ai.intro')}</p>
                {canWrite ? (
                  <SuggestedPrompts
                    disabled={busy}
                    onPick={(prompt) => {
                      void send(prompt);
                    }}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">{t('ai.readOnly')}</p>
                )}
              </div>
            )}
            <MessageList
              messages={messages}
              canDecide={canWrite && !busy}
              onConfirm={(m) => {
                void decide(m, 'confirm');
              }}
              onReject={(m) => {
                void decide(m, 'reject');
              }}
            />
            {panelError != null && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {getErrorMessage(panelError, t, 'ai.errors.generic')}
              </p>
            )}
            <div ref={endRef} />
          </div>

          {canWrite && (
            <div className="space-y-2 border-t border-border p-3">
              <AttachmentPreviews
                attachments={attachments}
                disabled={busy}
                onRemove={removeAttachment}
              />
              <div className="flex items-end gap-1">
                <AttachmentPickerButton disabled={busy} onFiles={addFiles} />
                <textarea
                  ref={textareaRef}
                  value={input}
                  rows={1}
                  maxLength={8000}
                  aria-label={t('ai.inputLabel')}
                  placeholder={t('ai.placeholder')}
                  onChange={onInputChange}
                  onKeyDown={onInputKeyDown}
                  onPaste={(e) => {
                    const files = Array.from(e.clipboardData.files);
                    if (files.length > 0) {
                      e.preventDefault();
                      addFiles(files);
                    }
                  }}
                  className="max-h-40 min-h-10 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                />
                {streaming ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="destructive"
                    aria-label={t('ai.stop')}
                    data-testid="ai-stop"
                    onClick={stop}
                  >
                    <Square className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="icon"
                    aria-label={t('ai.send')}
                    disabled={input.trim() === '' || busy || uploading}
                    onClick={() => {
                      void send(input);
                    }}
                  >
                    {uploading ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                  </Button>
                )}
              </div>
              <p className="hidden text-xs text-muted-foreground md:block">
                {t('ai.keyboardHint')}
              </p>
            </div>
          )}

          {dragging && (
            <div
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2',
                'border-2 border-dashed border-primary bg-primary/10 text-primary',
              )}
            >
              <Upload className="h-8 w-8" />
              <p className="text-sm font-medium">{t('ai.dropFiles')}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default AiPanel;
