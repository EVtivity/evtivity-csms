// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams } from 'react-router';
import { useBackToParent } from '@/hooks/use-back-to-parent';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoNote } from '@/components/ui/info-note';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatDate } from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';
import { LoadingLogo } from '@/components/loading-logo';
import { AiCaseStatus } from '@/components/support/AiCaseStatus';
import { isAiAnalyzing } from '@/components/support/driver-ai';
import type { PortalCaseAi } from '@/components/support/driver-ai';

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
  senderType: 'driver' | 'operator' | 'system' | 'assistant';
  body: string;
  createdAt: string;
  attachments: Attachment[];
}

interface SessionRef {
  id: string;
  transactionId: string;
}

interface CaseDetail {
  id: string;
  caseNumber: string;
  subject: string;
  description: string;
  status: string;
  category: string;
  priority: string;
  sessions: SessionRef[];
  stationName: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  /** The driver AI step; consent null when the driver was not asked. */
  ai?: PortalCaseAi | null;
}

// While the answer is prepared, poll as well as the SSE event (a lost event
// must not leave the driver waiting).
const ANALYZING_POLL_MS = 4000;

export function SupportCaseDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const backToList = useBackToParent('/support');
  const timezone = useDriverTimezone();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [messageBody, setMessageBody] = useState('');
  const [closeOpen, setCloseOpen] = useState(false);

  const { data: caseDetail, isLoading } = useQuery({
    queryKey: ['portal-support-case', id],
    queryFn: () => api.get<CaseDetail>(`/v1/portal/support-cases/${id ?? ''}`),
    enabled: id != null,
    refetchInterval: (query) => (isAiAnalyzing(query.state.data?.ai) ? ANALYZING_POLL_MS : false),
  });

  const messageMutation = useMutation({
    mutationFn: (body: { body: string }) =>
      api.post<Message>(`/v1/portal/support-cases/${id ?? ''}/messages`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-support-case', id] });
      setMessageBody('');
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t, 'supportCases.sendFailed') });
    },
  });

  // The driver closes the own case (resolved). A later message reopens it.
  const closeMutation = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/v1/portal/support-cases/${id ?? ''}/close`, {}),
    onSuccess: () => {
      setCloseOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['portal-support-case', id] });
      void queryClient.invalidateQueries({ queryKey: ['portal-support-cases'] });
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t, 'supportCases.closeFailed') });
    },
  });

  function handleSendMessage(e: React.SyntheticEvent): void {
    e.preventDefault();
    if (messageBody.trim() === '') return;
    messageMutation.mutate({ body: messageBody });
  }

  async function handleDownload(attachment: Attachment): Promise<void> {
    try {
      const { downloadUrl } = await api.get<{ downloadUrl: string }>(
        `/v1/portal/support-cases/${id ?? ''}/messages/${String(attachment.messageId)}/attachments/${String(attachment.id)}/download-url`,
      );
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast({
        variant: 'destructive',
        title: getErrorMessage(err, t, 'supportCases.downloadFailed'),
      });
    }
  }

  if (isLoading) {
    return <LoadingLogo />;
  }

  if (caseDetail == null) {
    return <p className="text-sm text-destructive">{t('supportCases.notFound')}</p>;
  }

  const ai = caseDetail.ai ?? null;
  const lastAssistantId = [...caseDetail.messages]
    .reverse()
    .find((m) => m.senderType === 'assistant')?.id;
  // A resolved or closed case keeps the message box: a message reopens it.
  const isEnded = caseDetail.status === 'resolved' || caseDetail.status === 'closed';

  return (
    <div className="flex flex-col h-[calc(100dvh-8rem)]">
      {/* Header */}
      <div className="flex items-center gap-2 pb-3">
        <Button variant="ghost" size="icon" aria-label={t('common.back')} onClick={backToList}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{caseDetail.caseNumber}</span>
            <Badge>{t(`supportCases.statuses.${caseDetail.status}`)}</Badge>
          </div>
          <h1 className="text-lg font-bold truncate">{caseDetail.subject}</h1>
        </div>
        {!isEnded && (
          <Button
            variant="outline"
            onClick={() => {
              setCloseOpen(true);
            }}
          >
            {t('supportCases.closeCase')}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        title={t('supportCases.closeConfirmTitle')}
        description={t('supportCases.closeConfirmDescription')}
        confirmLabel={t('supportCases.closeCase')}
        isPending={closeMutation.isPending}
        onConfirm={() => {
          closeMutation.mutate();
        }}
      />

      {/* Info */}
      <Card className="mb-3">
        <CardContent className="p-3 text-xs space-y-1 text-muted-foreground">
          <div className="flex justify-between">
            <span>{t(`supportCases.categories.${caseDetail.category}`)}</span>
            <span>{formatDate(caseDetail.createdAt, timezone)}</span>
          </div>
          {caseDetail.stationName != null && (
            <div>
              {t('supportCases.station')}: {caseDetail.stationName}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Messages - scrollable area */}
      <div className="flex-1 overflow-auto space-y-3 pb-3">
        {caseDetail.messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${
              msg.senderType === 'driver'
                ? 'justify-end'
                : msg.senderType === 'system'
                  ? 'justify-center'
                  : 'justify-start'
            }`}
          >
            {msg.senderType === 'system' ? (
              <div className="text-xs text-muted-foreground italic py-1">{msg.body}</div>
            ) : msg.senderType === 'assistant' ? (
              <div
                data-testid="ai-answer"
                className="max-w-[85%] rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
              >
                <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('supportCases.ai.answerTitle')}
                </div>
                <p className="whitespace-pre-wrap break-words">{msg.body}</p>
                {msg.id === lastAssistantId && ai != null && ai.driverActions.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1">
                    {ai.driverActions.map((code) => (
                      <li key={code}>
                        <Badge variant="outline" className="whitespace-normal normal-case">
                          {t(`supportCases.ai.driverAction.${code}`)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="text-[10px] mt-1 opacity-70">
                  {formatDate(msg.createdAt, timezone)}
                </div>
              </div>
            ) : (
              <div
                className={`max-w-[85%] rounded-lg p-3 text-sm ${
                  msg.senderType === 'driver' ? 'bg-primary text-primary-foreground' : 'bg-muted'
                }`}
              >
                <p className="whitespace-pre-wrap">{msg.body}</p>
                {msg.attachments.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {msg.attachments.map((att) => (
                      <button
                        key={att.id}
                        type="button"
                        onClick={() => {
                          void handleDownload(att);
                        }}
                        className="flex items-center gap-1 text-xs underline"
                      >
                        <Download className="h-3 w-3" />
                        {att.fileName}
                      </button>
                    ))}
                  </div>
                )}
                <div className="text-[10px] mt-1 opacity-70">
                  {formatDate(msg.createdAt, timezone)}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {ai != null && <AiCaseStatus caseId={caseDetail.id} ai={ai} />}

      {isEnded && <InfoNote className="mb-2">{t('supportCases.reopenNote')}</InfoNote>}

      {/* Message input */}
      <form onSubmit={handleSendMessage} className="flex items-end gap-2 border-t pt-3">
        {/* One line is the 48 px of the Send button beside it; the field grows
              with its text and the button stays on its bottom edge. */}
        <Textarea
          value={messageBody}
          onChange={(e) => {
            setMessageBody(e.target.value);
          }}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter starts a new line, as in a chat.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              handleSendMessage(e);
            }
          }}
          aria-label={t('supportCases.messagePlaceholder')}
          placeholder={t('supportCases.messagePlaceholder')}
          rows={1}
          className="min-h-12 max-h-36 flex-1 resize-none rounded-lg py-[11px] leading-6 field-sizing-content"
        />
        <Button
          type="submit"
          size="field"
          disabled={messageMutation.isPending || messageBody.trim() === ''}
        >
          {t('supportCases.sendMessage')}
        </Button>
      </form>
    </div>
  );
}
