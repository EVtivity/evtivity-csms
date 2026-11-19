// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { Pagination } from '@/components/ui/pagination';
import { SessionsTable, type Session } from '@/components/SessionsTable';
import { LoadErrorRetry } from '@/components/charts/ChartBody';
import { FleetSessionDialog } from '@/components/fleet/FleetSessionDialog';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { useUserTimezone } from '@/lib/timezone';

/** Rows per page of the Dashboard Charging Sessions item. */
export const FLEET_CHARGING_SESSIONS_PAGE_SIZE = 20;

type FleetDashboardSession = Session & { fleetId: string | null };

interface FleetChargingSessionsWidgetProps {
  /** The fleet of the Dashboard fleet picker, null for every assigned fleet. */
  fleetId: string | null;
}

/**
 * The newest charging sessions billed to a fleet user's fleets, newest first,
 * 20 a page. A row opens the reduced fleet session view; no RFID card value or
 * transaction id, the cost only with payments:read.
 */
export function FleetChargingSessionsWidget({
  fleetId,
}: FleetChargingSessionsWidgetProps): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const canReadPayments = useHasPermission('payments:read');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<{ fleetId: string; sessionId: string } | null>(null);

  // A new fleet starts again at page 1.
  useEffect(() => {
    setPage(1);
  }, [fleetId]);

  const query = useQuery({
    queryKey: ['dashboard', 'fleet-sessions', fleetId, page],
    queryFn: () =>
      api.get<{ data: FleetDashboardSession[]; total: number }>(
        `/v1/fleets/dashboard-sessions?${new URLSearchParams({
          page: String(page),
          limit: String(FLEET_CHARGING_SESSIONS_PAGE_SIZE),
          ...(fleetId != null ? { fleetId } : {}),
        }).toString()}`,
      ),
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  });
  const totalPages = Math.max(
    1,
    Math.ceil((query.data?.total ?? 0) / FLEET_CHARGING_SESSIONS_PAGE_SIZE),
  );
  // Sessions move while the card is open: step back when the page runs past the end.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  return (
    <Card data-testid="fleet-charging-sessions">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-1.5">
          {t('dashboard.fleet.chargingSessions')}
          <InfoTooltip
            content={<div className="max-w-56">{t('dashboard.fleet.chargingSessionsInfo')}</div>}
          />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {query.isError ? (
          <LoadErrorRetry
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : (
          <div className="space-y-4">
            <SessionsTable
              sessions={query.data?.data}
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
              timezone={timezone}
              isLoading={query.isLoading}
              emptyMessage={t('dashboard.fleet.noChargingSessions')}
              linkEntities={false}
              visibility={{
                driverName: false,
                vehicle: false,
                guestSession: false,
                co2Avoided: false,
                cost: canReadPayments,
              }}
              onRowClick={(session: { id: string }): void => {
                const row = query.data?.data.find((s) => s.id === session.id);
                if (row?.fleetId != null) setOpen({ fleetId: row.fleetId, sessionId: row.id });
              }}
            />
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </div>
        )}
      </CardContent>
      {open != null && (
        <FleetSessionDialog
          fleetId={open.fleetId}
          sessionId={open.sessionId}
          onClose={() => {
            setOpen(null);
          }}
        />
      )}
    </Card>
  );
}
