// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Nfc } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { DRIVER_ID_TOKEN_TYPES, type DriverIdTokenType } from '@evtivity/lib/id-token-types';

interface DriverToken {
  id: string;
  idToken: string;
  tokenType: string;
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
  const [newTokenType, setNewTokenType] = useState<DriverIdTokenType>('ISO14443');
  const [addError, setAddError] = useState('');
  const [confirmDeactivate, setConfirmDeactivate] = useState<DriverToken | null>(null);

  const { data: tokens } = useQuery({
    queryKey: ['portal-tokens'],
    queryFn: () => api.get<DriverToken[]>('/v1/portal/tokens'),
  });

  const addMutation = useMutation({
    mutationFn: (body: { idToken: string; tokenType: DriverIdTokenType }) =>
      api.post<DriverToken>('/v1/portal/tokens', body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['portal-tokens'] });
      setNewToken('');
      setNewTokenType('ISO14443');
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
      <Button
        className="w-full"
        onClick={() => {
          setAddError('');
          setAddOpen(true);
        }}
      >
        {t('rfid.addCard')}
      </Button>

      {sortedTokens != null && sortedTokens.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <Nfc className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('rfid.noCards')}</p>
        </div>
      )}

      <div className="space-y-2">
        {sortedTokens?.map((token) => (
          <Card key={token.id}>
            <CardContent className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{maskToken(token.idToken)}</p>
                <p className="text-xs text-muted-foreground">{token.tokenType}</p>
                {token.blockedByOperator === true ? (
                  <p className="text-xs text-destructive">{t('rfid.blockedByOperator')}</p>
                ) : token.isActive && isExpired(token) ? (
                  <p className="text-xs text-destructive">{t('rfid.expired')}</p>
                ) : null}
              </div>
              <Toggle
                checked={token.isActive}
                onCheckedChange={(next) => {
                  onToggle(token, next);
                }}
                disabled={toggleMutation.isPending || token.blockedByOperator === true}
                aria-label={token.isActive ? t('rfid.removeCard') : t('rfid.reactivateCard')}
              />
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
          addMutation.mutate({ idToken: newToken.trim(), tokenType: newTokenType });
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
              setNewTokenType(e.target.value as DriverIdTokenType);
            }}
            aria-label={t('rfid.tokenType')}
          >
            {DRIVER_ID_TOKEN_TYPES.map((tt) => (
              <option key={tt} value={tt}>
                {tt}
              </option>
            ))}
          </Select>
          {addError !== '' && <p className="text-sm text-destructive">{addError}</p>}
        </div>
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
