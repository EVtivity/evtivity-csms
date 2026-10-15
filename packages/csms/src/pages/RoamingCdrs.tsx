// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, RotateCcw, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { useToast } from '@/components/ui/toast';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { cdrPushStatusVariant } from '@/lib/status-variants';
import { LoadingLogo } from '@/components/loading-logo';
import { formatMajorAmount, formatNumber } from '@/lib/formatting';

interface CdrEntry {
  id: number;
  partnerId: string;
  ocpiCdrId: string;
  chargingSessionId: string | null;
  totalEnergy: string;
  totalCost: string;
  currency: string;
  isCredit: boolean;
  hasCredit: boolean;
  supersededAt: string | null;
  pushStatus: string;
  createdAt: string;
  partnerName: string | null;
}

type CdrAction = 'credit' | 'reissue' | 'push';

/** The operator actions a CDR of ours offers now. */
function cdrActions(cdr: CdrEntry): CdrAction[] {
  if (cdr.chargingSessionId == null) return [];
  const actions: CdrAction[] = [];
  if (!cdr.isCredit && cdr.supersededAt == null) {
    // OCPI 10.1: a sent CDR is never changed. Credit it, then issue a new one.
    actions.push(cdr.hasCredit ? 'reissue' : 'credit');
  }
  if (cdr.pushStatus === 'failed') actions.push('push');
  return actions;
}

export function RoamingCdrs(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('roaming:write');
  const [pending, setPending] = useState<{ action: CdrAction; cdr: CdrEntry } | null>(null);
  const [reason, setReason] = useState('');

  const {
    data: cdrs,
    isLoading,
    page,
    totalPages,
    setPage,
  } = usePaginatedQuery<CdrEntry>('ocpi-cdrs', '/v1/ocpi/cdrs');

  const actionMutation = useMutation({
    mutationFn: ({ action, cdr }: { action: CdrAction; cdr: CdrEntry }) => {
      const id = encodeURIComponent(cdr.ocpiCdrId);
      switch (action) {
        case 'credit':
          return api.post('/v1/ocpi/cdrs/credit', { originalCdrId: cdr.ocpiCdrId, reason });
        case 'reissue':
          return api.post(`/v1/ocpi/cdrs/${id}/reissue`, { reason });
        case 'push':
          return api.post(`/v1/ocpi/cdrs/${id}/push`, {});
      }
    },
    onSuccess: (_result, { action }) => {
      toast({ title: t(`roaming.cdrs.${action}Done`), variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['ocpi-cdrs'] });
      setPending(null);
    },
    onError: (err) => {
      toast({
        title: t('roaming.cdrs.actionFailed'),
        description: getErrorMessage(err, t),
        variant: 'destructive',
      });
      void queryClient.invalidateQueries({ queryKey: ['ocpi-cdrs'] });
      setPending(null);
    },
  });

  const needsReason = pending != null && pending.action !== 'push';
  const columns = canWrite ? 8 : 7;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('roaming.cdrs.partner')}</TableHead>
                <TableHead>{t('roaming.cdrs.cdrId')}</TableHead>
                <TableHead>{t('roaming.cdrs.energy')}</TableHead>
                <TableHead>{t('roaming.cdrs.cost')}</TableHead>
                <TableHead>{t('roaming.cdrs.type')}</TableHead>
                <TableHead>{t('roaming.cdrs.pushStatus')}</TableHead>
                <TableHead>{t('common.created')}</TableHead>
                {canWrite && <TableHead>{t('common.actions')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={columns} className="text-center">
                    <LoadingLogo size="inline" />
                  </TableCell>
                </TableRow>
              ) : cdrs == null || cdrs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns} className="text-center text-muted-foreground">
                    {t('roaming.cdrs.noCdrs')}
                  </TableCell>
                </TableRow>
              ) : (
                cdrs.map((cdr) => (
                  <TableRow key={cdr.id}>
                    <TableCell className="font-medium">{cdr.partnerName ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{cdr.ocpiCdrId}</TableCell>
                    <TableCell>{formatNumber(parseFloat(cdr.totalEnergy), 2)} kWh</TableCell>
                    <TableCell>{formatMajorAmount(cdr.totalCost, cdr.currency)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={cdr.isCredit ? 'destructive' : 'default'}>
                          {cdr.isCredit ? t('roaming.cdrs.credit') : t('roaming.cdrs.charge')}
                        </Badge>
                        {cdr.supersededAt != null && (
                          <Badge variant="secondary">{t('roaming.cdrs.superseded')}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={cdrPushStatusVariant(cdr.pushStatus)}>{cdr.pushStatus}</Badge>
                    </TableCell>
                    <TableCell>{formatDateTime(cdr.createdAt, timezone)}</TableCell>
                    {canWrite && (
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          {cdrActions(cdr).map((action) => (
                            <Button
                              key={action}
                              variant="outline"
                              size="sm"
                              className="gap-1.5"
                              onClick={() => {
                                setReason('');
                                setPending({ action, cdr });
                              }}
                            >
                              {action === 'credit' && <Undo2 className="h-4 w-4" />}
                              {action === 'reissue' && <RotateCcw className="h-4 w-4" />}
                              {action === 'push' && <RefreshCw className="h-4 w-4" />}
                              {t(`roaming.cdrs.${action}Action`)}
                            </Button>
                          ))}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}

      <ConfirmDialog
        open={pending != null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending != null ? t(`roaming.cdrs.${pending.action}Title`) : ''}
        description={pending != null ? t(`roaming.cdrs.${pending.action}Description`) : ''}
        confirmLabel={pending != null ? t(`roaming.cdrs.${pending.action}Action`) : ''}
        variant={pending?.action === 'credit' ? 'destructive' : 'default'}
        isPending={actionMutation.isPending}
        onConfirm={() => {
          if (pending == null) return false;
          if (needsReason && reason.trim() === '') return false;
          actionMutation.mutate({ action: pending.action, cdr: pending.cdr });
          return false;
        }}
      >
        {needsReason && (
          <div className="space-y-2">
            <Label htmlFor="cdr-reason">{t('roaming.cdrs.reason')}</Label>
            <Textarea
              id="cdr-reason"
              value={reason}
              maxLength={500}
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
