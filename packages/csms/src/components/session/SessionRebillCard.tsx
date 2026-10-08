// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatCents } from '@/lib/formatting';

/** The stopped reason of a session the CSMS gave up ending (`EndRequestFailed`). */
export const END_REQUEST_FAILED = 'EndRequestFailed';

export type RebillStatus = 'in_progress' | 'billed' | 'manual';

/** Why the API cannot re-bill the session now (`rebillBlockedReason`). */
export type RebillBlockedReason =
  | 'status'
  | 'already_rebilled'
  | 'roaming'
  | 'free_vend'
  | 'no_tariff'
  | 'paid'
  | 'in_progress'
  | 'payment_pending';

export interface SessionRebillCardProps {
  session: {
    id: string;
    status: string;
    stoppedReason: string | null;
    rebillStatus?: RebillStatus | null;
    finalCostCents: number | null;
    currency: string;
    /** Server-computed: the re-bill can run now (an expired claim or a re-bill's own record does not block it). */
    rebillable: boolean;
    rebillBlockedReason: RebillBlockedReason | null;
  };
}

interface RebillResult {
  rebillStatus: 'billed' | 'manual';
  result: 'charged' | 'prepaid' | 'account' | 'no_charge' | 'manual';
  manualReason: ManualReason | null;
}

const RESULT_TOAST = {
  charged: 'sessions.rebill.charged',
  prepaid: 'sessions.rebill.prepaid',
  account: 'sessions.rebill.account',
  no_charge: 'sessions.rebill.noCharge',
  manual: 'sessions.rebill.manual',
} as const;

const MANUAL_REASON = {
  no_payment_method: 'sessions.rebill.manualReason.no_payment_method',
  payment_failed: 'sessions.rebill.manualReason.payment_failed',
  guest: 'sessions.rebill.manualReason.guest',
  no_driver: 'sessions.rebill.manualReason.no_driver',
  prepaid_not_debited: 'sessions.rebill.manualReason.prepaid_not_debited',
  prepaid_record_exists: 'sessions.rebill.manualReason.prepaid_record_exists',
} as const;

type ManualReason = keyof typeof MANUAL_REASON;

/** Whether the session is one the CSMS gave up ending, before or after an operator billed it. */
export function isRebillSession(session: SessionRebillCardProps['session']): boolean {
  return (
    session.stoppedReason === END_REQUEST_FAILED &&
    (session.status === 'faulted' ||
      session.rebillStatus === 'billed' ||
      session.rebillStatus === 'manual')
  );
}

/** The tooltip of a disabled "Bill session" button. */
function blockedReasonText(session: SessionRebillCardProps['session'], t: TFunction): string {
  switch (session.rebillBlockedReason) {
    case 'in_progress':
      return t('sessions.rebill.inProgress');
    case 'payment_pending':
      return t('sessions.rebill.paymentPending');
    case null:
      return t('sessions.rebill.notEligible.status');
    default:
      return t(`sessions.rebill.notEligible.${session.rebillBlockedReason}`);
  }
}

/**
 * Billing of a session the CSMS could not end (stopped reason
 * EndRequestFailed): the "Bill session" action while it is unbilled, then
 * whether it was billed or is waiting for manual billing. The action needs
 * sessions:write and payments:write; the API decides eligibility
 * (`rebillable`), and the button is disabled with its reason otherwise.
 */
export function SessionRebillCard({ session }: SessionRebillCardProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWriteSessions = useHasPermission('sessions:write');
  const canWritePayments = useHasPermission('payments:write');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const rebillMutation = useMutation({
    mutationFn: () => api.post<RebillResult>(`/v1/sessions/${session.id}/rebill`, {}),
    onSuccess: (result) => {
      toast({
        title: t(RESULT_TOAST[result.result]),
        ...(result.manualReason != null
          ? { description: t(MANUAL_REASON[result.manualReason]) }
          : {}),
        variant: result.rebillStatus === 'manual' ? 'warning' : 'success',
      });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setConfirmOpen(false);
    },
    onError: (err) => {
      const reason =
        err instanceof ApiError &&
        typeof err.body === 'object' &&
        err.body != null &&
        'details' in err.body
          ? (err.body as { details?: { reason?: unknown } }).details?.reason
          : undefined;
      toast({
        title: t('sessions.rebill.failed'),
        description:
          typeof reason === 'string'
            ? t(`sessions.rebill.notEligible.${reason}`, {
                defaultValue: getErrorMessage(err, t),
              })
            : getErrorMessage(err, t),
        variant: 'destructive',
      });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setConfirmOpen(false);
    },
  });

  if (!isRebillSession(session)) return null;

  if (session.rebillStatus === 'billed' || session.rebillStatus === 'manual') {
    const manual = session.rebillStatus === 'manual';
    return (
      <Card data-testid="session-rebill">
        <CardHeader>
          <CardTitle>{t('sessions.rebill.cardTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Badge variant={manual ? 'warning' : 'success'}>
            {manual ? t('sessions.manualBilling') : t('sessions.rebill.billedBadge')}
          </Badge>
          <p className="text-muted-foreground">
            {manual
              ? t('sessions.rebill.manualHelp', {
                  cost: formatCents(session.finalCostCents ?? 0, session.currency),
                })
              : t('sessions.rebill.billedHelp')}
          </p>
        </CardContent>
      </Card>
    );
  }

  const canBill = canWriteSessions && canWritePayments;
  const disabledReason = session.rebillable ? null : blockedReasonText(session, t);

  const billButton = (
    <Button
      variant="outline"
      disabled={disabledReason != null || rebillMutation.isPending}
      onClick={() => {
        setConfirmOpen(true);
      }}
    >
      <Receipt className="h-4 w-4" />
      {t('sessions.rebill.button')}
    </Button>
  );

  return (
    <Card data-testid="session-rebill">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('sessions.rebill.cardTitle')}</CardTitle>
        {canBill &&
          (disabledReason != null ? (
            <Tooltip content={disabledReason}>{billButton}</Tooltip>
          ) : (
            billButton
          ))}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Badge variant="destructive">{t('sessions.rebill.unbilledBadge')}</Badge>
        <p className="text-muted-foreground">{t('sessions.rebill.unbilledHelp')}</p>
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('sessions.rebill.confirmTitle')}
        description={t('sessions.rebill.confirmDescription')}
        confirmLabel={t('sessions.rebill.button')}
        variant="default"
        isPending={rebillMutation.isPending}
        onConfirm={() => {
          rebillMutation.mutate();
          return false;
        }}
      />
    </Card>
  );
}
