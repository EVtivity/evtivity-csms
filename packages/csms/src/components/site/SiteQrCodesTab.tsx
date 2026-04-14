// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { QrCodeCard } from '@/components/QrCodeCard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import { api } from '@/lib/api';

interface Station {
  id: string;
  stationId: string;
  model: string | null;
  securityProfile: number;
  availability: string;
  status: string;
  connectorCount: number;
  connectorTypes: string[] | null;
  isOnline: boolean;
  lastHeartbeat: string | null;
}

interface Evse {
  evseId: number;
  status: string;
  connectors: {
    connectorId: number;
    connectorType: string | null;
    maxPowerKw: number | null;
    status: string;
  }[];
}

function StationQrSection({
  station,
  guestChargingEnabled,
}: {
  station: Station;
  guestChargingEnabled: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { data: connectors } = useQuery({
    queryKey: ['stations', station.id, 'connectors'],
    queryFn: () => api.get<Evse[]>(`/v1/stations/${station.id}/connectors`),
  });

  if (connectors == null || connectors.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('charts.noEvsesConfigured')}</p>;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
      {connectors.map((evse) => (
        <QrCodeCard
          key={evse.evseId}
          stationOcppId={station.stationId}
          evseId={evse.evseId}
          svgIdPrefix="site-qr"
          showStationId
          guestChargingEnabled={guestChargingEnabled}
        />
      ))}
    </div>
  );
}

export interface SiteQrCodesTabProps {
  stations: Station[] | undefined;
  guestChargingEnabled: boolean;
}

export function SiteQrCodesTab({
  stations,
  guestChargingEnabled,
}: SiteQrCodesTabProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <TabsContent value="qr-codes" className="space-y-6">
      <p className="text-sm text-muted-foreground">{t('sites.qrCodesDescription')}</p>
      {stations != null && stations.length > 0 ? (
        stations.map((s) => (
          <Card key={s.id}>
            <CardHeader>
              <CardTitle>{s.stationId}</CardTitle>
            </CardHeader>
            <CardContent>
              <StationQrSection station={s} guestChargingEnabled={guestChargingEnabled} />
            </CardContent>
          </Card>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">{t('sites.noStationsAtSite')}</p>
      )}
    </TabsContent>
  );
}
