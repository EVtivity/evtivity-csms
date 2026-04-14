// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';

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
}

export function SupportCaseDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const timezone = useDriverTimezone();
  const queryClient = useQueryClient();
  const [messageBody, setMessageBody] = useState('');

  const { data: caseDetail, isLoading } = useQuery({
    queryKey: ['portal-support-case', id],
    queryFn: () => api.get<CaseDetail>(`/v1/portal/support-cases/${id ?? ''}`),
    enabled: id != null,
  });

  const messageMutation = useMutation({
    mutationFn: (body: { body: string }) =>
      api.post<Message>(`/v1/portal/support-cases/${id ?? ''}/messages`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-support-case', id] });
      setMessageBody('');
    },
  });

  function handleSendMessage(e: React.SyntheticEvent): void {
    e.preventDefault();
    if (messageBody.trim() === '') return;
    messageMutation.mutate({ body: messageBody });
  }

  async function handleDownload(attachment: Attachment): Promise<void> {
    const { downloadUrl } = await api.get<{ downloadUrl: string }>(
      `/v1/portal/support-cases/${id ?? ''}/messages/${String(attachment.messageId)}/attachments/${String(attachment.id)}/download-url`,
    );
    window.open(downloadUrl, '_blank');
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  if (caseDetail == null) {
    return <p className="text-sm text-destructive">{t('supportCases.notFound')}</p>;
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-8rem)]">
      {/* Header */}
      <div className="flex items-center gap-2 pb-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common.back')}
          onClick={() => {
            void navigate('/support');
          }}
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{caseDetail.caseNumber}</span>
            <Badge>{t(`supportCases.statuses.${caseDetail.status}`)}</Badge>
          </div>
          <h1 className="text-lg font-bold truncate">{caseDetail.subject}</h1>
        </div>
      </div>

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

      {/* Message input */}
      {caseDetail.status !== 'closed' && caseDetail.status !== 'resolved' && (
        <form onSubmit={handleSendMessage} className="flex gap-2 border-t pt-3">
          <Input
            value={messageBody}
            onChange={(e) => {
              setMessageBody(e.target.value);
            }}
            placeholder={t('supportCases.messagePlaceholder')}
            className="flex-1"
          />
          <Button
            type="submit"
            size="sm"
            disabled={messageMutation.isPending || messageBody.trim() === ''}
          >
            {t('supportCases.sendMessage')}
          </Button>
        </form>
      )}
    </div>
  );
}
