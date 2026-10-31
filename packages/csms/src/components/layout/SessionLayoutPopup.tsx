// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The active session of a charging station on the 3D site layout, opened from
// the driver avatar above the car. Same frame and focus rules as the station
// popup (StationLayoutPopup.tsx); the view places it beside the avatar
// (layout-popup-position.ts). The layout query refreshes on every session and
// meter value event, so energy and cost follow live; the duration ticks here.

import { forwardRef, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { AccountAvatar } from '@/components/AccountAvatar';
import { cn } from '@/lib/utils';
import { formatCents, formatDuration, formatEnergy } from '@/lib/formatting';
import type { LayoutSession } from './StationCard';

/** "First Last" split for the initials of an avatar without a picture. */
export function splitDriverName(name: string | null): {
  first: string | null;
  last: string | null;
} {
  if (name == null || name.trim() === '') return { first: null, last: null };
  const parts = name.trim().split(/\s+/);
  return {
    first: parts[0] ?? null,
    last: parts.length > 1 ? (parts[parts.length - 1] ?? null) : null,
  };
}

/** The current time, refreshed every 30 seconds while the popup shows. */
function useNow(intervalMs: number): string {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(new Date().toISOString());
    }, intervalMs);
    return () => {
      window.clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

interface SessionLayoutPopupProps {
  session: LayoutSession;
  /** The OCPP station id shown on the popup. */
  stationLabel: string;
  /** Internal station id, for the station link. */
  stationId: string;
  onClose: () => void;
}

export const SessionLayoutPopup = forwardRef<HTMLDivElement, SessionLayoutPopupProps>(
  function SessionLayoutPopup({ session, stationLabel, stationId, onClose }, ref) {
    const { t } = useTranslation();
    const closeRef = useRef<HTMLButtonElement>(null);
    const onCloseRef = useRef(onClose);
    const now = useNow(30_000);
    useEffect(() => {
      onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      closeRef.current?.focus({ preventScroll: true });
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') onCloseRef.current();
      };
      window.addEventListener('keydown', onKey);
      return () => {
        window.removeEventListener('keydown', onKey);
        if (opener?.isConnected === true) opener.focus({ preventScroll: true });
      };
    }, []);

    const driver = session.driver;
    const names = splitDriverName(driver?.name ?? null);
    const title = driver?.name ?? t('sites.layoutView.sessionTitle');
    return (
      <div
        ref={ref}
        role="dialog"
        aria-label={t('sites.layoutView.sessionDetailsLabel', { id: stationLabel })}
        data-testid="session-layout-popup"
        className="absolute z-[1000] max-h-[calc(100%-24px)] w-[280px] max-w-[calc(100%-24px)] overflow-y-auto overscroll-contain rounded-lg border bg-card p-4 text-card-foreground shadow-lg"
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {driver != null && (
              <AccountAvatar
                avatar={driver.avatar}
                firstName={names.first}
                lastName={names.last}
                size="md"
              />
            )}
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold">{title}</h3>
              <p className="text-xs text-muted-foreground">{t('sites.layoutView.sessionActive')}</p>
            </div>
          </div>
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <dl className="my-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">{t('sites.layoutView.sessionEnergy')}</dt>
          <dd className="text-right tabular-nums" data-testid="session-popup-energy">
            {formatEnergy(session.energyDeliveredWh)}
          </dd>
          <dt className="text-muted-foreground">{t('sites.layoutView.sessionCost')}</dt>
          <dd className="text-right tabular-nums" data-testid="session-popup-cost">
            {session.currentCostCents != null
              ? formatCents(session.currentCostCents, session.currency)
              : '-'}
          </dd>
          <dt className="text-muted-foreground">{t('sites.layoutView.sessionDuration')}</dt>
          <dd className="text-right tabular-nums">{formatDuration(session.startedAt, now)}</dd>
          <dt className="text-muted-foreground">{t('sites.layoutView.sessionStation')}</dt>
          <dd className="text-right">
            <Link to={`/stations/${stationId}`} className="text-link hover:underline">
              {stationLabel}
            </Link>
          </dd>
        </dl>
        <div className="grid gap-2">
          <Link
            to={`/sessions/${session.id}`}
            className={cn(buttonVariants({ variant: 'outline' }), 'w-full')}
          >
            {t('sites.layoutView.openSession')}
          </Link>
          {driver != null && (
            <Link
              to={`/drivers/${driver.id}`}
              className={cn(buttonVariants({ variant: 'outline' }), 'w-full')}
            >
              {t('sites.layoutView.openDriver')}
            </Link>
          )}
        </div>
      </div>
    );
  },
);
