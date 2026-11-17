// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { ExportButton } from '@/components/export-button';
import { API_BASE_URL } from '@/lib/config';
import { downloadApiFile } from '@/lib/csv-download';
import { getErrorMessage } from '@/lib/error-message';
import { LogDateRangeFilter } from '@/components/LogDateRangeFilter';
import { useUrlDateRange } from '@/hooks/use-url-date-range';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TabPanel } from '@/components/ui/tab-panel';
import { Pagination } from '@/components/ui/pagination';
import {
  FLEET_SESSION_SORT_KEYS,
  SessionsTable,
  type SessionSortKey,
} from '@/components/SessionsTable';
import { useListSort, type ListSort } from '@/hooks/use-list-sort';
import { api } from '@/lib/api';
import { useHasPermission, useIsFleetUser } from '@/lib/auth';
import { useUserTimezone } from '@/lib/timezone';
import { FleetSessionDialog } from './FleetSessionDialog';
import { FleetMemberCombobox, type FleetMemberSelection } from './FleetMemberCombobox';
import { FleetCardCombobox, type FleetCardSelection } from './FleetCardCombobox';

interface SessionRow {
  id: string;
  stationId: string;
  stationName: string | null;
  siteName: string | null;
  driverId: string | null;
  driverName: string | null;
  transactionId: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  idleStartedAt: string | null;
  energyDeliveredWh: number | null;
  currentCostCents: number | null;
  finalCostCents: number | null;
  currency: string;
  freeVend: boolean | null;
  co2AvoidedKg: number | null;
}

interface FleetSessionsTabProps {
  fleetId: string;
}

export function FleetSessionsTab({ fleetId }: FleetSessionsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  // A fleet user has no session, station or driver pages: a row opens the reduced view.
  const isFleetUser = useIsFleetUser();
  const canReadPayments = useHasPermission('payments:read');
  const canReadCards = useHasPermission('fleetCards:read');
  const canExport = useHasPermission('sessions:read');
  const { toast } = useToast();
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const range = useUrlDateRange();
  const [member, setMember] = useState<FleetMemberSelection | null>(null);
  const [card, setCard] = useState<FleetCardSelection | null>(null);
  const filterParams: Record<string, string> = {
    ...range.apiParams,
    ...(member != null ? { driverId: member.id } : {}),
    ...(card != null ? { tokenId: card.id } : {}),
  };
  const limit = 10;
  const listSort = useListSort<SessionSortKey>(FLEET_SESSION_SORT_KEYS);
  // A new sort starts again at page 1.
  const sessionsSort: ListSort<SessionSortKey> = {
    ...listSort,
    toggle: (key) => {
      setPage(1);
      listSort.toggle(key);
    },
  };
  const query = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    ...listSort.params,
    ...filterParams,
  });

  const {
    data: response,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['fleets', fleetId, 'sessions', page, listSort.params, filterParams],
    queryFn: () =>
      api.get<{ data: SessionRow[]; total: number }>(
        `/v1/fleets/${fleetId}/sessions?${query.toString()}`,
      ),
  });

  const totalPages = Math.max(1, Math.ceil((response?.total ?? 0) / limit));

  return (
    <>
      <TabPanel
        title={t('sessions.title')}
        actions={
          canExport ? (
            <ExportButton
              label={t('sites.exportCsv')}
              onClick={() => {
                const params = new URLSearchParams(filterParams).toString();
                downloadApiFile(
                  `${API_BASE_URL}/v1/fleets/${fleetId}/sessions/export${params !== '' ? `?${params}` : ''}`,
                  'fleet-sessions.csv',
                ).catch((err: unknown) => {
                  toast({ title: getErrorMessage(err, t), variant: 'destructive' });
                });
              }}
            />
          ) : undefined
        }
      >
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="fleet-sessions-member" className="leading-6">
              {t('fleets.sessionFilters.member')}
            </Label>
            <FleetMemberCombobox
              id="fleet-sessions-member"
              fleetId={fleetId}
              value={member}
              activeOnly={false}
              onSelect={(next) => {
                setMember(next);
                setPage(1);
              }}
            />
          </div>
          {canReadCards && (
            <div className="space-y-2">
              <Label htmlFor="fleet-sessions-card" className="leading-6">
                {t('fleets.sessionFilters.rfidCard')}
              </Label>
              <FleetCardCombobox
                id="fleet-sessions-card"
                fleetId={fleetId}
                value={card}
                onSelect={(next) => {
                  setCard(next);
                  setPage(1);
                }}
              />
            </div>
          )}
          <LogDateRangeFilter
            range={range}
            onChange={() => {
              setPage(1);
            }}
          />
        </div>
      </TabPanel>
      <TabPanel>
        <SessionsTable
          sessions={response?.data}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          timezone={timezone}
          isLoading={isLoading}
          isError={isError}
          onRetry={() => {
            void refetch();
          }}
          sort={sessionsSort}
          sortKeys={FLEET_SESSION_SORT_KEYS}
          emptyMessage={t(
            Object.keys(filterParams).length > 0
              ? 'fleets.sessionsEmpty.filtered'
              : 'fleets.sessionsEmpty.none',
          )}
          {...(isFleetUser
            ? {
                linkEntities: false,
                visibility: {
                  driverName: false,
                  vehicle: false,
                  guestSession: false,
                  co2Avoided: false,
                  cost: canReadPayments,
                },
                onRowClick: (session: { id: string }): void => {
                  setOpenSessionId(session.id);
                },
              }
            : {})}
        />
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </TabPanel>
      {openSessionId != null && (
        <FleetSessionDialog
          fleetId={fleetId}
          sessionId={openSessionId}
          onClose={() => {
            setOpenSessionId(null);
          }}
        />
      )}
    </>
  );
}
