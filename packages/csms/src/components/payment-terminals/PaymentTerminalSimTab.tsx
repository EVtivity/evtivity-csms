// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isValidIccid } from '@evtivity/lib/iccid';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TabPanel } from '@/components/ui/tab-panel';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { PAYMENT_TERMINALS_KEY, type PaymentTerminal } from './payment-terminal-types';

/**
 * The SIM tab: a terminal with its own SIM (the VP6825 LTE variants) gets the
 * SIM features. Entering the ICCID attaches the SIM; Detach SIM closes the
 * attachment. Both need `sims:write` too.
 */
export function PaymentTerminalSimTab({
  terminal,
}: {
  terminal: PaymentTerminal;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const hasTerminalWrite = useHasPermission('paymentTerminals:write');
  const hasSimsWrite = useHasPermission('sims:write');
  const canWrite = hasTerminalWrite && hasSimsWrite;
  const canReadSims = useHasPermission('sims:read');
  const [iccid, setIccid] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [detachOpen, setDetachOpen] = useState(false);

  function onChanged(): void {
    void queryClient.invalidateQueries({ queryKey: PAYMENT_TERMINALS_KEY });
    void queryClient.invalidateQueries({ queryKey: ['sims'] });
    void queryClient.invalidateQueries({ queryKey: ['audit', 'payment_terminal'] });
  }

  const attach = useMutation({
    mutationFn: (value: string) =>
      api.post(`/v1/payment-terminals/${terminal.id}/sim`, { iccid: value }),
    onSuccess: () => {
      setIccid('');
      setHasSubmitted(false);
      toast({ variant: 'success', title: t('paymentTerminals.sim.attachSuccess') });
      onChanged();
    },
  });

  const detach = useMutation({
    mutationFn: () => api.delete(`/v1/payment-terminals/${terminal.id}/sim`),
    onSuccess: () => {
      setDetachOpen(false);
      toast({ variant: 'success', title: t('paymentTerminals.sim.detachSuccess') });
      onChanged();
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  const value = iccid.replace(/\s+/g, '');
  const error =
    value === ''
      ? t('validation.required')
      : !isValidIccid(value)
        ? t('paymentTerminals.sim.iccidInvalid')
        : undefined;
  const shownError = hasSubmitted ? error : undefined;

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (error != null) return;
    attach.mutate(value);
  }

  return (
    <TabPanel
      title={t('paymentTerminals.detail.tabs.sim')}
      description={t('paymentTerminals.sim.description')}
      actions={
        terminal.simAttached && canWrite ? (
          <Button
            variant="outline"
            onClick={() => {
              setDetachOpen(true);
            }}
          >
            {t('paymentTerminals.sim.detach')}
          </Button>
        ) : undefined
      }
      bodyClassName="space-y-4"
    >
      {terminal.simAttached ? (
        <div className="space-y-2 text-sm" data-testid="terminal-sim-attached">
          <p>{t('paymentTerminals.sim.attached')}</p>
          {canReadSims && (
            <Link to="/sims" className="text-link hover:underline">
              {t('paymentTerminals.sim.openSims')}
            </Link>
          )}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" data-testid="terminal-sim-none">
            {t('paymentTerminals.sim.none')}
          </p>
          {canWrite && (
            <form onSubmit={handleSubmit} noValidate className="space-y-2">
              <Label htmlFor="terminal-sim-iccid" className="leading-6">
                {t('paymentTerminals.sim.iccid')}
              </Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="terminal-sim-iccid"
                  value={iccid}
                  inputMode="numeric"
                  autoComplete="off"
                  className={shownError != null ? 'border-destructive sm:max-w-sm' : 'sm:max-w-sm'}
                  onChange={(e) => {
                    setIccid(e.target.value);
                    attach.reset();
                  }}
                />
                <Button type="submit" disabled={attach.isPending}>
                  {t('paymentTerminals.sim.attach')}
                </Button>
              </div>
              {shownError != null && <p className="text-sm text-destructive">{shownError}</p>}
              {attach.isError && (
                <p className="text-sm text-destructive">{getErrorMessage(attach.error, t)}</p>
              )}
              <p className="text-xs text-muted-foreground">{t('paymentTerminals.sim.iccidHint')}</p>
            </form>
          )}
        </>
      )}
      <ConfirmDialog
        open={detachOpen}
        onOpenChange={setDetachOpen}
        title={t('paymentTerminals.sim.detach')}
        description={t('paymentTerminals.sim.detachDescription')}
        confirmLabel={t('paymentTerminals.sim.detach')}
        isPending={detach.isPending}
        onConfirm={() => {
          detach.mutate();
          return false;
        }}
      />
    </TabPanel>
  );
}
