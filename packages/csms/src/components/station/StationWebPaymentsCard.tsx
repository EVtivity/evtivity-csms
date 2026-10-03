// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

export interface WebPaymentConfig {
  enabled: boolean;
  validitySeconds: number | null;
  totpLength: number | null;
  totpVersion: string | null;
  urlTemplate: string | null;
}

export interface StationWebPaymentsCardProps {
  stationId: string;
  ocppProtocol: string | null;
  isOnline: boolean;
}

function parseIntInRange(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/**
 * Dynamic QR codes (OCPP 2.1 C25): the CSMS sets WebPaymentsCtrlr on the
 * station and checks the one-time password in every scanned QR code.
 */
export function StationWebPaymentsCard({
  stationId,
  ocppProtocol,
  isOnline,
}: StationWebPaymentsCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('stations:write');
  const [validity, setValidity] = useState('60');
  const [length, setLength] = useState('8');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  const queryKey = ['stations', stationId, 'web-payments'];
  const { data } = useQuery({
    queryKey,
    queryFn: () => api.get<WebPaymentConfig>(`/v1/stations/${stationId}/web-payments`),
  });

  const onError = (err: unknown): void => {
    toast({
      title: t('stations.dynamicQrFailed'),
      description: getErrorMessage(err, t),
      variant: 'destructive',
    });
  };
  const onSuccess = (config: WebPaymentConfig): void => {
    queryClient.setQueryData(queryKey, config);
    setHasSubmitted(false);
  };

  const enableMutation = useMutation({
    mutationFn: (body: { validitySeconds: number; totpLength: number }) =>
      api.put<WebPaymentConfig>(`/v1/stations/${stationId}/web-payments`, body),
    onSuccess,
    onError,
  });
  const disableMutation = useMutation({
    mutationFn: () => api.delete<WebPaymentConfig>(`/v1/stations/${stationId}/web-payments`),
    onSuccess,
    onError,
  });

  const validitySeconds = parseIntInRange(validity, 6, 3600);
  const totpLength = parseIntInRange(length, 6, 32);
  const supported = ocppProtocol === 'ocpp2.1';

  function handleEnable(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (validitySeconds == null || totpLength == null) return;
    enableMutation.mutate({ validitySeconds, totpLength });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{t('stations.dynamicQr')}</CardTitle>
        <Badge variant={data?.enabled === true ? 'default' : 'outline'}>
          {data?.enabled === true ? t('stations.dynamicQrOn') : t('stations.dynamicQrOff')}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('stations.dynamicQrDescription')}</p>
        {!supported ? (
          <p className="text-sm text-muted-foreground">{t('stations.dynamicQrOcpp21Only')}</p>
        ) : (
          <>
            {data?.enabled === true && (
              <dl className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">{t('stations.dynamicQrValidity')}</dt>
                  <dd className="font-medium">{data.validitySeconds}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('stations.dynamicQrLength')}</dt>
                  <dd className="font-medium">{data.totpLength}</dd>
                </div>
                <div className="md:col-span-2">
                  <dt className="text-muted-foreground">{t('stations.dynamicQrUrlTemplate')}</dt>
                  <dd className="break-all font-mono text-xs">{data.urlTemplate}</dd>
                </div>
              </dl>
            )}
            {canWrite && (
              <form onSubmit={handleEnable} noValidate className="space-y-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="dynamic-qr-validity" className="leading-6">
                      {t('stations.dynamicQrValidity')}
                    </Label>
                    <Input
                      id="dynamic-qr-validity"
                      inputMode="numeric"
                      value={validity}
                      onChange={(e) => {
                        setValidity(e.target.value);
                      }}
                      className={
                        hasSubmitted && validitySeconds == null ? 'border-destructive' : ''
                      }
                    />
                    {hasSubmitted && validitySeconds == null && (
                      <p className="text-sm text-destructive">
                        {t('stations.dynamicQrValidityRange')}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="dynamic-qr-length" className="leading-6">
                      {t('stations.dynamicQrLength')}
                    </Label>
                    <Input
                      id="dynamic-qr-length"
                      inputMode="numeric"
                      value={length}
                      onChange={(e) => {
                        setLength(e.target.value);
                      }}
                      className={hasSubmitted && totpLength == null ? 'border-destructive' : ''}
                    />
                    {hasSubmitted && totpLength == null && (
                      <p className="text-sm text-destructive">
                        {t('stations.dynamicQrLengthRange')}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  {data?.enabled === true && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={disableMutation.isPending}
                      onClick={() => {
                        setDisableOpen(true);
                      }}
                    >
                      {t('stations.dynamicQrDisable')}
                    </Button>
                  )}
                  <Button type="submit" disabled={!isOnline || enableMutation.isPending}>
                    {data?.enabled === true
                      ? t('stations.dynamicQrRotate')
                      : t('stations.dynamicQrEnable')}
                  </Button>
                </div>
                {!isOnline && (
                  <p className="text-right text-sm text-muted-foreground">
                    {t('stations.dynamicQrOfflineHint')}
                  </p>
                )}
              </form>
            )}
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title={t('stations.dynamicQrDisable')}
        description={t('stations.dynamicQrDisableConfirm')}
        confirmLabel={t('stations.dynamicQrDisable')}
        onConfirm={() => {
          disableMutation.mutate();
        }}
      />
    </Card>
  );
}
