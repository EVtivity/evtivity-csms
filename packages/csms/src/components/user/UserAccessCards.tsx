// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldOff, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatDate, useUserTimezone } from '@/lib/timezone';

interface UserApiKey {
  id: number;
  name: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  tokenSuffix: string | null;
}

export interface UserAccessCardsProps {
  userId: string;
  mfaEnabled: boolean;
  mfaMethod: string | null;
}

/**
 * The second factor and the API keys of another user, on the user's Security
 * tab. The parent shows the tab only when the operator holds every permission
 * of the user (the API answers 404 otherwise); the changes also need
 * users:write.
 */
export function UserAccessCards({
  userId,
  mfaEnabled,
  mfaMethod,
}: UserAccessCardsProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const timezone = useUserTimezone();
  const canWrite = useHasPermission('users:write');
  const [confirmMfaReset, setConfirmMfaReset] = useState(false);
  const [revokeKeyId, setRevokeKeyId] = useState<number | null>(null);

  const { data: keys, isError: keysError } = useQuery({
    queryKey: ['users', userId, 'api-keys'],
    queryFn: () => api.get<UserApiKey[]>(`/v1/users/${userId}/api-keys`),
    staleTime: 30_000,
  });

  const mfaResetMutation = useMutation({
    mutationFn: () => api.post<{ success: boolean }>(`/v1/users/${userId}/mfa/reset`, {}),
    onSuccess: () => {
      setConfirmMfaReset(false);
      void queryClient.invalidateQueries({ queryKey: ['users', userId] });
      toast({ title: t('users.mfaResetSuccess'), variant: 'success' });
    },
    onError: (err: unknown) => {
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: number) =>
      api.delete<{ success: boolean }>(`/v1/users/${userId}/api-keys/${String(keyId)}`),
    onSuccess: () => {
      setRevokeKeyId(null);
      void queryClient.invalidateQueries({ queryKey: ['users', userId, 'api-keys'] });
      toast({ title: t('settings.apiKeyRevoked'), variant: 'success' });
    },
    onError: (err: unknown) => {
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
  });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('users.mfaTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {mfaEnabled
              ? t('users.mfaOnDescription', { method: mfaMethod ?? '' })
              : t('users.mfaOffDescription')}
          </p>
          {mfaEnabled && canWrite && (
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              onClick={() => {
                setConfirmMfaReset(true);
              }}
            >
              <ShieldOff className="h-4 w-4" />
              {t('users.mfaReset')}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.apiKeys')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('users.apiKeysDescription')}</p>
          {keysError ? (
            <p className="text-sm text-destructive">{t('errors.unknown')}</p>
          ) : keys == null || keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('users.noApiKeys')}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('settings.apiKeyNameColumn')}</TableHead>
                    <TableHead>{t('settings.apiKeyKeyColumn')}</TableHead>
                    <TableHead>{t('settings.apiKeyCreatedColumn')}</TableHead>
                    <TableHead>{t('settings.apiKeyLastUsedColumn')}</TableHead>
                    <TableHead>{t('settings.apiKeyExpiresColumn')}</TableHead>
                    {canWrite && (
                      <TableHead className="text-right">{t('common.actions')}</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell className="font-medium">{key.name ?? ''}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {key.tokenSuffix != null ? `...${key.tokenSuffix}` : 'n/a'}
                      </TableCell>
                      <TableCell>{formatDate(key.createdAt, timezone)}</TableCell>
                      <TableCell>
                        {key.lastUsedAt != null
                          ? formatDate(key.lastUsedAt, timezone)
                          : t('settings.apiKeyNeverUsed')}
                      </TableCell>
                      <TableCell>
                        {key.expiresAt == null
                          ? t('settings.apiKeyNever')
                          : formatDate(key.expiresAt, timezone)}
                      </TableCell>
                      {canWrite && (
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('settings.apiKeyRevoke')}
                            onClick={() => {
                              setRevokeKeyId(key.id);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmMfaReset}
        onOpenChange={setConfirmMfaReset}
        title={t('users.mfaReset')}
        description={t('users.mfaResetConfirm')}
        confirmLabel={t('users.mfaReset')}
        variant="destructive"
        isPending={mfaResetMutation.isPending}
        onConfirm={() => {
          mfaResetMutation.mutate();
        }}
      />

      <ConfirmDialog
        open={revokeKeyId != null}
        onOpenChange={(open) => {
          if (!open) setRevokeKeyId(null);
        }}
        title={t('settings.apiKeyRevoke')}
        description={t('settings.apiKeyRevokeConfirm')}
        confirmLabel={t('settings.apiKeyRevoke')}
        variant="destructive"
        isPending={revokeMutation.isPending}
        onConfirm={() => {
          if (revokeKeyId != null) revokeMutation.mutate(revokeKeyId);
        }}
      />
    </>
  );
}
