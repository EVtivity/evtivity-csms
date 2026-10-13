// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { CircleAlert, FileText, ImageIcon, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { formatNumber } from '@/lib/formatting';
import { cn } from '@/lib/utils';
import { aiErrorText } from './ai-error-text';
import { AiLink, AiMarkdown } from './AiMarkdown';
import { ConfirmActionCard } from './ConfirmActionCard';
import { ToolSteps } from './ToolSteps';
import type { AiMessageView } from './ai-turn';
import { aiAttachmentDownloadUrl } from './ai-attachments';

/** Opens a stored attachment through a short-lived download link. */
function openAttachment(id: string): void {
  aiAttachmentDownloadUrl(id).then(
    (url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    (err: unknown) => {
      console.warn('Open an AI attachment failed', err);
    },
  );
}

interface MessageBubbleProps {
  message: AiMessageView;
  canDecide: boolean;
  onConfirm: (message: AiMessageView) => void;
  onReject: (message: AiMessageView) => void;
}

export function MessageBubble({
  message,
  canDecide,
  onConfirm,
  onReject,
}: MessageBubbleProps): React.JSX.Element {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const streaming = message.finish == null;
  const totalTokens =
    message.usage != null ? message.usage.inputTokens + message.usage.outputTokens : null;

  return (
    <div
      className={cn('flex', isUser ? 'justify-end' : 'justify-start')}
      data-testid={isUser ? 'ai-user-message' : 'ai-assistant-message'}
    >
      <div
        className={cn('group min-w-0 space-y-1.5', isUser ? 'max-w-[85%]' : 'w-full max-w-[95%]')}
      >
        {!isUser && <ToolSteps steps={message.toolSteps} />}
        {(message.text !== '' || (isUser && message.attachments.length === 0)) && (
          <div
            className={cn(
              'rounded-lg px-3 py-2 text-sm',
              isUser ? 'bg-primary text-primary-foreground' : 'bg-muted',
            )}
          >
            {isUser ? (
              <span className="whitespace-pre-wrap break-words">{message.text}</span>
            ) : (
              <AiMarkdown content={message.text} />
            )}
          </div>
        )}
        {!isUser && streaming && message.text === '' && message.toolSteps.length === 0 && (
          <div className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
            <span className="inline-flex gap-1" aria-label={t('ai.thinking')}>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
            </span>
          </div>
        )}
        {message.attachments.length > 0 && (
          <ul className={cn('flex flex-wrap gap-1', isUser && 'justify-end')}>
            {message.attachments.map((a) => (
              <li key={a.id}>
                <Button
                  type="button"
                  variant="outline"
                  size="chip"
                  onClick={() => {
                    openAttachment(a.id);
                  }}
                >
                  {a.kind === 'image' ? (
                    <ImageIcon className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <FileText className="h-3 w-3" aria-hidden="true" />
                  )}
                  {a.name !== '' ? a.name : t('ai.attachment')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {message.confirmation != null && (
          <ConfirmActionCard
            confirmation={message.confirmation}
            canDecide={canDecide}
            onConfirm={() => {
              onConfirm(message);
            }}
            onReject={() => {
              onReject(message);
            }}
          />
        )}
        {message.citations.length > 0 && (
          <div className="space-y-0.5 text-xs">
            <p id={`ai-sources-${message.key}`} className="font-medium text-muted-foreground">
              {t('ai.citations')}
            </p>
            <ol
              aria-labelledby={`ai-sources-${message.key}`}
              className="list-decimal space-y-0.5 pl-5"
            >
              {message.citations.map((c) => (
                <li key={c.id}>
                  <AiLink href={c.url}>{c.title}</AiLink>
                </li>
              ))}
            </ol>
          </div>
        )}
        {message.errorCode != null && (
          <p role="alert" className="flex items-start gap-1 text-xs text-destructive">
            <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            {aiErrorText(message.errorCode, t)}
          </p>
        )}
        {message.finish === 'stopped' && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Square className="h-3 w-3" aria-hidden="true" />
            {t('ai.stopped')}
          </p>
        )}
        {(message.finish === 'max_tokens' ||
          message.finish === 'refusal' ||
          message.finish === 'context_exceeded') && (
          <p className="text-xs text-muted-foreground">{t(`ai.finish.${message.finish}`)}</p>
        )}
        {!streaming && (message.text !== '' || totalTokens != null) && (
          <div
            className={cn(
              'flex items-center gap-2 text-xs text-muted-foreground',
              isUser ? 'justify-end' : 'justify-start',
            )}
          >
            {message.text !== '' && <CopyButton value={message.text} variant="ghost" />}
            {totalTokens != null && (
              <span data-testid="ai-usage">
                {t('ai.tokens', { formatted: formatNumber(totalTokens, 0) })}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface MessageListProps {
  messages: AiMessageView[];
  canDecide: boolean;
  onConfirm: (message: AiMessageView) => void;
  onReject: (message: AiMessageView) => void;
}

export function MessageList({
  messages,
  canDecide,
  onConfirm,
  onReject,
}: MessageListProps): React.JSX.Element {
  return (
    <div className="space-y-4">
      {messages.map((m) => (
        <MessageBubble
          key={m.key}
          message={m}
          canDecide={canDecide}
          onConfirm={onConfirm}
          onReject={onReject}
        />
      ))}
    </div>
  );
}
