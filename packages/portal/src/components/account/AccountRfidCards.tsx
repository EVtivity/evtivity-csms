// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Nfc, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CreateButton } from '@/components/create-button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { PORTAL_ID_TOKEN_TYPES, type PortalIdTokenType } from '@evtivity/lib/id-token-types';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/content-state';

interface DriverToken {
  id: string;
  idToken: string;
  tokenType: string;
  label?: string | null;
  isActive: boolean;
  expiresAt?: string | null;
  /** The operator deactivated the card: only the operator can reactivate it. */
  blockedByOperator?: boolean;
}

function isExpired(token: DriverToken): boolean {
  return token.expiresAt != null && new Date(token.expiresAt).getTime() <= Date.now();
}

// RFID values authorize charging, so mask all but the last 4 characters
// (matches the mobile app).
function maskToken(value: string): string {
  if (value.length <= 4) return value;
  return `${'•'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

export function AccountRfidCards(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [newToken, setNewToken] = useState('');
  const [newTokenType, setNewTokenType] = useState<PortalIdTokenType>('ISO14443');
  const [newLabel, setNewLabel] = useState('');
  const [addError, setAddError] = useState('');
  const [confirmDeactivate, setConfirmDeactivate] = useState<DriverToken | null>(null);
  const [renameToken, setRenameToken] = useState<DriverToken | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const {
    data: tokens,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['portal-tokens'],
    queryFn: () => api.get<DriverToken[]>('/v1/portal/tokens'),
  });

  const addMutation = useMutation({
    mutationFn: (body: { idToken: string; tokenType: PortalIdTokenType; label?: string }) =>
      api.post<DriverToken>('/v1/portal/tokens', body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['portal-tokens'] });
      setNewToken('');
      setNewTokenType('ISO14443');
      setNewLabel('');
      setAddError('');
      setAddOpen(false);
    },
    onError: (error) => {
      setAddError(
        error instanceof ApiError && error.status === 409
          ? t('rfid.duplicate')
          : getErrorMessage(error, t, 'rfid.addFailed'),
      );
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch<DriverToken>(`/v1/portal/tokens/${id}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['portal-tokens'] }),
    onError: (error) => {
      toast({ variant: 'destructive', title: getErrorMessage(error, t, 'rfid.toggleFailed') });
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string | null }) =>
      api.patch<DriverToken>(`/v1/portal/tokens/${id}`, { label }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['portal-tokens'] });
      setRenameToken(null);
    },
    onError: (error) => {
      toast({ variant: 'destructive', title: getErrorMessage(error, t, 'rfid.renameFailed') });
    },
  });

  const sortedTokens = tokens
    ?.slice()
    .sort((a, b) => (a.isActive === b.isActive ? 0 : a.isActive ? -1 : 1));

  function onToggle(token: DriverToken, next: boolean): void {
    if (next) {
      toggleMutation.mutate({ id: token.id, isActive: true });
    } else {
      setConfirmDeactivate(token);
    }
  }

  return (
    <div className="space-y-4">
      <CreateButton
        label={t('rfid.addCard')}
        fullWidth
        onClick={() => {
          setAddError('');
          setAddOpen(true);
        }}
      />

      {isLoading && <LoadingState />}

      {isError && (
        <ErrorState
          onRetry={() => {
            void refetch();
          }}
        />
      )}

      {sortedTokens != null && sortedTokens.length === 0 && (
        <div className="flex flex-col items-center gap-2 pt-8">
          <Nfc className="h-10 w-10 text-muted-foreground" />
          <EmptyState className="pt-0 pb-8">{t('rfid.noCards')}</EmptyState>
        </div>
      )}

      <div className="space-y-2">
        {sortedTokens?.map((token) => (
          <Card key={token.id}>
            <CardContent className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                {token.label != null && token.label !== '' ? (
                  <>
                    <p className="truncate text-sm font-medium">{token.label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {maskToken(token.idToken)} · {token.tokenType}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="truncate text-sm font-medium">{maskToken(token.idToken)}</p>
                    <p className="text-xs text-muted-foreground">{token.tokenType}</p>
                  </>
                )}
                {token.blockedByOperator === true ? (
                  <p className="text-xs text-destructive">{t('rfid.blockedByOperator')}</p>
                ) : token.isActive && isExpired(token) ? (
                  <p className="text-xs text-destructive">{t('rfid.expired')}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setRenameValue(token.label ?? '');
                    setRenameToken(token);
                  }}
                  aria-label={t('rfid.renameCard')}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Toggle
                  checked={token.isActive}
                  onCheckedChange={(next) => {
                    onToggle(token, next);
                  }}
                  disabled={toggleMutation.isPending || token.blockedByOperator === true}
                  aria-label={token.isActive ? t('rfid.removeCard') : t('rfid.reactivateCard')}
                />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <ConfirmDialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open) setAddOpen(false);
        }}
        title={t('rfid.addCard')}
        description={t('rfid.cardNumber')}
        confirmLabel={t('common.add')}
        variant="default"
        isPending={addMutation.isPending}
        onConfirm={() => {
          if (newToken.trim() === '') return false;
          addMutation.mutate({
            idToken: newToken.trim(),
            tokenType: newTokenType,
            ...(newLabel.trim() !== '' ? { label: newLabel.trim() } : {}),
          });
          return false;
        }}
      >
        <div className="space-y-2">
          <Input
            value={newToken}
            onChange={(e) => {
              setNewToken(e.target.value);
              setAddError('');
            }}
            placeholder={t('rfid.cardNumber')}
            maxLength={64}
            autoFocus
          />
          <Select
            value={newTokenType}
            onChange={(e) => {
              setNewTokenType(e.target.value as PortalIdTokenType);
            }}
            aria-label={t('rfid.tokenType')}
          >
            {PORTAL_ID_TOKEN_TYPES.map((tt) => (
              <option key={tt} value={tt}>
                {tt}
              </option>
            ))}
          </Select>
          <Input
            value={newLabel}
            onChange={(e) => {
              setNewLabel(e.target.value);
            }}
            placeholder={t('rfid.labelPlaceholder')}
            aria-label={t('rfid.label')}
            maxLength={100}
          />
          {addError !== '' && <p className="text-sm text-destructive">{addError}</p>}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={renameToken != null}
        onOpenChange={(open) => {
          if (!open) setRenameToken(null);
        }}
        title={t('rfid.renameCard')}
        description={t('rfid.labelHint')}
        confirmLabel={t('common.save')}
        variant="default"
        isPending={renameMutation.isPending}
        onConfirm={() => {
          if (renameToken != null) {
            const label = renameValue.trim();
            renameMutation.mutate({ id: renameToken.id, label: label === '' ? null : label });
          }
          return false;
        }}
      >
        <Input
          value={renameValue}
          onChange={(e) => {
            setRenameValue(e.target.value);
          }}
          placeholder={t('rfid.labelPlaceholder')}
          aria-label={t('rfid.label')}
          maxLength={100}
          autoFocus
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmDeactivate != null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeactivate(null);
        }}
        title={t('rfid.confirmDeactivateTitle')}
        description={t('rfid.confirmDeactivateDescription')}
        confirmLabel={t('common.deactivate')}
        variant="destructive"
        isPending={toggleMutation.isPending}
        onConfirm={() => {
          if (confirmDeactivate != null) {
            toggleMutation.mutate(
              { id: confirmDeactivate.id, isActive: false },
              {
                onSuccess: () => {
                  setConfirmDeactivate(null);
                },
              },
            );
          }
          return false;
        }}
      />
    </div>
  );
}
