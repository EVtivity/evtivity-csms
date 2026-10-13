// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { useToast } from '@/components/ui/toast';
import { api, getApiErrorCode } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

/** Who the account invoices of a fleet go to: the fleet, or each member driver. */
export type AccountInvoiceRecipient = 'fleet' | 'member';

export interface FleetBillingTabProps {
  fleet: {
    id: string;
    accountBillingEnabled?: boolean;
    accountInvoiceRecipient?: AccountInvoiceRecipient;
  };
}

/** The change a confirm dialog asks for. */
type PendingChange =
  | { kind: 'enabled'; value: boolean }
  | { kind: 'recipient'; value: AccountInvoiceRecipient };

/**
 * Charge on account for the fleet (the members' sessions are billed on
 * account) and who the account invoices go to: the fleet billing contacts or
 * each member driver. The API refuses a change older processes cannot follow
 * (409 FLEET_BILLING_OLD_PODS_CONNECTED), or cannot confirm the upgrade
 * because the worker's version check is stale (409
 * FLEET_BILLING_VERSION_CHECK_STALE); the card shows either inline.
 */
export function FleetBillingTab({ fleet }: FleetBillingTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('fleets:write');
  const enabled = fleet.accountBillingEnabled === true;
  const recipient: AccountInvoiceRecipient = fleet.accountInvoiceRecipient ?? 'fleet';
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (change: PendingChange) =>
      api.patch(
        `/v1/fleets/${fleet.id}/billing`,
        change.kind === 'enabled'
          ? { accountBillingEnabled: change.value }
          : { accountInvoiceRecipient: change.value },
      ),
    onSuccess: () => {
      toast({ title: t('fleets.billing.updated'), variant: 'success' });
      setUpgradeError(null);
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleet.id] });
      setPending(null);
    },
    onError: (err) => {
      const code = getApiErrorCode(err);
      if (
        code === 'FLEET_BILLING_OLD_PODS_CONNECTED' ||
        code === 'FLEET_BILLING_VERSION_CHECK_STALE'
      ) {
        setUpgradeError(getErrorMessage(err, t));
      } else {
        toast({
          title: t('fleets.billing.updateFailed'),
          description: getErrorMessage(err, t),
          variant: 'destructive',
        });
      }
      setPending(null);
    },
  });

  const dialog =
    pending == null
      ? null
      : pending.kind === 'enabled'
        ? {
            title: pending.value
              ? t('fleets.billing.enableTitle')
              : t('fleets.billing.disableTitle'),
            description: pending.value
              ? t('fleets.billing.enableConfirm')
              : t('fleets.billing.disableConfirm'),
            confirmLabel: pending.value ? t('fleets.billing.enable') : t('fleets.billing.disable'),
          }
        : {
            title:
              pending.value === 'member'
                ? t('fleets.billing.recipientTitleMember')
                : t('fleets.billing.recipientTitleFleet'),
            description:
              pending.value === 'member'
                ? t('fleets.billing.recipientConfirmMember')
                : t('fleets.billing.recipientConfirmFleet'),
            confirmLabel: t('fleets.billing.recipientChange'),
          };

  return (
    <Card data-testid="fleet-billing">
      <CardHeader>
        <CardTitle>{t('fleets.billing.title')}</CardTitle>
        <CardDescription>{t('fleets.billing.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Toggle
              id="fleet-account-billing"
              checked={enabled}
              disabled={!canWrite || mutation.isPending}
              aria-label={t('fleets.billing.chargeOnAccount')}
              onCheckedChange={() => {
                setPending({ kind: 'enabled', value: !enabled });
              }}
            />
            <Label htmlFor="fleet-account-billing">{t('fleets.billing.chargeOnAccount')}</Label>
            <Badge variant={enabled ? 'success' : 'outline'}>
              {enabled ? t('fleets.billing.on') : t('fleets.billing.off')}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            {enabled ? t('fleets.billing.helpOn') : t('fleets.billing.helpOff')}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="fleet-invoice-recipient">{t('fleets.billing.invoiceTo')}</Label>
          <Select
            id="fleet-invoice-recipient"
            className="sm:max-w-xs"
            value={recipient}
            disabled={!canWrite || mutation.isPending}
            onChange={(event) => {
              const value = event.target.value as AccountInvoiceRecipient;
              if (value !== recipient) setPending({ kind: 'recipient', value });
            }}
          >
            <option value="fleet">{t('fleets.billing.recipientFleet')}</option>
            <option value="member">{t('fleets.billing.recipientMember')}</option>
          </Select>
          <p className="text-muted-foreground">
            {recipient === 'member'
              ? t('fleets.billing.recipientHelpMember')
              : t('fleets.billing.recipientHelpFleet')}
          </p>
        </div>
        {upgradeError != null && (
          <p className="text-destructive" role="alert" data-testid="fleet-billing-upgrade-error">
            {upgradeError}
          </p>
        )}
      </CardContent>
      <ConfirmDialog
        open={pending != null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={dialog?.title ?? ''}
        description={dialog?.description ?? ''}
        confirmLabel={dialog?.confirmLabel ?? ''}
        variant="default"
        isPending={mutation.isPending}
        onConfirm={() => {
          if (pending != null) mutation.mutate(pending);
          return false;
        }}
      />
    </Card>
  );
}
