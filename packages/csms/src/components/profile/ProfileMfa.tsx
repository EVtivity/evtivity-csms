// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { CancelButton } from '@/components/cancel-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';

const MFA_METHOD_LABELS: Record<string, string> = {
  email: 'profile.mfaMethodEmail',
  totp: 'profile.mfaMethodTotp',
  sms: 'profile.mfaMethodSms',
};

interface MfaStatus {
  mfaEnabled: boolean;
  mfaMethod: string | null;
  availableMethods: string[];
}

interface MfaSetupResponse {
  qrDataUri?: string;
  secret?: string;
  challengeId?: string;
}

export function ProfileMfa(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [mfaMethod, setMfaMethod] = useState('');
  const [mfaSetupData, setMfaSetupData] = useState<MfaSetupResponse | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState('');
  const [disablePassword, setDisablePassword] = useState('');

  const { data: mfaStatus, isLoading: mfaLoading } = useQuery({
    queryKey: ['mfa-status'],
    queryFn: () => api.get<MfaStatus>('/v1/users/me/mfa'),
  });

  const mfaSetupMutation = useMutation({
    mutationFn: (body: { method: string }) =>
      api.post<MfaSetupResponse>('/v1/users/me/mfa/setup', body),
    onSuccess: (data) => {
      setMfaSetupData(data);
      setMfaCode('');
      setMfaError('');
    },
    onError: () => {
      setMfaError(t('profile.mfaSetupFailed'));
    },
  });

  const mfaConfirmMutation = useMutation({
    mutationFn: (body: { method: string; code: string; challengeId?: string }) =>
      api.post('/v1/users/me/mfa/confirm', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mfa-status'] });
      setMfaSetupData(null);
      setMfaCode('');
      setMfaMethod('');
      setMfaError('');
    },
    onError: () => {
      setMfaError(t('profile.mfaVerifyFailed'));
    },
  });

  const mfaDisableMutation = useMutation({
    mutationFn: (body: { password: string }) => api.delete('/v1/users/me/mfa', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mfa-status'] });
      setDisablePassword('');
      setMfaError('');
    },
    onError: () => {
      setMfaError(t('profile.mfaDisableFailed'));
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.mfaSecurity')}</CardTitle>
      </CardHeader>
      <CardContent>
        {mfaLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading')}
          </div>
        ) : mfaStatus == null ? null : mfaStatus.mfaEnabled ? (
          <div className="space-y-4 max-w-md">
            <div className="flex items-center gap-2">
              <Badge variant="default">{t('profile.mfaEnabled')}</Badge>
              <span className="text-sm text-muted-foreground">
                {t('profile.mfaCurrentMethod')}:{' '}
                {t(
                  (MFA_METHOD_LABELS[mfaStatus.mfaMethod ?? ''] ??
                    mfaStatus.mfaMethod ??
                    '') as never,
                )}
              </span>
            </div>
            {mfaError !== '' && <p className="text-sm text-destructive">{mfaError}</p>}
            <p className="text-sm text-muted-foreground">{t('profile.mfaDisableConfirm')}</p>
            <div className="space-y-2">
              <Label htmlFor="mfa-disable-password">{t('profile.currentPassword')}</Label>
              <PasswordInput
                id="mfa-disable-password"
                value={disablePassword}
                onChange={(e) => {
                  setDisablePassword(e.target.value);
                }}
                autoComplete="current-password"
              />
            </div>
            <Button
              variant="destructive"
              disabled={mfaDisableMutation.isPending || disablePassword.trim() === ''}
              onClick={() => {
                setMfaError('');
                mfaDisableMutation.mutate({ password: disablePassword });
              }}
            >
              {mfaDisableMutation.isPending ? t('profile.mfaDisabling') : t('profile.mfaDisable')}
            </Button>
          </div>
        ) : mfaStatus.availableMethods.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('profile.mfaNotAvailable')}</p>
        ) : mfaSetupData == null ? (
          <div className="space-y-4 max-w-md">
            <div className="flex items-center gap-2">
              <Badge variant="destructive">{t('profile.mfaDisabled')}</Badge>
            </div>
            {mfaError !== '' && <p className="text-sm text-destructive">{mfaError}</p>}
            <div className="space-y-2">
              <Label htmlFor="mfa-method-select">{t('profile.mfaSelectMethod')}</Label>
              <select
                id="mfa-method-select"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={mfaMethod}
                onChange={(e) => {
                  setMfaMethod(e.target.value);
                }}
              >
                <option value="">{t('profile.mfaSelectMethod')}</option>
                {mfaStatus.availableMethods.map((m) => (
                  <option key={m} value={m}>
                    {t((MFA_METHOD_LABELS[m] ?? m) as never)}
                  </option>
                ))}
              </select>
            </div>
            <Button
              disabled={mfaMethod === '' || mfaSetupMutation.isPending}
              onClick={() => {
                setMfaError('');
                mfaSetupMutation.mutate({ method: mfaMethod });
              }}
            >
              {mfaSetupMutation.isPending ? t('profile.mfaSettingUp') : t('profile.mfaSetUp')}
            </Button>
          </div>
        ) : (
          <div className="space-y-4 max-w-md">
            {mfaError !== '' && <p className="text-sm text-destructive">{mfaError}</p>}
            {mfaSetupData.qrDataUri != null && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{t('profile.mfaScanQr')}</p>
                <img
                  src={mfaSetupData.qrDataUri}
                  alt="QR Code"
                  className="rounded border p-2"
                  width={200}
                  height={200}
                />
                {mfaSetupData.secret != null && (
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">{t('profile.mfaManualEntry')}</p>
                    <code className="block rounded bg-muted px-3 py-2 text-sm select-all">
                      {mfaSetupData.secret}
                    </code>
                  </div>
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="mfa-verify-code">{t('profile.mfaEnterCode')}</Label>
              <Input
                id="mfa-verify-code"
                value={mfaCode}
                onChange={(e) => {
                  setMfaCode(e.target.value);
                }}
                maxLength={6}
                placeholder="000000"
                className="max-w-[200px]"
              />
            </div>
            <div className="flex gap-2">
              <Button
                disabled={mfaCode.length !== 6 || mfaConfirmMutation.isPending}
                onClick={() => {
                  setMfaError('');
                  mfaConfirmMutation.mutate({
                    method: mfaMethod,
                    code: mfaCode,
                    ...(mfaSetupData.challengeId != null
                      ? { challengeId: mfaSetupData.challengeId }
                      : {}),
                  });
                }}
              >
                {mfaConfirmMutation.isPending ? t('profile.mfaVerifying') : t('profile.mfaVerify')}
              </Button>
              <CancelButton
                onClick={() => {
                  setMfaSetupData(null);
                  setMfaCode('');
                  setMfaError('');
                }}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
