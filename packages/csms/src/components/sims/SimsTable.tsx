// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { LoadingLogo } from '@/components/loading-logo';
import { providerName, stateBadgeVariant, type SimState } from '@/components/sim/sim-connectivity';
import type { ColumnMeta, ColumnVisibility } from '@/lib/column-visibility';
import { formatDate, formatDateTime } from '@/lib/timezone';

/** One SIM of `GET /v1/sims`: the fields the list shows. */
export interface SimListItem {
  id: string;
  iccid: string;
  imsi: string | null;
  label: string | null;
  provider: string | null;
  /** The CSMS status, set by Deactivate and Reactivate only. */
  status: 'active' | 'inactive';
  /** The provider status stored by the last Refresh, null before one. */
  lastStatus: { state: SimState } | null;
  statusFetchedAt: string | null;
  lastFetchedAt: string | null;
  createdAt: string;
  attachment: {
    id: number;
    stationId: string | null;
    stationOcppId: string | null;
    siteName: string | null;
    confirmed: boolean;
  } | null;
}

export const SIMS_COLUMNS: ColumnMeta[] = [
  {
    key: 'iccid',
    label: 'sims.columns.iccid',
    defaultVisible: true,
    defaultVisibleMobile: true,
    alwaysVisible: true,
  },
  { key: 'label', label: 'sims.columns.label', defaultVisible: true, defaultVisibleMobile: false },
  {
    key: 'provider',
    label: 'sims.columns.provider',
    defaultVisible: true,
    defaultVisibleMobile: false,
  },
  {
    key: 'csmsStatus',
    label: 'sims.columns.csmsStatus',
    defaultVisible: true,
    defaultVisibleMobile: true,
  },
  {
    key: 'providerStatus',
    label: 'sims.columns.providerStatus',
    defaultVisible: true,
    defaultVisibleMobile: false,
  },
  {
    key: 'station',
    label: 'sims.columns.station',
    defaultVisible: true,
    defaultVisibleMobile: true,
  },
  {
    key: 'confirmed',
    label: 'sims.columns.confirmed',
    defaultVisible: true,
    defaultVisibleMobile: false,
  },
  {
    key: 'lastFetched',
    label: 'sims.columns.lastFetched',
    defaultVisible: true,
    defaultVisibleMobile: false,
  },
  {
    key: 'created',
    label: 'sims.columns.created',
    defaultVisible: true,
    defaultVisibleMobile: false,
  },
];

/** The later of the provider status fetch and the sessions fetch, or null before either. */
export function simLastFetchedAt(sim: SimListItem): string | null {
  const times = [sim.statusFetchedAt, sim.lastFetchedAt].filter((v): v is string => v != null);
  if (times.length === 0) return null;
  return times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

interface SimsTableProps {
  sims: SimListItem[] | undefined;
  timezone: string;
  isLoading: boolean;
  /** The list failed to load: shows the load error with a Retry button. */
  isError: boolean;
  onRetry: () => void;
  visibility: ColumnVisibility;
}

export function SimsTable({
  sims,
  timezone,
  isLoading,
  isError,
  onRetry,
  visibility,
}: SimsTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isVisible = (key: string): boolean => visibility[key] !== false;
  const colCount = SIMS_COLUMNS.filter((c) => isVisible(c.key)).length;

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {isVisible('iccid') && <TableHead>{t('sims.columns.iccid')}</TableHead>}
            {isVisible('label') && <TableHead>{t('sims.columns.label')}</TableHead>}
            {isVisible('provider') && <TableHead>{t('sims.columns.provider')}</TableHead>}
            {isVisible('csmsStatus') && <TableHead>{t('sims.columns.csmsStatus')}</TableHead>}
            {isVisible('providerStatus') && (
              <TableHead>{t('sims.columns.providerStatus')}</TableHead>
            )}
            {isVisible('station') && <TableHead>{t('sims.columns.station')}</TableHead>}
            {isVisible('confirmed') && <TableHead>{t('sims.columns.confirmed')}</TableHead>}
            {isVisible('lastFetched') && <TableHead>{t('sims.columns.lastFetched')}</TableHead>}
            {isVisible('created') && <TableHead>{t('sims.columns.created')}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={colCount} className="text-center text-muted-foreground">
                <LoadingLogo size="inline" />
              </TableCell>
            </TableRow>
          )}
          {isError && !isLoading && (
            <TableRow>
              <TableCell colSpan={colCount} className="text-center">
                <span className="text-destructive">{t('common.loadError')}</span>
                <Button variant="outline" size="sm" className="ml-3" onClick={onRetry}>
                  {t('common.retry')}
                </Button>
              </TableCell>
            </TableRow>
          )}
          {sims?.map((sim) => {
            const fetchedAt = simLastFetchedAt(sim);
            const attachment = sim.attachment;
            return (
              <TableRow
                key={sim.id}
                className="cursor-pointer"
                data-testid={`sim-row-${sim.id}`}
                onClick={() => {
                  void navigate(`/sims/${sim.id}`);
                }}
              >
                {isVisible('iccid') && (
                  <TableCell
                    className="whitespace-nowrap font-medium text-link"
                    data-testid="row-click-target"
                  >
                    {sim.iccid}
                  </TableCell>
                )}
                {isVisible('label') && (
                  <TableCell className="max-w-48 truncate" title={sim.label ?? undefined}>
                    {sim.label ?? '-'}
                  </TableCell>
                )}
                {isVisible('provider') && (
                  <TableCell className="whitespace-nowrap">
                    {sim.provider != null ? providerName(sim.provider) : '-'}
                  </TableCell>
                )}
                {isVisible('csmsStatus') && (
                  <TableCell>
                    <Badge variant={sim.status === 'active' ? 'success' : 'secondary'}>
                      {t(`sims.csmsStatus.${sim.status}`)}
                    </Badge>
                  </TableCell>
                )}
                {isVisible('providerStatus') && (
                  <TableCell>
                    {sim.lastStatus != null ? (
                      <Badge variant={stateBadgeVariant(sim.lastStatus.state)}>
                        {t(`stations.sim.state.${sim.lastStatus.state}`)}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">{t('sims.notFetched')}</span>
                    )}
                  </TableCell>
                )}
                {isVisible('station') && (
                  <TableCell className="whitespace-nowrap">
                    {attachment?.stationId != null ? (
                      <Link
                        to={`/stations/${attachment.stationId}`}
                        className="text-link hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        {attachment.stationOcppId ?? attachment.stationId}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{t('sims.notAttached')}</span>
                    )}
                  </TableCell>
                )}
                {isVisible('confirmed') && (
                  <TableCell>
                    {attachment == null ? (
                      '-'
                    ) : attachment.confirmed ? (
                      <Badge variant="success">{t('common.yes')}</Badge>
                    ) : (
                      <Badge variant="warning">{t('common.no')}</Badge>
                    )}
                  </TableCell>
                )}
                {isVisible('lastFetched') && (
                  <TableCell className="whitespace-nowrap">
                    {fetchedAt != null ? formatDateTime(fetchedAt, timezone) : '-'}
                  </TableCell>
                )}
                {isVisible('created') && (
                  <TableCell className="whitespace-nowrap">
                    {formatDate(sim.createdAt, timezone)}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
          {!isError && sims?.length === 0 && (
            <TableRow>
              <TableCell colSpan={colCount} className="text-center text-muted-foreground">
                {t('sims.noSims')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
