// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, Sparkles, X } from 'lucide-react';
import { FileUploadButton } from '@/components/ui/file-upload-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';

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

  const [messageBody, setMessageBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [aiAssistLoading, setAiAssistLoading] = useState(false);

  async function handleSendMessage(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (messageBody.trim() === '') return;
    setIsSending(true);
    setSendError(null);

    try {
      const message = await api.post<{ id: string }>(`/v1/support-cases/${caseId}/messages`, {
        body: messageBody,
        isInternal,
      });

      for (let fileIdx = 0; fileIdx < pendingFiles.length; fileIdx++) {
        const file = pendingFiles[fileIdx];
        if (file == null) continue;
        setUploadProgress({ current: fileIdx + 1, total: pendingFiles.length });

        const { uploadUrl, s3Key, s3Bucket } = await api.post<{
          uploadUrl: string;
          s3Key: string;
          s3Bucket: string;
        }>(`/v1/support-cases/${caseId}/messages/${message.id}/attachments/upload-url`, {
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          fileSize: file.size,
        });

        const uploadRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!uploadRes.ok) {
          throw new Error(`Upload failed: ${String(uploadRes.status)}`);
        }

        await api.post(`/v1/support-cases/${caseId}/messages/${message.id}/attachments`, {
          fileName: file.name,
          fileSize: file.size,
          contentType: file.type || 'application/octet-stream',
          s3Key,
          s3Bucket,
        });
      }

      onMessageSent();
      setMessageBody('');
      setIsInternal(false);
      setPendingFiles([]);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setIsSending(false);
      setUploadProgress(null);
    }
  }

  function removePendingFile(index: number): void {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleAiAssist(): Promise<void> {
    setAiAssistLoading(true);
    setSendError(null);
    try {
      const res = await api.post<{ draft: string }>(`/v1/support-cases/${caseId}/ai-assist`, {
        isInternalNote: isInternal,
      });
      setMessageBody(res.draft);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : t('supportCases.aiAssistError'));
    } finally {
      setAiAssistLoading(false);
    }
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
          <p className="text-sm text-muted-foreground">{t('supportCases.noMessages')}</p>
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
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
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
                disabled={!s3Configured}
                onFiles={(files) => {
                  setPendingFiles((prev) => [...prev, ...files]);
                }}
              >
                {t('supportCases.uploadAttachment')}
              </FileUploadButton>
              {supportAiEnabled && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={aiAssistLoading}
                  onClick={() => {
                    void handleAiAssist();
                  }}
                  title={t('supportCases.aiAssistTooltip')}
                >
                  {aiAssistLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  <span className="ml-1">
                    {aiAssistLoading
                      ? t('supportCases.aiAssistLoading')
                      : t('supportCases.aiAssist')}
                  </span>
                </Button>
              )}
            </div>
            <Button type="submit" size="sm" disabled={isSending || messageBody.trim() === ''}>
              {isSending ? t('supportCases.uploading') : t('supportCases.sendMessage')}
            </Button>
          </div>
          {sendError != null && <p className="text-sm text-destructive">{sendError}</p>}
        </form>
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
              <span className="text-muted-foreground">({(att.fileSize / 1024).toFixed(0)} KB)</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
