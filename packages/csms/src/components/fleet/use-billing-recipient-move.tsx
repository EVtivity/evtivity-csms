// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BillingRecipient } from '@/components/bill-to-button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasCompanyWidePermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

interface MoveRequest {
  recipient: BillingRecipient;
  driverIds: string[];
  /** The driver's name for one row; null for all rows. */
  driverName: string | null;
}

interface MoveResult {
  movedCount: number;
}

export interface BillingRecipientMove {
  /** payments:write with access to every site (account invoices span every site). */
  canMove: boolean;
  /** Opens the confirmation for moving the drivers' unbilled sessions of the period. */
  request: (move: MoveRequest) => void;
  dialog: React.JSX.Element;
}

/**
 * The "Bill to Driver" and "Bill to Fleet" actions of the invoice preview:
 * after a ConfirmDialog, moves the drivers' unbilled sessions of the period
 * between the fleet invoice and their member invoices
 * (POST /v1/fleets/:id/billing-recipient) and reloads the preview.
 */
export function useBillingRecipientMove(fleetId: string, period: string): BillingRecipientMove {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canMove = useHasCompanyWidePermission('payments:write');
  const [pending, setPending] = useState<MoveRequest | null>(null);

  const mutation = useMutation({
    mutationFn: (move: MoveRequest) =>
      api.post<MoveResult>(`/v1/fleets/${fleetId}/billing-recipient`, {
        recipient: move.recipient,
        driverIds: move.driverIds,
        period,
      }),
    onSuccess: (result) => {
      toast({
        variant: 'success',
        title: t('billingRecipient.movedCount', { count: result.movedCount }),
      });
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId] });
    },
    onError: (err: unknown) => {
      toast({
        variant: 'destructive',
        title: getErrorMessage(err, t, 'billingRecipient.moveFailed'),
      });
    },
    onSettled: () => {
      setPending(null);
    },
  });

  const toMember = pending?.recipient === 'member';
  const description =
    pending == null
      ? ''
      : pending.driverName != null
        ? t(
            toMember
              ? 'billingRecipient.driverToDriverDescription'
              : 'billingRecipient.driverToFleetDescription',
            { driver: pending.driverName },
          )
        : t(
            toMember
              ? 'billingRecipient.allToDriversDescription'
              : 'billingRecipient.allToFleetDescription',
            { count: pending.driverIds.length },
          );

  const dialog = (
    <ConfirmDialog
      open={pending != null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      variant="default"
      title={toMember ? t('billingRecipient.toDriverTitle') : t('billingRecipient.toFleetTitle')}
      description={description}
      confirmLabel={
        toMember ? t('billingRecipient.billToDriver') : t('billingRecipient.billToFleet')
      }
      isPending={mutation.isPending}
      onConfirm={() => {
        if (pending != null) mutation.mutate(pending);
        return false;
      }}
    />
  );

  return { canMove, request: setPending, dialog };
}
