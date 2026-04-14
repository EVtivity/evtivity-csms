// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';

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
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState<'success' | 'error'>('error');
  const [confirmToken, setConfirmToken] = useState<DriverToken | null>(null);
  const [deleteToken, setDeleteToken] = useState<DriverToken | null>(null);

  const { data: tokens } = useQuery({
    queryKey: ['portal-tokens'],
    queryFn: () => api.get<DriverToken[]>('/v1/portal/tokens'),
  });

  const addMutation = useMutation({
    mutationFn: (idToken: string) => api.post<DriverToken>('/v1/portal/tokens', { idToken }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-tokens'] });
      setNewToken('');
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
        <p className="text-sm text-muted-foreground">{t('rfid.noCards')}</p>
      )}

      <div className="space-y-4">
        {tokens?.map((token) => (
          <div key={token.id} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm">{token.idToken}</span>
              <Badge variant="outline">{token.tokenType}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setConfirmToken(token);
                }}
                className={`text-xs font-medium ${token.isActive ? 'text-success' : 'text-muted-foreground'}`}
              >
                {token.isActive ? t('rfid.active') : t('rfid.inactive')}
              </button>
              <button
                onClick={() => {
                  setDeleteToken(token);
                }}
                className="text-muted-foreground hover:text-destructive transition-colors"
                aria-label={t('rfid.removeCard')}
              >
                <Trash2 className="h-4 w-4" />
              </button>
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
            addMutation.mutate(newToken.trim());
          }
        }}
        className="flex gap-2"
      >
        <Input
          value={newToken}
          onChange={(e) => {
            setNewToken(e.target.value);
            setMsg('');
          }}
          placeholder={t('rfid.cardNumber')}
          maxLength={20}
          className="flex-1"
        />
        <Button type="submit" disabled={addMutation.isPending || newToken.trim() === ''}>
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
        description={t('rfid.confirmRemoveDescription')}
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
