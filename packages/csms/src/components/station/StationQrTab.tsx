// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Link } from 'react-router-dom';
import { QrCodeCard } from '@/components/QrCodeCard';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

interface Connector {
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: number | null;
  maxCurrentAmps: number | null;
  status: string;
  isIdling?: boolean;
}

interface Evse {
  evseId: number;
  status: string;
  connectors: Connector[];
}

export interface StationQrTabProps {
  stationId: string;
  stationOcppId: string;
  guestChargingEnabled: boolean;
}

export function StationQrTab({
  stationId,
  stationOcppId,
  guestChargingEnabled,
}: StationQrTabProps): React.JSX.Element {
  const { t } = useTranslation();

  const { data: connectorsData } = useQuery({
    queryKey: ['stations', stationId, 'connectors'],
    queryFn: () => api.get<Evse[]>(`/v1/stations/${stationId}/connectors`),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('stations.qrCodes')}</CardTitle>
      </CardHeader>
      <CardContent>
        {connectorsData != null && connectorsData.length > 0 ? (
          <>
            <p className="mb-4 text-sm text-muted-foreground">{t('stations.qrCodesDescription')}</p>
            <Alert variant="info" className="mb-4">
              <Info className="h-4 w-4" />
              <AlertDescription>
                <Trans
                  i18nKey="stations.qrCodesHardwareNote"
                  components={{
                    configTab: (
                      <Link
                        to={`/stations/${stationId}?tab=configurations`}
                        className="font-medium underline"
                      />
                    ),
                    templates: (
                      <Link to="/settings?tab=configuration" className="font-medium underline" />
                    ),
                  }}
                />
              </AlertDescription>
            </Alert>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
              {connectorsData.map((evse) => (
                <QrCodeCard
                  key={evse.evseId}
                  stationOcppId={stationOcppId}
                  evseId={evse.evseId}
                  guestChargingEnabled={guestChargingEnabled}
                />
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('charts.noEvsesConfigured')}</p>
        )}
      </CardContent>
    </Card>
  );
}
