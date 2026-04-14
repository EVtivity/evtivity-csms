// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Search, X } from 'lucide-react';
import { BackButton } from '@/components/back-button';
import { AddIconButton } from '@/components/add-icon-button';
import { CopyableId } from '@/components/copyable-id';
import { RefundButton } from '@/components/refund-button';
import { RemoveIconButton } from '@/components/remove-icon-button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { MessageThread } from '@/components/support/MessageThread';
import { CaseInfoSidebar } from '@/components/support/CaseInfoSidebar';
import { api } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

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

interface SessionRef {
  id: string;
  transactionId: string;
  stationName: string | null;
  driverName: string | null;
  status: string | null;
}

interface CaseDetail {
  id: string;
  caseNumber: string;
  subject: string;
  description: string;
  status: string;
  category: string;
  priority: string;
  driverId: string | null;
  driverName: string | null;
  driverEmail: string | null;
  sessions: SessionRef[];
  stationId: string | null;
  stationName: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  createdByDriver: boolean;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

interface PaymentRecord {
  id: number;
  status: string;
  capturedAmountCents: number | null;
  refundedAmountCents: number;
  currency: string;
}

export function SupportCaseDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [refundSession, setRefundSession] = useState<SessionRef | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundError, setRefundError] = useState('');
  const [removeSessionId, setRemoveSessionId] = useState<string | null>(null);
  const [sessionSearch, setSessionSearch] = useState('');
  const [showSessionSearch, setShowSessionSearch] = useState(false);

  const { data: securityPublic } = useQuery({
    queryKey: ['security-public'],
    queryFn: () => api.get<{ supportAiEnabled: boolean }>('/v1/security/public'),
  });

  const supportAiEnabled = securityPublic?.supportAiEnabled === true;

  const { data: caseDetail, isLoading } = useQuery({
    queryKey: ['support-cases', id],
    queryFn: () => api.get<CaseDetail>(`/v1/support-cases/${id ?? ''}`),
    enabled: id != null,
  });

  const messageCount = caseDetail?.messages.length ?? 0;
  useEffect(() => {
    if (id == null) return;
    api
      .post(`/v1/support-cases/${id}/read`, {})
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ['support-cases-unread-count'] });
        void queryClient.invalidateQueries({ queryKey: ['support-cases'] });
      })
      .catch(() => {});
  }, [id, messageCount, queryClient]);

  const { data: operatorUsers } = useQuery({
    queryKey: ['users-list'],
    queryFn: () => api.get<{ data: User[] }>('/v1/users?limit=100'),
  });

  const { data: s3Status } = useQuery({
    queryKey: ['s3-status'],
    queryFn: () => api.get<{ configured: boolean }>('/v1/settings/s3/status'),
  });

  // Fetch payment for each linked session
  const paymentQueries = useQueries({
    queries: (caseDetail?.sessions ?? []).map((session) => ({
      queryKey: ['session-payment', session.id],
      queryFn: () => api.get<PaymentRecord>(`/v1/sessions/${session.id}/payment`),
      retry: false,
    })),
  });

  const paymentBySessionId = new Map<string, PaymentRecord>();
  if (caseDetail != null) {
    for (let i = 0; i < caseDetail.sessions.length; i++) {
      const session = caseDetail.sessions[i];
      const query = paymentQueries[i];
      if (session != null && query?.data != null) {
        paymentBySessionId.set(session.id, query.data);
      }
    }
  }

  interface SessionSearchResult {
    id: string;
    transactionId: string;
    stationName: string | null;
    driverName: string | null;
    status: string | null;
    finalCostCents: number | null;
    currency: string | null;
  }

  const { data: sessionSearchResults } = useQuery({
    queryKey: ['session-search', sessionSearch],
    queryFn: () =>
      api.get<{ data: SessionSearchResult[] }>(
        `/v1/sessions?search=${encodeURIComponent(sessionSearch)}&limit=5`,
      ),
    enabled: sessionSearch.length >= 2,
  });

  const addSessionMutation = useMutation({
    mutationFn: (sessionId: string) =>
      api.patch(`/v1/support-cases/${id ?? ''}`, { addSessionIds: [sessionId] }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['support-cases', id] });
      setSessionSearch('');
      setShowSessionSearch(false);
    },
  });

  const removeSessionMutation = useMutation({
    mutationFn: (sessionId: string) =>
      api.patch(`/v1/support-cases/${id ?? ''}`, { removeSessionIds: [sessionId] }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['support-cases', id] });
    },
  });

  const refundMutation = useMutation({
    mutationFn: (data: { sessionId: string; amountCents?: number }) =>
      api.post(`/v1/support-cases/${id ?? ''}/refund`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['support-cases', id] });
      if (refundSession != null) {
        void queryClient.invalidateQueries({ queryKey: ['session-payment', refundSession.id] });
      }
      setRefundSession(null);
      setRefundAmount('');
    },
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  if (caseDetail == null) {
    return <p className="text-sm text-destructive">Case not found</p>;
  }

  function canRefundSession(sessionId: string): boolean {
    const payment = paymentBySessionId.get(sessionId);
    return (
      payment != null && (payment.status === 'captured' || payment.status === 'partially_refunded')
    );
  }

  function handleRefundConfirm(): boolean {
    if (refundSession == null) return false;
    const cents = Math.round(parseFloat(refundAmount) * 100);
    if (isNaN(cents) || cents <= 0) {
      setRefundError(t('supportCases.refundAmountRequired'));
      return false;
    }
    const payment = paymentBySessionId.get(refundSession.id);
    const remaining = (payment?.capturedAmountCents ?? 0) - (payment?.refundedAmountCents ?? 0);
    if (cents > remaining) {
      setRefundError(
        t('supportCases.refundExceedsRemaining', { amount: (remaining / 100).toFixed(2) }),
      );
      return false;
    }
    setRefundError('');
    refundMutation.mutate({ sessionId: refundSession.id, amountCents: cents });
    return true;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/support-cases" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{caseDetail.caseNumber}</h1>
          <CopyableId id={caseDetail.id} />
        </div>
        <Badge>{t(`supportCases.statuses.${caseDetail.status}`, caseDetail.status)}</Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Subject and description */}
          <Card>
            <CardHeader>
              <CardTitle>{caseDetail.subject}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3">
                {caseDetail.description}
              </div>
              {caseDetail.driverName != null && (
                <Row label={t('supportCases.driver')}>
                  <Link
                    to={`/drivers/${caseDetail.driverId ?? ''}`}
                    className="text-primary hover:underline"
                  >
                    {caseDetail.driverName}
                  </Link>
                  {caseDetail.driverEmail != null && (
                    <span className="ml-2 text-muted-foreground">({caseDetail.driverEmail})</span>
                  )}
                </Row>
              )}
              <Row label={t('common.created')}>
                {formatDateTime(caseDetail.createdAt, timezone)}
              </Row>
              <Row label={t('common.lastUpdated')}>
                {formatDateTime(caseDetail.updatedAt, timezone)}
              </Row>
              {caseDetail.resolvedAt != null && (
                <Row label={t('supportCases.resolvedAt')}>
                  {formatDateTime(caseDetail.resolvedAt, timezone)}
                </Row>
              )}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    {t('supportCases.linkedSessions')}
                  </span>
                  <AddIconButton
                    title={t('supportCases.addSession')}
                    size="sm"
                    onClick={() => {
                      setShowSessionSearch(true);
                    }}
                  />
                </div>
                {showSessionSearch && (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={sessionSearch}
                      onChange={(e) => {
                        setSessionSearch(e.target.value);
                      }}
                      placeholder={t('supportCases.searchSessionPlaceholder')}
                      className="pl-9 pr-9"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setShowSessionSearch(false);
                        setSessionSearch('');
                      }}
                      className="absolute inset-y-0 right-3 flex items-center text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                    {sessionSearch.length >= 2 &&
                      sessionSearchResults?.data != null &&
                      sessionSearchResults.data.length > 0 && (
                        <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-md">
                          {sessionSearchResults.data
                            .filter((s) => !caseDetail.sessions.some((cs) => cs.id === s.id))
                            .map((s) => (
                              <button
                                key={s.id}
                                type="button"
                                onClick={() => {
                                  addSessionMutation.mutate(s.id);
                                }}
                                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-accent"
                              >
                                <span className="text-sm font-medium">{s.id}</span>
                                <span className="text-xs text-muted-foreground">
                                  {[
                                    s.stationName,
                                    s.driverName,
                                    s.status,
                                    s.finalCostCents != null && s.currency != null
                                      ? `${(s.finalCostCents / 100).toFixed(2)} ${s.currency.toUpperCase()}`
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join(' \u00B7 ')}
                                </span>
                              </button>
                            ))}
                        </div>
                      )}
                  </div>
                )}
                {caseDetail.sessions.length > 0 && (
                  <div className="rounded-md border overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('supportCases.sessionColumn')}</TableHead>
                          <TableHead>{t('supportCases.station')}</TableHead>
                          <TableHead>{t('supportCases.driver')}</TableHead>
                          <TableHead>{t('supportCases.status')}</TableHead>
                          <TableHead>{t('supportCases.chargedColumn')}</TableHead>
                          <TableHead>{t('supportCases.refundedColumn')}</TableHead>
                          <TableHead className="text-right">
                            {t('supportCases.actionsColumn')}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {caseDetail.sessions.map((session) => {
                          const payment = paymentBySessionId.get(session.id);
                          const captured = payment?.capturedAmountCents ?? 0;
                          const refunded = payment?.refundedAmountCents ?? 0;
                          const remaining = captured - refunded;
                          const currency = payment != null ? payment.currency.toUpperCase() : 'USD';
                          const fmt = (cents: number) => (cents / 100).toFixed(2);
                          return (
                            <TableRow key={session.id}>
                              <TableCell>
                                <Link
                                  to={`/sessions/${session.id}`}
                                  className="text-primary hover:underline text-sm"
                                >
                                  {session.id}
                                </Link>
                              </TableCell>
                              <TableCell className="text-sm">
                                {session.stationName ?? '--'}
                              </TableCell>
                              <TableCell className="text-sm">
                                {session.driverName ?? '--'}
                              </TableCell>
                              <TableCell className="text-sm">
                                {session.status != null ? (
                                  <Badge
                                    variant={
                                      session.status === 'active'
                                        ? 'success'
                                        : session.status === 'completed'
                                          ? 'secondary'
                                          : session.status === 'failed'
                                            ? 'destructive'
                                            : 'warning'
                                    }
                                  >
                                    {session.status}
                                  </Badge>
                                ) : (
                                  '--'
                                )}
                              </TableCell>
                              <TableCell className="text-sm">
                                {payment != null && captured > 0
                                  ? `${fmt(captured)} ${currency}`
                                  : '--'}
                              </TableCell>
                              <TableCell className="text-sm">
                                {payment != null && refunded > 0 ? (
                                  <span className="text-destructive">
                                    -{fmt(refunded)} {currency}
                                    {payment.status === 'refunded' && (
                                      <Badge variant="outline" className="ml-2 text-xs">
                                        {t('supportCases.fullyRefunded')}
                                      </Badge>
                                    )}
                                  </span>
                                ) : (
                                  '--'
                                )}
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex items-center justify-end gap-2">
                                  {canRefundSession(session.id) && (
                                    <RefundButton
                                      label={`${t('supportCases.refundSession')} ${fmt(remaining)} ${currency}`}
                                      size="sm"
                                      onClick={() => {
                                        setRefundSession(session);
                                        setRefundAmount((remaining / 100).toFixed(2));
                                      }}
                                    />
                                  )}
                                  <RemoveIconButton
                                    title={t('common.remove')}
                                    size="sm"
                                    onClick={() => {
                                      setRemoveSessionId(session.id);
                                    }}
                                  />
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
              {caseDetail.stationName != null && (
                <Row label={t('supportCases.station')}>{caseDetail.stationName}</Row>
              )}
            </CardContent>
          </Card>

          {/* Messages thread */}
          <MessageThread
            caseId={caseDetail.id}
            messages={caseDetail.messages}
            timezone={timezone}
            s3Configured={s3Status?.configured === true}
            supportAiEnabled={supportAiEnabled}
            onMessageSent={() => {
              void queryClient.invalidateQueries({ queryKey: ['support-cases', id] });
            }}
          />
        </div>

        {/* Sidebar controls */}
        <CaseInfoSidebar caseDetail={caseDetail} operatorUsers={operatorUsers?.data} />
      </div>

      <ConfirmDialog
        open={refundSession != null}
        onOpenChange={(open) => {
          if (!open) {
            setRefundSession(null);
            setRefundAmount('');
            setRefundError('');
          }
        }}
        title={t('supportCases.issueRefund')}
        description={
          refundSession != null
            ? `${t('supportCases.confirmRefund')} (${refundSession.transactionId})`
            : t('supportCases.confirmRefund')
        }
        confirmLabel={t('supportCases.issueRefund')}
        confirmIcon={<RotateCcw className="h-4 w-4" />}
        onConfirm={handleRefundConfirm}
      >
        <div className="space-y-2">
          <Label htmlFor="support-case-refund-amount">{t('supportCases.refundAmountLabel')}</Label>
          <Input
            id="support-case-refund-amount"
            type="number"
            step="0.01"
            min="0.01"
            value={refundAmount}
            onChange={(e) => {
              setRefundAmount(e.target.value);
              setRefundError('');
            }}
            className={refundError !== '' ? 'border-destructive' : ''}
          />
          {refundError !== '' && <p className="text-sm text-destructive">{refundError}</p>}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={removeSessionId != null}
        onOpenChange={(open) => {
          if (!open) setRemoveSessionId(null);
        }}
        title={t('supportCases.removeSession')}
        description={t('supportCases.confirmRemoveSession')}
        confirmLabel={t('common.remove')}
        variant="destructive"
        onConfirm={() => {
          if (removeSessionId != null) {
            removeSessionMutation.mutate(removeSessionId);
          }
          setRemoveSessionId(null);
        }}
      />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="text-muted-foreground shrink-0 w-24">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
