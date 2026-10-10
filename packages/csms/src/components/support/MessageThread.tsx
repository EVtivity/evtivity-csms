// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Sparkles, Square, X } from 'lucide-react';
import { FileUploadButton } from '@/components/ui/file-upload-button';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api, getApiErrorCode } from '@/lib/api';
import { ToolSteps } from '@/components/ai/ToolSteps';
import { aiErrorText } from '@/components/ai/MessageList';
import { useAiStream } from '@/components/ai/use-ai-stream';
import { useAiStatus } from '@/components/ai/use-ai-status';
import type { AiToolStepView } from '@/components/ai/ai-turn';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime } from '@/lib/timezone';
import { formatNumber } from '@/lib/formatting';

// The attachment allowlist of the API upload pipeline (images, PDF, text).
const ATTACHMENT_ACCEPT =
  'image/jpeg,image/png,image/webp,image/gif,application/pdf,text/csv,text/plain,application/json,.log,.jsonl,.ndjson';

interface Attachment {
  id: number;
  messageId: number;
  fileName: string;
  fileSize: number;
  contentType: string;
  createdAt: string;
}

interface Message {
  id: number;
  senderType: 'driver' | 'operator' | 'system';
  senderId: string | null;
  body: string;
  isInternal: boolean;
  createdAt: string;
  attachments: Attachment[];
}

interface MessageThreadProps {
  caseId: string;
  messages: Message[];
  timezone: string;
  s3Configured: boolean;
  supportAiEnabled: boolean;
  onMessageSent: () => void;
}

export function MessageThread({
  caseId,
  messages,
  timezone,
  s3Configured,
  supportAiEnabled,
  onMessageSent,
}: MessageThreadProps): React.JSX.Element {
  const { t } = useTranslation();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Set by a tool step that follows draft text: the next text is a new paragraph.
  const aiTextBreak = useRef(false);
  const aiDraftHasText = useRef(false);

  const [messageBody, setMessageBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [confirmAiOverwrite, setConfirmAiOverwrite] = useState(false);
  const aiStream = useAiStream();
  // The setting alone is not enough: the status also needs a provider with a key.
  const aiStatus = useAiStatus();
  const showAiAssist = supportAiEnabled && aiStatus.support;
  const [aiSteps, setAiSteps] = useState<AiToolStepView[]>([]);
  const [aiErrorCode, setAiErrorCode] = useState<string | null>(null);

  async function handleSendMessage(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (messageBody.trim() === '') return;
    setIsSending(true);
    setSendError(null);

    try {
      const message = await api.post<{ id: number }>(`/v1/support-cases/${caseId}/messages`, {
        body: messageBody,
        isInternal,
      });

      for (let fileIdx = 0; fileIdx < pendingFiles.length; fileIdx++) {
        const file = pendingFiles[fileIdx];
        if (file == null) continue;
        setUploadProgress({ current: fileIdx + 1, total: pendingFiles.length });

        // The server picks the type (the browser gives none for .log and
        // .jsonl) and S3 enforces the size and type of the presigned POST.
        const { uploadUrl, fields, s3Key } = await api.post<{
          uploadUrl: string;
          fields: Record<string, string>;
          s3Key: string;
        }>(`/v1/support-cases/${caseId}/messages/${String(message.id)}/attachments/upload-url`, {
          fileName: file.name,
          contentType: file.type,
          fileSize: file.size,
        });

        const form = new FormData();
        for (const [name, value] of Object.entries(fields)) {
          form.append(name, value);
        }
        form.append('file', file);
        const uploadRes = await fetch(uploadUrl, { method: 'POST', body: form });
        if (!uploadRes.ok) {
          throw new Error(t('supportCases.attachmentUploadFailed'));
        }

        await api.post(`/v1/support-cases/${caseId}/messages/${String(message.id)}/attachments`, {
          s3Key,
        });
      }

      onMessageSent();
      setMessageBody('');
      setIsInternal(false);
      setPendingFiles([]);
    } catch (err) {
      setSendError(getErrorMessage(err, t, 'supportCases.sendFailed'));
    } finally {
      setIsSending(false);
      setUploadProgress(null);
    }
  }

  function removePendingFile(index: number): void {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }

  // The draft streams into the message box; the operator reviews it before sending.
  async function handleAiAssist(): Promise<void> {
    setSendError(null);
    setAiErrorCode(null);
    setAiSteps([]);
    aiTextBreak.current = false;
    aiDraftHasText.current = false;
    setMessageBody('');
    const outcome = await aiStream.run(
      `/v1/support-cases/${encodeURIComponent(caseId)}/ai-assist`,
      { isInternalNote: isInternal },
      (event) => {
        if (event.type === 'text_delta') {
          const textBreak = aiTextBreak.current;
          aiTextBreak.current = false;
          aiDraftHasText.current = true;
          setMessageBody((prev) =>
            textBreak && prev !== '' && !prev.endsWith('\n')
              ? `${prev}\n\n${event.text}`
              : prev + event.text,
          );
        } else if (event.type === 'tool_step') {
          aiTextBreak.current = aiDraftHasText.current;
          setAiSteps((prev) => {
            const step: AiToolStepView = {
              toolCallId: event.toolCallId,
              name: event.name,
              status: event.status,
              ...(event.summary !== undefined ? { summary: event.summary } : {}),
              ...(event.reason !== undefined ? { reason: event.reason } : {}),
              ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            };
            const index = prev.findIndex((s) => s.toolCallId === event.toolCallId);
            return index === -1 ? [...prev, step] : prev.map((s, i) => (i === index ? step : s));
          });
        } else if (event.type === 'error') {
          setAiErrorCode(event.code);
        }
      },
    );
    if (outcome.kind === 'failed') {
      setAiErrorCode(getApiErrorCode(outcome.error) ?? 'AI_ERROR');
    }
  }

  function onAiAssistClick(): void {
    if (messageBody.trim() !== '') {
      setConfirmAiOverwrite(true);
      return;
    }
    void handleAiAssist();
  }

  async function handleDownload(attachment: Attachment): Promise<void> {
    const { downloadUrl } = await api.get<{ downloadUrl: string }>(
      `/v1/support-cases/${caseId}/messages/${String(attachment.messageId)}/attachments/${String(attachment.id)}/download-url`,
    );
    window.open(downloadUrl, '_blank');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('supportCases.messages')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {messages.length === 0 && (
          <p className="text-center text-sm text-muted-foreground">
            {t('supportCases.noMessages')}
          </p>
        )}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            timezone={timezone}
            onDownload={(att) => {
              void handleDownload(att);
            }}
          />
        ))}
        <div ref={messagesEndRef} />

        <form
          onSubmit={(e) => {
            void handleSendMessage(e);
          }}
          className="space-y-3 border-t pt-4"
        >
          <textarea
            value={messageBody}
            onChange={(e) => {
              setMessageBody(e.target.value);
            }}
            readOnly={aiStream.streaming}
            aria-busy={aiStream.streaming}
            aria-label={t('supportCases.messagePlaceholder')}
            placeholder={t('supportCases.messagePlaceholder')}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            rows={3}
          />
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {pendingFiles.map((file, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs"
                >
                  {file.name}
                  <button
                    type="button"
                    onClick={() => {
                      removePendingFile(i);
                    }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {uploadProgress != null && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {t('supportCases.uploadingFileProgress', {
                  current: uploadProgress.current,
                  total: uploadProgress.total,
                })}
              </p>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary animate-pulse"
                  style={{
                    width: `${String(Math.round((uploadProgress.current / uploadProgress.total) * 100))}%`,
                  }}
                />
              </div>
            </div>
          )}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 md:gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isInternal}
                  onChange={(e) => {
                    setIsInternal(e.target.checked);
                  }}
                  className="rounded"
                />
                {t('supportCases.internalNote')}
              </label>
              <FileUploadButton
                variant="outline"
                size="sm"
                multiple
                accept={ATTACHMENT_ACCEPT}
                disabled={!s3Configured}
                onFiles={(files) => {
                  setPendingFiles((prev) => [...prev, ...files]);
                }}
              >
                {t('supportCases.uploadAttachment')}
              </FileUploadButton>
              {showAiAssist &&
                (aiStream.streaming ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={aiStream.stop}
                    data-testid="support-ai-stop"
                  >
                    <Spinner className="h-4 w-4" />
                    <Square className="ml-1 h-3 w-3" />
                    <span className="ml-1">{t('supportCases.aiAssistStop')}</span>
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isSending}
                    onClick={onAiAssistClick}
                    title={t('supportCases.aiAssistTooltip')}
                  >
                    <Sparkles className="h-4 w-4" />
                    <span className="ml-1">{t('supportCases.aiAssist')}</span>
                  </Button>
                ))}
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={isSending || aiStream.streaming || messageBody.trim() === ''}
            >
              {isSending ? t('supportCases.uploading') : t('supportCases.sendMessage')}
            </Button>
          </div>
          {aiSteps.length > 0 && <ToolSteps steps={aiSteps} label="ai.sources" />}
          {aiErrorCode != null && (
            <p role="alert" className="text-sm text-destructive">
              {aiErrorText(aiErrorCode, t)}
            </p>
          )}
          {sendError != null && <p className="text-sm text-destructive">{sendError}</p>}
        </form>
        <ConfirmDialog
          open={confirmAiOverwrite}
          onOpenChange={setConfirmAiOverwrite}
          title={t('supportCases.aiAssistOverwriteTitle')}
          description={t('supportCases.aiAssistOverwriteDescription')}
          confirmLabel={t('supportCases.aiAssistOverwriteConfirm')}
          variant="default"
          onConfirm={() => {
            void handleAiAssist();
          }}
        />
      </CardContent>
    </Card>
  );
}

function MessageBubble({
  message,
  timezone,
  onDownload,
}: {
  message: Message;
  timezone: string;
  onDownload: (attachment: Attachment) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const isSystem = message.senderType === 'system';
  const isInternal = message.isInternal;

  if (isSystem) {
    return (
      <div className="text-center text-xs text-muted-foreground py-2 italic">
        {message.body}
        <span className="ml-2">{formatDateTime(message.createdAt, timezone)}</span>
      </div>
    );
  }

  return (
    <div
      className={`rounded-lg p-3 text-sm ${
        isInternal
          ? 'bg-yellow-50 border border-yellow-200 dark:bg-yellow-950 dark:border-yellow-800'
          : message.senderType === 'driver'
            ? 'bg-muted'
            : 'bg-primary/5'
      }`}
    >
      <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
        <span className="font-medium">
          {message.senderType === 'driver'
            ? t('supportCases.driverMessage')
            : t('supportCases.operatorMessage')}
          {isInternal && (
            <span className="ml-2 text-yellow-600 dark:text-yellow-400">
              ({t('supportCases.internalNote')})
            </span>
          )}
        </span>
        <span>{formatDateTime(message.createdAt, timezone)}</span>
      </div>
      <p className="whitespace-pre-wrap">{message.body}</p>
      {message.attachments.length > 0 && (
        <div className="mt-2 space-y-1">
          {message.attachments.map((att) => (
            <button
              key={att.id}
              type="button"
              onClick={() => {
                onDownload(att);
              }}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <Download className="h-3 w-3" />
              {att.fileName}
              <span className="text-muted-foreground">
                ({formatNumber(att.fileSize / 1024, 0)} KB)
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
