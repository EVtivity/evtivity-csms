// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { SearchInput } from '@/components/search-input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { useUserTimezone, formatDateTime } from '@/lib/timezone';
import { LoadingLogo } from '@/components/loading-logo';

interface AuthorizeAttempt {
  id: number;
  stationOcppId: string | null;
  stationDbId: string | null;
  idToken: string;
  tokenType: string | null;
  matchedTokenId: string | null;
  matchedDriverId: string | null;
  sessionId: string | null;
  outcome: string;
  ocppVersion: string | null;
  reason: string | null;
  createdAt: string;
}

const OUTCOMES = [
  '',
  'accepted',
  'invalid',
  'blocked',
  'expired',
  'no_credit',
  'concurrent_tx',
  'unknown',
  'db_error',
] as const;

function outcomeVariant(outcome: string): 'success' | 'destructive' | 'warning' | 'secondary' {
  switch (outcome) {
    case 'accepted':
      return 'success';
    case 'invalid':
    case 'blocked':
    case 'expired':
    case 'no_credit':
      return 'destructive';
    case 'db_error':
      return 'warning';
    default:
      return 'secondary';
  }
}

export interface AuthorizeLogViewProps {
  fixedFilters?: { matchedTokenId?: string; matchedDriverId?: string; stationId?: string };
  hideIdTokenFilter?: boolean;
  hideStationColumn?: boolean;
  hideMatchedTokenColumn?: boolean;
  hideSessionColumn?: boolean;
  queryKey?: string;
}

export function AuthorizeLogView({
  fixedFilters,
  hideIdTokenFilter,
  hideStationColumn,
  hideMatchedTokenColumn,
  hideSessionColumn,
  queryKey,
}: AuthorizeLogViewProps): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const [outcome, setOutcome] = useState('');
  const [idToken, setIdToken] = useState('');

  const filters: Record<string, string> = { outcome };
  if (!hideIdTokenFilter) filters['idToken'] = idToken;
  if (fixedFilters?.matchedTokenId != null) {
    filters['matchedTokenId'] = fixedFilters.matchedTokenId;
  }
  if (fixedFilters?.matchedDriverId != null) {
    filters['matchedDriverId'] = fixedFilters.matchedDriverId;
  }
  if (fixedFilters?.stationId != null) filters['stationId'] = fixedFilters.stationId;

  const { data, isLoading, page, totalPages, setPage } = usePaginatedQuery<AuthorizeAttempt>(
    queryKey ?? 'authorize-attempts',
    '/v1/authorize-attempts',
    filters,
  );

  // Columns: timestamp, idToken, type, outcome, reason (always 5) + station + matchedToken + session (conditional).
  const visibleColumns =
    5 +
    (hideStationColumn ? 0 : 1) +
    (hideMatchedTokenColumn ? 0 : 1) +
    (hideSessionColumn ? 0 : 1);

  return (
    <div className="space-y-6">
      <Card>
        <CardContent
          className={hideIdTokenFilter ? 'p-4' : 'grid grid-cols-1 gap-4 p-4 md:grid-cols-2'}
        >
          {!hideIdTokenFilter && (
            <div className="space-y-2">
              <Label htmlFor="authorize-log-token">{t('tokens.idToken')}</Label>
              <SearchInput
                id="authorize-log-token"
                value={idToken}
                onDebouncedChange={setIdToken}
                placeholder={t('tokens.filterIdToken')}
                className="h-9 max-w-none"
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="authorize-log-outcome">{t('tokens.outcome')}</Label>
            <Select
              id="authorize-log-outcome"
              className="h-9"
              value={outcome}
              onChange={(e) => {
                setOutcome(e.target.value);
              }}
            >
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {o === '' ? t('tokens.filterOutcome') : o}
                </option>
              ))}
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('common.timestamp')}</TableHead>
                {!hideStationColumn && <TableHead>{t('tokens.stationColumn')}</TableHead>}
                <TableHead>{t('tokens.idToken')}</TableHead>
                <TableHead>{t('tokens.type')}</TableHead>
                <TableHead>{t('tokens.outcome')}</TableHead>
                <TableHead>{t('tokens.reason')}</TableHead>
                {!hideMatchedTokenColumn && <TableHead>{t('tokens.matchedToken')}</TableHead>}
                {!hideSessionColumn && <TableHead>{t('tokens.sessionColumn')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns}
                    className="text-center text-sm text-muted-foreground"
                  >
                    <LoadingLogo size="inline" />
                  </TableCell>
                </TableRow>
              ) : data == null || data.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns}
                    className="text-center text-sm text-muted-foreground"
                  >
                    {t('common.noResults')}
                  </TableCell>
                </TableRow>
              ) : (
                data.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatDateTime(row.createdAt, timezone)}
                    </TableCell>
                    {!hideStationColumn && (
                      <TableCell>
                        {row.stationDbId != null ? (
                          <Link
                            to={`/stations/${row.stationDbId}`}
                            className="text-primary hover:underline"
                          >
                            {row.stationOcppId ?? row.stationDbId}
                          </Link>
                        ) : (
                          (row.stationOcppId ?? 'n/a')
                        )}
                      </TableCell>
                    )}
                    <TableCell>{row.idToken}</TableCell>
                    <TableCell>{row.tokenType ?? 'n/a'}</TableCell>
                    <TableCell>
                      <Badge variant={outcomeVariant(row.outcome)}>{row.outcome}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.reason ?? 'n/a'}
                    </TableCell>
                    {!hideMatchedTokenColumn && (
                      <TableCell>
                        {row.matchedTokenId != null ? (
                          <Link
                            to={`/tokens/${row.matchedTokenId}`}
                            className="text-primary hover:underline"
                          >
                            {row.matchedTokenId}
                          </Link>
                        ) : (
                          'n/a'
                        )}
                      </TableCell>
                    )}
                    {!hideSessionColumn && (
                      <TableCell>
                        {row.sessionId != null ? (
                          <Link
                            to={`/sessions/${row.sessionId}`}
                            className="text-primary hover:underline"
                          >
                            {row.sessionId}
                          </Link>
                        ) : (
                          'n/a'
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}
    </div>
  );
}
