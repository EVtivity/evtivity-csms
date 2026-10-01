// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime } from '@/lib/timezone';

export interface PortalAccess {
  status: 'active' | 'invited' | 'none';
  inviteExpiresAt: string | null;
}

export interface DriverPortalAccessCardProps {
  driver: { id: string; email: string | null; isActive: boolean; portalAccess?: PortalAccess };
  timezone: string;
}

const STATUS_VARIANT = { active: 'success', invited: 'warning', none: 'outline' } as const;

export function DriverPortalAccessCard({
  driver,
  timezone,
}: DriverPortalAccessCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('drivers:write');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const access = driver.portalAccess ?? { status: 'none', inviteExpiresAt: null };

  const inviteMutation = useMutation({
    mutationFn: () => api.post<{ expiresAt: string }>(`/v1/drivers/${driver.id}/portal-invite`, {}),
    onSuccess: () => {
      toast({ title: t('drivers.portalInviteSent'), variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['drivers', driver.id] });
      setConfirmOpen(false);
    },
    onError: (err) => {
      toast({
        title: t('drivers.portalInviteFailed'),
        description: getErrorMessage(err, t),
        variant: 'destructive',
      });
      setConfirmOpen(false);
    },
  });

  const hasEmail = driver.email != null && driver.email !== '';
  const disabledReason = !driver.isActive
    ? t('drivers.portalInviteInactive')
    : !hasEmail
      ? t('drivers.portalInviteNoEmail')
      : null;
  const inviteLabel =
    access.status === 'invited' ? t('drivers.resendInvite') : t('drivers.invitePortal');

  const inviteButton = (
    <Button
      variant="outline"
      disabled={disabledReason != null}
      onClick={() => {
        setConfirmOpen(true);
      }}
    >
      <Mail className="h-4 w-4" />
      {inviteLabel}
    </Button>
  );

  return (
    <Card data-testid="driver-portal-access">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('drivers.portalAccess')}</CardTitle>
        {canWrite &&
          access.status !== 'active' &&
          (disabledReason != null ? (
            <Tooltip content={disabledReason}>{inviteButton}</Tooltip>
          ) : (
            inviteButton
          ))}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div>
          <Badge variant={STATUS_VARIANT[access.status]}>
            {t(`drivers.portalStatus.${access.status}`)}
          </Badge>
        </div>
        {access.status === 'invited' && access.inviteExpiresAt != null && (
          <p className="text-muted-foreground">
            {t('drivers.portalInviteExpires', {
              date: formatDateTime(access.inviteExpiresAt, timezone),
            })}
          </p>
        )}
        <p className="text-muted-foreground">{t(`drivers.portalStatusHelp.${access.status}`)}</p>
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={inviteLabel}
        description={t('drivers.portalInviteConfirm', { email: driver.email ?? '' })}
        confirmLabel={t('drivers.sendInvite')}
        variant="default"
        isPending={inviteMutation.isPending}
        onConfirm={() => {
          inviteMutation.mutate();
          return false;
        }}
      />
    </Card>
  );
}
