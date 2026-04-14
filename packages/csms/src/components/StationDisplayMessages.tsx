// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Send, Trash2 } from 'lucide-react';
import { CancelButton } from '@/components/cancel-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { api } from '@/lib/api';
import { Select } from '@/components/ui/select';
import { formatDateTime } from '@/lib/timezone';

interface DisplayMessage {
  id: number;
  stationId: string;
  ocppMessageId: number;
  priority: string;
  status: string;
  state: string | null;
  format: string;
  language: string | null;
  content: string;
  startDateTime: string | null;
  endDateTime: string | null;
  transactionId: string | null;
  evseId: number | null;
  createdAt: string;
}

interface StationDisplayMessagesProps {
  stationId: string;
  isOnline: boolean;
  timezone: string;
}

const PRIORITIES = ['AlwaysFront', 'InFront', 'NormalCycle'] as const;
const FORMATS = ['ASCII', 'HTML', 'URI', 'UTF8', 'QRCODE'] as const;
const STATES = ['Charging', 'Faulted', 'Idle', 'Unavailable', 'Suspended', 'Discharging'] as const;

const STATUS_VARIANTS: Record<string, 'default' | 'outline' | 'destructive' | 'secondary'> = {
  pending: 'outline',
  accepted: 'default',
  rejected: 'destructive',
  cleared: 'secondary',
  expired: 'outline',
};

export function StationDisplayMessages({
  stationId,
  isOnline,
  timezone,
}: StationDisplayMessagesProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [clearTarget, setClearTarget] = useState<DisplayMessage | null>(null);

  // Form state
  const [priority, setPriority] = useState<string>('NormalCycle');
  const [format, setFormat] = useState<string>('UTF8');
  const [content, setContent] = useState('');
  const [language, setLanguage] = useState('');
  const [state, setState] = useState('');
  const [startDateTime, setStartDateTime] = useState('');
  const [endDateTime, setEndDateTime] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [evseId, setEvseId] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const limit = 10;

  const { data: messagesResponse } = useQuery({
    queryKey: ['display-messages', stationId, page],
    queryFn: () =>
      api.get<{ data: DisplayMessage[]; total: number }>(
        `/v1/stations/${stationId}/display-messages?page=${String(page)}&limit=${String(limit)}`,
      ),
  });

  const messages = messagesResponse?.data ?? [];
  const totalPages = Math.max(1, Math.ceil((messagesResponse?.total ?? 0) / limit));

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<DisplayMessage>(`/v1/stations/${stationId}/display-messages`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['display-messages', stationId] });
      setCreateOpen(false);
      resetForm();
      setHasSubmitted(false);
    },
  });

  const clearMutation = useMutation({
    mutationFn: (messageId: number) =>
      api.delete<{ status: string }>(
        `/v1/stations/${stationId}/display-messages/${String(messageId)}`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['display-messages', stationId] });
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () =>
      api.post<{ status: string }>(`/v1/stations/${stationId}/display-messages/refresh`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['display-messages', stationId] });
    },
  });

  function resetForm(): void {
    setPriority('NormalCycle');
    setFormat('UTF8');
    setContent('');
    setLanguage('');
    setState('');
    setStartDateTime('');
    setEndDateTime('');
    setTransactionId('');
    setEvseId('');
  }

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (content.trim() === '') {
      errors.content = t('validation.required');
    }
    return errors;
  }

  const errors = getValidationErrors();

  function handleCreate(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body: Record<string, unknown> = {
      priority,
      format,
      content,
    };
    if (language !== '') body['language'] = language;
    if (state !== '') body['state'] = state;
    if (startDateTime !== '') body['startDateTime'] = new Date(startDateTime).toISOString();
    if (endDateTime !== '') body['endDateTime'] = new Date(endDateTime).toISOString();
    if (transactionId !== '') body['transactionId'] = transactionId;
    if (evseId !== '') body['evseId'] = Number(evseId);
    createMutation.mutate(body);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t('stations.displayMessages')}</CardTitle>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!isOnline || refreshMutation.isPending}
            onClick={() => {
              refreshMutation.mutate();
            }}
          >
            <RefreshCw className={`h-4 w-4 ${refreshMutation.isPending ? 'animate-spin' : ''}`} />
            {refreshMutation.isPending ? t('stations.refreshing') : t('stations.refreshMessages')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!isOnline}
            onClick={() => {
              setHasSubmitted(false);
              setCreateOpen(true);
            }}
          >
            <Send className="h-4 w-4" />
            {t('stations.sendMessage')}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('stations.noDisplayMessages')}</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('stations.messageId')}</TableHead>
                  <TableHead>{t('stations.messagePriority')}</TableHead>
                  <TableHead>{t('stations.messageContent')}</TableHead>
                  <TableHead>{t('stations.messageFormat')}</TableHead>
                  <TableHead>{t('stations.messageState')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>{t('common.created')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {messages.map((msg) => (
                  <TableRow key={msg.id}>
                    <TableCell>{String(msg.ocppMessageId)}</TableCell>
                    <TableCell>{msg.priority}</TableCell>
                    <TableCell className="max-w-[200px] truncate">{msg.content}</TableCell>
                    <TableCell>{msg.format}</TableCell>
                    <TableCell>{msg.state ?? '-'}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANTS[msg.status] ?? 'outline'}>{msg.status}</Badge>
                    </TableCell>
                    <TableCell>{formatDateTime(msg.createdAt, timezone)}</TableCell>
                    <TableCell>
                      {msg.status === 'accepted' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!isOnline || clearMutation.isPending}
                          onClick={() => {
                            setClearTarget(msg);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="mt-4">
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
            </div>
          </>
        )}
      </CardContent>

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('stations.sendMessage')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} noValidate className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="display-msg-priority">{t('stations.messagePriority')}</Label>
                <Select
                  id="display-msg-priority"
                  value={priority}
                  onChange={(e) => {
                    setPriority(e.target.value);
                  }}
                  className="h-9"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="display-msg-format">{t('stations.messageFormat')}</Label>
                <Select
                  id="display-msg-format"
                  value={format}
                  onChange={(e) => {
                    setFormat(e.target.value);
                  }}
                  className="h-9"
                >
                  {FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="msg-content">{t('stations.messageContent')}</Label>
              <textarea
                id="msg-content"
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                }}
                maxLength={1024}
                rows={3}
                className={`flex w-full rounded-md border bg-background px-3 py-2 text-sm ${hasSubmitted && errors.content ? 'border-destructive' : 'border-input'}`}
              />
              {hasSubmitted && errors.content && (
                <p className="text-sm text-destructive">{errors.content}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="msg-language">{t('stations.messageLanguage')}</Label>
                <Input
                  id="msg-language"
                  value={language}
                  onChange={(e) => {
                    setLanguage(e.target.value);
                  }}
                  placeholder="en"
                  maxLength={8}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="display-msg-state">{t('stations.messageState')}</Label>
                <Select
                  id="display-msg-state"
                  value={state}
                  onChange={(e) => {
                    setState(e.target.value);
                  }}
                  className="h-9"
                >
                  <option value="">-</option>
                  {STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="msg-start-time">{t('stations.messageStartTime')}</Label>
                <Input
                  id="msg-start-time"
                  type="datetime-local"
                  value={startDateTime}
                  onChange={(e) => {
                    setStartDateTime(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="msg-end-time">{t('stations.messageEndTime')}</Label>
                <Input
                  id="msg-end-time"
                  type="datetime-local"
                  value={endDateTime}
                  onChange={(e) => {
                    setEndDateTime(e.target.value);
                  }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="msg-transaction-id">{t('stations.messageTransactionId')}</Label>
                <Input
                  id="msg-transaction-id"
                  value={transactionId}
                  onChange={(e) => {
                    setTransactionId(e.target.value);
                  }}
                  maxLength={36}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="msg-evse-id">{t('stations.messageEvseId')}</Label>
                <Input
                  id="msg-evse-id"
                  type="number"
                  value={evseId}
                  onChange={(e) => {
                    setEvseId(e.target.value);
                  }}
                  min={0}
                />
              </div>
            </div>
            <DialogFooter>
              <CancelButton
                onClick={() => {
                  setCreateOpen(false);
                }}
              />
              <Button type="submit" disabled={createMutation.isPending || content.trim() === ''}>
                {createMutation.isPending ? t('common.creating') : t('common.send')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Clear Confirm Dialog */}
      <ConfirmDialog
        open={clearTarget != null}
        onOpenChange={(open) => {
          if (!open) setClearTarget(null);
        }}
        title={t('stations.clearMessage')}
        description={t('stations.confirmClearMessage')}
        confirmLabel={t('stations.clearMessage')}
        onConfirm={() => {
          if (clearTarget != null) {
            clearMutation.mutate(clearTarget.id);
          }
        }}
      />
    </Card>
  );
}
