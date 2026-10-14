// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RemoveButton } from '@/components/remove-button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { formatDateTime } from '@/lib/timezone';

export interface DriverEraseCardProps {
  driver: { id: string; erasedAt?: string | null };
  timezone: string;
}

/**
 * Erasure of the driver's personal data (POST /v1/drivers/:id/erase).
 * Irreversible, so the operator types the driver id to confirm. Shown to
 * users with drivers:write and access to every site (the API refuses others).
 */
export function DriverEraseCard({
  driver,
  timezone,
}: DriverEraseCardProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('drivers:write');
  const hasAllSiteAccess = useHasAllSiteAccess();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [mismatch, setMismatch] = useState(false);

  const eraseMutation = useMutation({
    mutationFn: () => api.post(`/v1/drivers/${driver.id}/erase`, { confirm: driver.id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drivers'] });
      void queryClient.invalidateQueries({ queryKey: ['audit', 'driver'] });
      setOpen(false);
      toast({ title: t('drivers.eraseSuccess'), variant: 'success' });
    },
  });

  if (driver.erasedAt != null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('drivers.eraseTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t('drivers.erasedOn', { date: formatDateTime(driver.erasedAt, timezone) })}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!canWrite || !hasAllSiteAccess) return null;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('drivers.eraseTitle')}</CardTitle>
        <RemoveButton
          label={t('drivers.erase')}
          onClick={() => {
            setConfirmText('');
            setMismatch(false);
            eraseMutation.reset();
            setOpen(true);
          }}
        />
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{t('drivers.eraseHelp')}</p>
      </CardContent>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('drivers.eraseConfirmTitle')}
        description={t('drivers.eraseConfirmDescription')}
        confirmLabel={t('drivers.erase')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        isPending={eraseMutation.isPending}
        onConfirm={() => {
          if (confirmText.trim() !== driver.id) {
            setMismatch(true);
            return false;
          }
          eraseMutation.mutate();
          return false;
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="erase-confirm">{t('drivers.eraseConfirmLabel', { id: driver.id })}</Label>
          <Input
            id="erase-confirm"
            autoComplete="off"
            value={confirmText}
            onChange={(e) => {
              setConfirmText(e.target.value);
              setMismatch(false);
            }}
            className={mismatch ? 'border-destructive' : ''}
          />
          {mismatch && (
            <p className="text-sm text-destructive">{t('drivers.eraseConfirmMismatch')}</p>
          )}
          {eraseMutation.isError && (
            <p className="text-sm text-destructive">{getErrorMessage(eraseMutation.error, t)}</p>
          )}
        </div>
      </ConfirmDialog>
    </Card>
  );
}
