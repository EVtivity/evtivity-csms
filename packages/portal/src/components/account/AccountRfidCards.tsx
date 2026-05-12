// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-tokens'] });
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-tokens'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/portal/tokens/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-tokens'] });
      setDeleteToken(null);
      setMsgType('success');
      setMsg(t('rfid.cardRemoved'));
    },
    onError: () => {
      setMsgType('error');
      setMsg(t('rfid.removeFailed'));
    },
  });

  return (
    <div className="space-y-4">
      {tokens != null && tokens.length === 0 && (
        <p className="text-center text-sm text-muted-foreground">{t('rfid.noCards')}</p>
      )}

      <div className="space-y-4">
        {/* Active cards rendered first, then inactive so the most-recently-used
            cards stay at the top. Inactive rows visually dimmed with an
            Inactive badge so the driver sees their Remove click took effect. */}
        {tokens
          ?.slice()
          .sort((a, b) => (a.isActive === b.isActive ? 0 : a.isActive ? -1 : 1))
          .map((token) => (
            <div
              key={token.id}
              className={`flex items-center justify-between ${token.isActive ? '' : 'opacity-60'}`}
            >
              <div className="flex items-center gap-2">
                <span className={`text-sm ${token.isActive ? '' : 'line-through'}`}>
                  {token.idToken}
                </span>
                <Badge variant="outline">{token.tokenType}</Badge>
                {!token.isActive && <Badge variant="secondary">{t('rfid.inactiveBadge')}</Badge>}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setConfirmToken(token);
                  }}
                  className={`text-xs font-medium ${
                    token.isActive ? 'text-success' : 'text-muted-foreground'
                  }`}
                >
                  {token.isActive ? t('rfid.active') : t('rfid.inactive')}
                </button>
                {token.isActive && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setDeleteToken(token);
                    }}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={t('rfid.removeCard')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
      </div>

      {msg !== '' && (
        <p className={`text-sm ${msgType === 'success' ? 'text-success' : 'text-destructive'}`}>
          {msg}
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (newToken.trim() !== '') {
            addMutation.mutate({ idToken: newToken.trim(), tokenType: newTokenType });
          }
        }}
        className="space-y-2"
      >
        <div className="flex gap-2">
          <Input
            value={newToken}
            onChange={(e) => {
              setNewToken(e.target.value);
              setMsg('');
            }}
            placeholder={t('rfid.cardNumber')}
            maxLength={64}
            className="flex-1"
          />
          <Select
            className="h-12 w-32"
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
            className="h-12"
            disabled={addMutation.isPending || newToken.trim() === ''}
          >
            {t('rfid.addCard')}
          </Button>
        </div>
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
