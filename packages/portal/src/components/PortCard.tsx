// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Zap } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn, formatConnectorCurrentAmps, formatConnectorPowerKw, formatDate } from '@/lib/utils';
import { connectorStatusVariant, connectorStatusClassName } from '@/lib/connector-status';
import { ConnectorFaceIcon } from '@/components/ConnectorFaceIcon';
import { useConnectorTypeLabel } from '@/hooks/use-connector-type-label';

// The port (EVSE) card of every page that lists a station's or unit's ports:
// the signed-in charger page, the guest station page and the location page.
// Each page decides what a tap does; the card only shows the port. The status
// is the EVSE's (it charges one vehicle at a time through any of its
// connectors); each connector has its own line with its face, type and power
// (owner decision 2026-11-13).

export interface PortCardConnector {
  /** The connector id within the EVSE: the lines follow it when given. */
  connectorId?: number;
  connectorType: string | null;
  /** kW as a number or the API's decimal string. */
  maxPowerKw: number | string | null;
  maxCurrentAmps?: number | null;
}

export interface PortCardProps {
  evseId: number;
  connectors: readonly PortCardConnector[];
  /** The EVSE display status (`evseDisplayStatus`, or `unavailable` when it cannot start). */
  status: string;
  /** Whether a tap does something: dimmed and not clickable otherwise. */
  available: boolean;
  selected?: boolean;
  reservationExpiresAt?: string | null;
  timezone?: string | undefined;
  /** Without it the card only shows the port (the guest page of one port). */
  onSelect?: () => void;
  testId?: string;
}

export function PortCard({
  evseId,
  connectors,
  status,
  available,
  selected = false,
  reservationExpiresAt = null,
  timezone,
  onSelect,
  testId = 'port-card',
}: PortCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const typeLabel = useConnectorTypeLabel();
  const lines = connectors
    .map((c, index) => ({ c, index }))
    .sort((a, b) => (a.c.connectorId ?? a.index) - (b.c.connectorId ?? b.index))
    .map(({ c }) => c);
  const isCharging = ['charging', 'discharging'].includes(status);
  const isIdleState = ['suspended_ev', 'suspended_evse', 'idle'].includes(status);
  // A selectable card is a button for keyboard and screen reader users:
  // Tab reaches it, Enter or Space selects it, and its pressed state is
  // announced (WCAG 2.1.1, 4.1.2). A card that cannot be picked stays
  // focusable but announces itself as disabled.
  const selectable = onSelect != null;
  const activate = (): void => {
    if (available) onSelect?.();
  };
  const name = [
    t('stationDetail.connectorPort', { id: evseId }),
    t(`status.${status}`),
    ...lines.map((c) => typeLabel(c.connectorType)),
  ].join(', ');

  return (
    <Card
      data-testid={testId}
      {...(selectable
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-pressed': selected,
            'aria-disabled': !available,
            'aria-label': name,
            onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activate();
              }
            },
          }
        : {})}
      className={cn(
        'transition-all',
        selectable &&
          'outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background',
        available
          ? onSelect == null
            ? ''
            : selected
              ? 'border-primary bg-primary/5 shadow-md cursor-pointer'
              : 'hover:shadow-md cursor-pointer'
          : 'opacity-50 cursor-not-allowed',
        isCharging && 'ring-2 ring-success animate-pulse',
        isIdleState && 'ring-2 ring-warning animate-pulse',
      )}
      onClick={activate}
    >
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <Badge
            variant={connectorStatusVariant()}
            className={cn('text-xs', connectorStatusClassName(status))}
          >
            {t(`status.${status}`)}
          </Badge>
          {selected && <Zap className="h-4 w-4 text-link" />}
        </div>
        {status === 'reserved' && (
          <p className="text-xs text-muted-foreground">
            {reservationExpiresAt != null
              ? t('charger.reservedUntil', { time: formatDate(reservationExpiresAt, timezone) })
              : t('charger.reserved')}
          </p>
        )}
        <div className="space-y-1.5">
          {lines.length === 0 && <p className="text-sm font-medium">{typeLabel(null)}</p>}
          {lines.map((c, index) => {
            const kw = c.maxPowerKw != null ? Number(c.maxPowerKw) : 0;
            const amps = c.maxCurrentAmps ?? 0;
            return (
              <div
                key={c.connectorId ?? index}
                className="flex items-start gap-1.5"
                data-testid="port-card-connector"
              >
                <ConnectorFaceIcon
                  type={c.connectorType}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{typeLabel(c.connectorType)}</p>
                  {(kw > 0 || amps > 0) && (
                    <p className="text-xs text-muted-foreground">
                      {kw > 0 ? `${formatConnectorPowerKw(kw)} kW` : ''}
                      {kw > 0 && amps > 0 ? ' / ' : ''}
                      {amps > 0 ? `${formatConnectorCurrentAmps(amps)}A` : ''}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            {t('stationDetail.connectorPort', { id: evseId })}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** The grid the port cards stand in: one column for one port, else two. */
export function PortGrid({
  count,
  children,
}: {
  count: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={`grid gap-3 ${count === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>{children}</div>
  );
}
