// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldOff, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TabPanel } from '@/components/ui/tab-panel';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/content-state';
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
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { useMfaStatus } from '@/components/profile/mfa-status';
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
  // Turning off another user's MFA takes a fresh proof of the signed-in account.
  const { data: mfaStatus } = useMfaStatus();
  const proofKinds = mfaStatus?.factorProofKinds ?? [];
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [proofFailure, setProofFailure] = useState<ProofRejection | null>(null);
  const [proofAsked, setProofAsked] = useState(false);
  // Remounts the proof field for each dialog, so a proof never carries over.
  const [proofRound, setProofRound] = useState(0);

  const {
    data: keys,
    isLoading: keysLoading,
    isError: keysError,
    refetch: refetchKeys,
  } = useQuery({
    queryKey: ['users', userId, 'api-keys'],
    queryFn: () => api.get<UserApiKey[]>(`/v1/users/${userId}/api-keys`),
    staleTime: 30_000,
  });

  const mfaResetMutation = useMutation({
    mutationFn: (resetProof: FactorProof | null) =>
      api.post<{ success: boolean }>(
        `/v1/users/${userId}/mfa/reset`,
        resetProof != null ? { proof: resetProof } : {},
      ),
    onSuccess: () => {
      setConfirmMfaReset(false);
      void queryClient.invalidateQueries({ queryKey: ['users', userId] });
      toast({ title: t('users.mfaResetSuccess'), variant: 'success' });
    },
    onError: (err: unknown) => {
      setProofFailure(proofRejection(err));
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
  });

  function openMfaReset(): void {
    mfaResetMutation.reset();
    setProof(null);
    setProofFailure(null);
    setProofAsked(false);
    setProofRound((n) => n + 1);
    setConfirmMfaReset(true);
  }

  function confirmMfaResetWithProof(): boolean {
    if (proofKinds.length > 0 && proof == null) {
      setProofAsked(true);
      return false;
    }
    mfaResetMutation.mutate(proof);
    // The dialog stays open until the reply: a refused proof is shown in it.
    return false;
  }

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
      <TabPanel title={t('users.mfaTitle')} bodyClassName="space-y-4">
        <p className="text-sm text-muted-foreground">
          {mfaEnabled
            ? t('users.mfaOnDescription', { method: mfaMethod ?? '' })
            : t('users.mfaOffDescription')}
        </p>
        {mfaEnabled && canWrite && (
          <Button type="button" variant="outline" className="w-fit" onClick={openMfaReset}>
            <ShieldOff className="h-4 w-4" />
            {t('users.mfaReset')}
          </Button>
        )}
      </TabPanel>

      <TabPanel
        title={t('settings.apiKeys')}
        description={t('users.apiKeysDescription')}
        bodyClassName="space-y-4"
      >
        {keysLoading ? (
          <LoadingState />
        ) : keysError ? (
          <ErrorState
            onRetry={() => {
              void refetchKeys();
            }}
          />
        ) : keys == null || keys.length === 0 ? (
          <EmptyState>{t('users.noApiKeys')}</EmptyState>
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
                  {canWrite && <TableHead className="text-right">{t('common.actions')}</TableHead>}
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
      </TabPanel>

      <ConfirmDialog
        open={confirmMfaReset}
        onOpenChange={setConfirmMfaReset}
        title={t('users.mfaReset')}
        description={t('users.mfaResetConfirm')}
        confirmLabel={t('users.mfaReset')}
        variant="destructive"
        isPending={mfaResetMutation.isPending}
        asForm
        onConfirm={confirmMfaResetWithProof}
      >
        {proofKinds.length > 0 && (
          <FactorProofField
            key={`mfa-reset-${String(proofRound)}`}
            idPrefix="user-mfa-reset-proof"
            kinds={proofKinds}
            codeMethod={mfaStatus?.mfaMethod ?? null}
            description={t('users.mfaResetProofHint')}
            onChange={setProof}
            rejection={proofFailure}
            showMissing={proofAsked}
          />
        )}
      </ConfirmDialog>

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
