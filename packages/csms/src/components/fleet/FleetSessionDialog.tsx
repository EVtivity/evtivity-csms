// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { sessionDisplayCostCents } from '@evtivity/lib/session-cost';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DescriptionItem, DescriptionList } from '@/components/ui/description-list';
import { ErrorState, LoadingState } from '@/components/ui/content-state';
import { useChargingPointPath } from '@/hooks/use-charging-point-path';
import { api } from '@/lib/api';
import { formatCents, formatDuration, formatNumber } from '@/lib/formatting';
import { sessionStatusVariant } from '@/lib/status-variants';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

/** `GET /v1/fleets/:id/sessions/:sessionId`: the reduced session view a fleet user reads. */
export interface FleetSessionView {
  id: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  energyDeliveredWh: number;
  siteName: string | null;
  stationName: string | null;
  unitName?: string | null;
  evseId?: number | null;
  connectorId?: number | null;
  connectorType?: string | null;
  driverName: string | null;
  /** The driver was erased: shown as Erased Driver, with no personal data. */
  driverErased?: boolean;
  cardLabel: string | null;
  currentCostCents?: number | null;
  finalCostCents?: number | null;
  currency?: string;
}

interface FleetSessionDialogProps {
  fleetId: string;
  sessionId: string;
  onClose: () => void;
}

/** One session of the fleet session list, read only, for readers without the session page. */
export function FleetSessionDialog({
  fleetId,
  sessionId,
  onClose,
}: FleetSessionDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const chargingPointPath = useChargingPointPath();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['fleets', fleetId, 'sessions', 'view', sessionId],
    queryFn: () => api.get<FleetSessionView>(`/v1/fleets/${fleetId}/sessions/${sessionId}`),
  });

  const cost =
    data?.currency != null
      ? sessionDisplayCostCents({
          status: data.status,
          currentCostCents: data.currentCostCents ?? null,
          finalCostCents: data.finalCostCents ?? null,
        })
      : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent scrollable className="max-w-[95vw] md:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('fleets.sessionDialog.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {isLoading ? (
            <LoadingState />
          ) : isError || data == null ? (
            <ErrorState
              onRetry={() => {
                void refetch();
              }}
            />
          ) : (
            <DescriptionList data-testid="fleet-session-view">
              <DescriptionItem label={t('sessions.sessionId')}>{data.id}</DescriptionItem>
              <DescriptionItem label={t('sessions.chargingPoint')}>
                {chargingPointPath({
                  siteName: data.siteName,
                  stationName: data.stationName,
                  unitName: data.unitName ?? null,
                  evseId: data.evseId ?? null,
                  connectorId: data.connectorId ?? null,
                  connectorType: data.connectorType ?? null,
                }) || '-'}
              </DescriptionItem>
              <DescriptionItem label={t('common.status')}>
                <Badge variant={sessionStatusVariant(data.status, false)}>
                  {t(`status.${data.status}`, { defaultValue: data.status })}
                </Badge>
              </DescriptionItem>
              <DescriptionItem label={t('sessions.driverName')}>
                {data.driverErased === true ? t('drivers.erasedName') : (data.driverName ?? '-')}
              </DescriptionItem>
              {data.cardLabel != null && (
                <DescriptionItem label={t('fleets.sessionDialog.card')}>
                  {data.cardLabel}
                </DescriptionItem>
              )}
              <DescriptionItem label={t('sessions.started')}>
                {data.startedAt != null ? formatDateTime(data.startedAt, timezone) : '-'}
              </DescriptionItem>
              <DescriptionItem label={t('sessions.ended')}>
                {data.endedAt != null ? formatDateTime(data.endedAt, timezone) : '-'}
              </DescriptionItem>
              <DescriptionItem label={t('sessions.duration')}>
                {formatDuration(data.startedAt, data.endedAt)}
              </DescriptionItem>
              <DescriptionItem label={t('sessions.energy')}>
                {t('sessions.energyKwh', {
                  value: formatNumber(data.energyDeliveredWh / 1000, 2),
                })}
              </DescriptionItem>
              {data.currency != null && (
                <DescriptionItem label={t('payments.cost')}>
                  {cost != null ? formatCents(cost, data.currency) : '-'}
                </DescriptionItem>
              )}
            </DescriptionList>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
