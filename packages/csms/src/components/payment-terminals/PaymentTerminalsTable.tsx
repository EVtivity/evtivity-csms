// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, LoadingState, TableStateRow } from '@/components/ui/content-state';
import { formatDateTime } from '@/lib/timezone';
import { terminalName, terminalProviderName, type PaymentTerminal } from './payment-terminal-types';

/** The device status: a green dot while online, a gray one while offline, a dash when unknown. */
export function TerminalOnlineStatus({
  terminal,
  timezone,
}: {
  terminal: Pick<PaymentTerminal, 'online' | 'lastSeenAt'>;
  timezone: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (terminal.online == null) {
    return <span className="text-muted-foreground">{t('paymentTerminals.onlineUnknown')}</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-center gap-2">
        {terminal.online ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
          </span>
        ) : (
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground" />
        )}
        {terminal.online ? t('paymentTerminals.online') : t('paymentTerminals.offline')}
      </span>
      {terminal.lastSeenAt != null && (
        <span className="text-xs text-muted-foreground">
          {t('paymentTerminals.lastSeen', { time: formatDateTime(terminal.lastSeenAt, timezone) })}
        </span>
      )}
    </span>
  );
}

interface PaymentTerminalsTableProps {
  terminals: PaymentTerminal[] | undefined;
  timezone: string;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

const COLUMN_COUNT = 8;

/** The payment terminal list; a row opens the terminal page. */
export function PaymentTerminalsTable({
  terminals,
  timezone,
  isLoading,
  isError,
  onRetry,
}: PaymentTerminalsTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const na = t('common.na');

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('paymentTerminals.columns.label')}</TableHead>
            <TableHead>{t('paymentTerminals.columns.model')}</TableHead>
            <TableHead>{t('paymentTerminals.columns.site')}</TableHead>
            <TableHead>{t('paymentTerminals.columns.station')}</TableHead>
            <TableHead>{t('paymentTerminals.columns.provider')}</TableHead>
            <TableHead>{t('paymentTerminals.columns.status')}</TableHead>
            <TableHead>{t('paymentTerminals.columns.online')}</TableHead>
            <TableHead>{t('paymentTerminals.columns.sim')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableStateRow colSpan={COLUMN_COUNT}>
              <LoadingState />
            </TableStateRow>
          )}
          {isError && !isLoading && (
            <TableStateRow colSpan={COLUMN_COUNT}>
              <ErrorState onRetry={onRetry} />
            </TableStateRow>
          )}
          {!isLoading && !isError && terminals?.length === 0 && (
            <TableStateRow colSpan={COLUMN_COUNT}>
              <EmptyState>{t('paymentTerminals.noTerminals')}</EmptyState>
            </TableStateRow>
          )}
          {terminals?.map((terminal) => (
            <TableRow
              key={terminal.id}
              className="cursor-pointer"
              data-testid={`payment-terminal-row-${terminal.id}`}
              onClick={() => {
                void navigate(`/payment-terminals/${terminal.id}`);
              }}
            >
              <TableCell
                className="max-w-48 truncate font-medium text-link"
                data-testid="row-click-target"
                title={terminalName(terminal)}
              >
                {terminalName(terminal)}
              </TableCell>
              {/* The serial number sits under the model, as the connector under the
                  station, so the eight columns fit a desktop page. */}
              <TableCell>
                <span className="flex flex-col">
                  <span>{terminal.model ?? na}</span>
                  {terminal.serialNumber != null && (
                    <span className="text-xs text-muted-foreground">{terminal.serialNumber}</span>
                  )}
                </span>
              </TableCell>
              <TableCell className="min-w-32 whitespace-normal">
                {terminal.siteId != null ? (
                  <Link
                    to={`/sites/${terminal.siteId}`}
                    className="text-link hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                  >
                    {terminal.siteName ?? terminal.siteId}
                  </Link>
                ) : (
                  na
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {terminal.stationId != null ? (
                  <span className="flex flex-col">
                    <Link
                      to={`/stations/${terminal.stationId}`}
                      className="text-link hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                      }}
                    >
                      {terminal.stationOcppId ?? terminal.stationId}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {terminal.evseNumber != null
                        ? t('paymentTerminals.connector', { number: terminal.evseNumber })
                        : t('paymentTerminals.wholeStation')}
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">{t('paymentTerminals.notPaired')}</span>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {terminalProviderName(t, terminal.provider)}
              </TableCell>
              <TableCell>
                <Badge variant={terminal.status === 'active' ? 'success' : 'secondary'}>
                  {t(`paymentTerminals.status.${terminal.status}`)}
                </Badge>
              </TableCell>
              {/* The last seen time wraps under the status instead of widening the table. */}
              <TableCell className="min-w-36 whitespace-normal">
                <TerminalOnlineStatus terminal={terminal} timezone={timezone} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {terminal.simAttached ? t('paymentTerminals.simAttached') : t('common.no')}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
