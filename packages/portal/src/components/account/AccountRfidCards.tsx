// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CreditCard, RotateCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
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

export function AccountRfidCards(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [newToken, setNewToken] = useState('');
  const [newTokenType, setNewTokenType] = useState<(typeof PORTAL_TOKEN_TYPES)[number]>('ISO14443');
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState<'success' | 'error'>('error');
  const [confirmToken, setConfirmToken] = useState<DriverToken | null>(null);
  const [deleteToken, setDeleteToken] = useState<DriverToken | null>(null);

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
      setMsgType('success');
      setMsg(t('rfid.cardAdded'));
    },
    onError: (error) => {
      setMsgType('error');
      if (error instanceof ApiError && error.status === 409) {
        setMsg(t('rfid.duplicate'));
      } else {
        setMsg(t('rfid.addFailed'));
      }
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch<DriverToken>(`/v1/portal/tokens/${id}`, { isActive }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['portal-tokens'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/portal/tokens/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['portal-tokens'] });
      setDeleteToken(null);
      setMsgType('success');
      setMsg(t('rfid.cardRemoved'));
    },
    onError: () => {
      setMsgType('error');
      setMsg(t('rfid.removeFailed'));
    },
  });

  const sortedTokens = tokens
    ?.slice()
    .sort((a, b) => (a.isActive === b.isActive ? 0 : a.isActive ? -1 : 1));

  return (
    <div className="space-y-4">
      {sortedTokens != null && sortedTokens.length === 0 && (
        <p className="text-center text-sm text-muted-foreground">{t('rfid.noCards')}</p>
      )}

      {/* Card list mirrors the Payment Methods page: icon + identifier on the
          left, type badge + status + trash on the right. Inactive rows dim and
          strike-through the number so the soft-delete is visually obvious. */}
      <div className="space-y-2">
        {sortedTokens?.map((token) => (
          <Card key={token.id} className={token.isActive ? '' : 'opacity-60'}>
            <CardContent className="flex items-center justify-between gap-2 p-3">
              <div className="flex min-w-0 items-center gap-3">
                <CreditCard className="h-5 w-5 shrink-0 text-muted-foreground" />
                <p
                  className={`truncate text-sm font-medium ${token.isActive ? '' : 'line-through'}`}
                >
                  {token.idToken}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="outline">{token.tokenType}</Badge>
                <span
                  className={`text-xs font-medium ${
                    token.isActive ? 'text-success' : 'text-muted-foreground'
                  }`}
                >
                  {token.isActive ? t('rfid.active') : t('rfid.inactive')}
                </span>
                {/* Always render an icon button so active and inactive rows
                    have the same height. Active row → trash to deactivate.
                    Inactive row → reactivate icon to restore. Both open a
                    confirm dialog rather than mutating directly. */}
                {token.isActive ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-12 w-12"
                    onClick={() => {
                      setDeleteToken(token);
                    }}
                    aria-label={t('rfid.removeCard')}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-12 w-12"
                    onClick={() => {
                      setConfirmToken(token);
                    }}
                    aria-label={t('rfid.reactivateCard')}
                  >
                    <RotateCw className="h-4 w-4 text-primary" />
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {msg !== '' && (
        <p className={`text-sm ${msgType === 'success' ? 'text-success' : 'text-destructive'}`}>
          {msg}
        </p>
      )}

      {/* Mobile-first form: input / select / button each occupy their own row
          on phones (where the card-number field would otherwise truncate to a
          few characters next to the select), then collapse to a single row at
          sm+ where there is room. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (newToken.trim() !== '') {
            addMutation.mutate({ idToken: newToken.trim(), tokenType: newTokenType });
          }
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <Input
          value={newToken}
          onChange={(e) => {
            setNewToken(e.target.value);
            setMsg('');
          }}
          placeholder={t('rfid.cardNumber')}
          maxLength={64}
          className="w-full sm:flex-1"
        />
        <Select
          className="h-12 w-full sm:w-32"
          value={newTokenType}
          onChange={(e) => {
            setNewTokenType(e.target.value as (typeof PORTAL_TOKEN_TYPES)[number]);
            setMsg('');
          }}
          aria-label={t('rfid.tokenType')}
        >
          {PORTAL_TOKEN_TYPES.map((tt) => (
            <option key={tt} value={tt}>
              {tt}
            </option>
          ))}
        </Select>
        <Button
          type="submit"
          className="h-12 w-full sm:w-auto"
          disabled={addMutation.isPending || newToken.trim() === ''}
        >
          {t('rfid.addCard')}
        </Button>
      </form>

      <ConfirmDialog
        open={confirmToken != null}
        onOpenChange={(open) => {
          if (!open) setConfirmToken(null);
        }}
        title={
          confirmToken?.isActive === true
            ? t('rfid.confirmDeactivateTitle')
            : t('rfid.confirmActivateTitle')
        }
        description={
          confirmToken?.isActive === true
            ? t('rfid.confirmDeactivateDescription')
            : t('rfid.confirmActivateDescription')
        }
        confirmLabel={t('common.confirm')}
        onConfirm={() => {
          if (confirmToken != null) {
            toggleMutation.mutate({ id: confirmToken.id, isActive: !confirmToken.isActive });
          }
        }}
        isPending={toggleMutation.isPending}
      />

      <ConfirmDialog
        open={deleteToken != null}
        onOpenChange={(open) => {
          if (!open) setDeleteToken(null);
        }}
        title={t('rfid.confirmRemoveTitle')}
        description={t('rfid.confirmRemoveSoftDeleteDescription')}
        confirmLabel={t('rfid.removeCard')}
        variant="destructive"
        onConfirm={() => {
          if (deleteToken != null) {
            deleteMutation.mutate(deleteToken.id);
          }
        }}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}
