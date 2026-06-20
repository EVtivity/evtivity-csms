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
import { api, ApiError } from '@/lib/api';

// Driver-facing OCPP IdToken types. Mirrors PORTAL_TOKEN_TYPES on the API
// route. Central and NoAuthorization are excluded because they don't
// correspond to anything a driver would have on a physical card.
const PORTAL_TOKEN_TYPES = [
  'ISO14443',
  'ISO15693',
  'KeyCode',
  'Local',
  'MacAddress',
  'eMAID',
] as const;

interface DriverToken {
  id: string;
  idToken: string;
  tokenType: string;
  isActive: boolean;
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
  const [addOpen, setAddOpen] = useState(false);
  const [newToken, setNewToken] = useState('');
  const [newTokenType, setNewTokenType] = useState<(typeof PORTAL_TOKEN_TYPES)[number]>('ISO14443');
  const [addError, setAddError] = useState('');
  const [confirmDeactivate, setConfirmDeactivate] = useState<DriverToken | null>(null);

  const { data: tokens } = useQuery({
    queryKey: ['portal-tokens'],
    queryFn: () => api.get<DriverToken[]>('/v1/portal/tokens'),
  });

  const addMutation = useMutation({
    mutationFn: (body: { idToken: string; tokenType: (typeof PORTAL_TOKEN_TYPES)[number] }) =>
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
          : t('rfid.addFailed'),
      );
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch<DriverToken>(`/v1/portal/tokens/${id}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['portal-tokens'] }),
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
              </div>
              <Toggle
                checked={token.isActive}
                onCheckedChange={(next) => {
                  onToggle(token, next);
                }}
                disabled={toggleMutation.isPending}
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
              setNewTokenType(e.target.value as (typeof PORTAL_TOKEN_TYPES)[number]);
            }}
            aria-label={t('rfid.tokenType')}
          >
            {PORTAL_TOKEN_TYPES.map((tt) => (
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
