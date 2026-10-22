// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DescriptionItem, DescriptionList } from '@/components/ui/description-list';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatNumber } from '@/lib/formatting';
import { formatDateTime } from '@/lib/timezone';
import {
  DATALINK_LABEL_KEYS,
  signalGradeVariant,
  type StationDataLink,
  type StationSignal,
} from './sim-connectivity';

const GRADE_KEYS = {
  good: 'stations.sim.station.grade.good',
  fair: 'stations.sim.station.grade.fair',
  poor: 'stations.sim.station.grade.poor',
  unknown: 'stations.sim.station.grade.unknown',
} as const;

const BOOLEAN_VARIABLES = new Set(['Active', 'Enabled', 'Fallback', 'Problem']);

/** What the station reported about its cellular modem (DataLink), with plain labels. */
export function SimStationCard({
  stationId,
  timezone,
  station,
}: {
  stationId: string;
  timezone: string;
  station: StationSignal;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const canWrite = useHasPermission('stations:write');
  const readDeviceModel = useMutation({
    mutationFn: () => api.post(`/v1/stations/${stationId}/configurations/refresh`, {}),
    onSuccess: () => {
      toast({ variant: 'success', title: t('stations.sim.station.readDeviceModelSent') });
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  // A 2.x station whose report holds no cellular modem has nothing to show.
  if (station.deviceModel === 'no_datalink') return null;
  const na = t('common.na');

  const value = (name: string, raw: string | null | undefined): string => {
    if (raw == null || raw === '') return na;
    if (BOOLEAN_VARIABLES.has(name)) {
      if (raw === 'true') return t('stations.sim.station.yes');
      if (raw === 'false') return t('stations.sim.station.no');
    }
    return raw;
  };

  const signalItem = (link: StationDataLink): React.JSX.Element => {
    const signal = link.signal;
    if (signal == null) {
      return (
        <DescriptionItem label={t(DATALINK_LABEL_KEYS.SignalStrength)}>
          {value('SignalStrength', link.values['SignalStrength'])}
        </DescriptionItem>
      );
    }
    const reading =
      signal.unit === 'ASU'
        ? signal.dbm == null
          ? t('stations.sim.station.asuUnknown', { value: formatNumber(signal.value, 0) })
          : t('stations.sim.station.asuValue', {
              value: formatNumber(signal.value, 0),
              dbm: formatNumber(signal.dbm, 0),
            })
        : t('stations.sim.station.dbmValue', { value: formatNumber(signal.value, 0) });
    return (
      <DescriptionItem label={t(DATALINK_LABEL_KEYS.SignalStrength)}>
        <span className="flex flex-wrap items-center gap-2" data-testid="sim-signal">
          <span>{reading}</span>
          <Badge variant={signalGradeVariant(signal.grade)}>{t(GRADE_KEYS[signal.grade])}</Badge>
          <Tooltip
            content={t('stations.sim.station.gradeCaveat', {
              good: formatNumber(station.thresholds.goodDbm, 0),
              fair: formatNumber(station.thresholds.fairDbm, 0),
            })}
          >
            <span
              role="img"
              tabIndex={0}
              aria-label={t('stations.sim.station.gradeInfo')}
              className="inline-flex rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Info className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
          </Tooltip>
        </span>
        <span className="block text-xs text-muted-foreground">
          {signal.inferred
            ? t('stations.sim.station.sourceInferred')
            : t('stations.sim.station.source')}
        </span>
      </DescriptionItem>
    );
  };

  return (
    <Card data-testid="sim-from-station">
      <CardHeader>
        <CardTitle>{t('stations.sim.fromStationTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {station.readAt == null
            ? t('stations.sim.notFetchedYet')
            : t('stations.sim.readAt', { time: formatDateTime(station.readAt, timezone) })}
        </p>
        {station.deviceModel === 'unread' && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t('stations.sim.station.deviceModelUnread')}
            </p>
            {canWrite && (
              <Button
                variant="outline"
                disabled={readDeviceModel.isPending}
                onClick={() => {
                  readDeviceModel.mutate();
                }}
              >
                {t('stations.sim.station.readDeviceModel')}
              </Button>
            )}
          </div>
        )}
        {station.protocol === 'ocpp2x' &&
          station.dataLinks.map((link) => (
            <div key={link.instance ?? ''} className="space-y-2">
              {link.instance != null && (
                <h4 className="text-sm font-medium">
                  {t('stations.sim.station.modem', { instance: link.instance })}
                </h4>
              )}
              <DescriptionList>
                {signalItem(link)}
                {Object.entries(DATALINK_LABEL_KEYS)
                  .filter(([name]) => name !== 'SignalStrength' && name in link.values)
                  .map(([name, key]) => (
                    <DescriptionItem key={name} label={t(key)}>
                      <span className="wrap-anywhere">{value(name, link.values[name])}</span>
                    </DescriptionItem>
                  ))}
              </DescriptionList>
            </div>
          ))}
        {station.protocol === 'ocpp2x' && station.activeNetworkProfile != null && (
          <DescriptionList>
            <DescriptionItem label={t('stations.sim.station.activeNetworkProfile')}>
              {station.activeNetworkProfile}
            </DescriptionItem>
          </DescriptionList>
        )}
        {station.protocol === 'ocpp1.6' &&
          (Object.keys(station.values).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('stations.sim.station.noOcpp16Keys')}
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {t('stations.sim.station.ocpp16Keys')}
              </p>
              <DescriptionList>
                {Object.entries(station.values).map(([key, raw]) => (
                  <DescriptionItem key={key} label={key}>
                    <span className="wrap-anywhere">{raw ?? na}</span>
                  </DescriptionItem>
                ))}
              </DescriptionList>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
