// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The site summary chip and the accessible station list of the 3D site
// layout. The chip counts the stations that need attention or are busy
// ("2 Faulted · 1 Offline · 5 Charging"); each count is a button that turns
// the view to the next station in that state. The list shows the same data
// as the scene (station, state, power, session) as plain buttons for the
// keyboard and screen readers; choosing one turns the view to the station
// and opens its popup.

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatEnergy, formatNumber } from '@/lib/formatting';
import {
  stationDisplayState,
  stationStateLabelKey,
  stationStateTextColor,
  type StationDisplayState,
} from '@/lib/station-display-state';
import { cn } from '@/lib/utils';
import type { LayoutStation } from './StationCard';

/** The states the summary counts, in this order. */
export const SUMMARY_STATES = [
  'faulted',
  'offline',
  'charging',
] as const satisfies readonly StationDisplayState[];
export type SummaryState = (typeof SUMMARY_STATES)[number];

/** How many stations are in each summary state; states without one are left out. */
export function layoutSummary(
  stations: readonly LayoutStation[],
): Array<{ state: SummaryState; count: number }> {
  const counts = new Map<SummaryState, number>();
  for (const s of stations) {
    const state = stationDisplayState(s);
    if ((SUMMARY_STATES as readonly string[]).includes(state)) {
      counts.set(state as SummaryState, (counts.get(state as SummaryState) ?? 0) + 1);
    }
  }
  return SUMMARY_STATES.flatMap((state) => {
    const count = counts.get(state) ?? 0;
    return count > 0 ? [{ state, count }] : [];
  });
}

/** The station after `currentId` in `state` (in list order, wrapping), or the first one. */
export function nextStationInState(
  stations: readonly LayoutStation[],
  state: StationDisplayState,
  currentId: string | null,
): string | null {
  const ids = stations.filter((s) => stationDisplayState(s) === state).map((s) => s.id);
  if (ids.length === 0) return null;
  const at = currentId == null ? -1 : ids.indexOf(currentId);
  return ids[(at + 1) % ids.length] ?? null;
}

/** Energy of the station's active session(s), from the connectors, or null. */
function stationEnergyWh(station: LayoutStation): number | null {
  let total: number | null = null;
  for (const evse of station.evses) {
    for (const conn of evse.connectors) {
      if (conn.energyDeliveredWh != null) total = (total ?? 0) + conn.energyDeliveredWh;
    }
  }
  return total;
}

interface SummaryChipProps {
  stations: readonly LayoutStation[];
  onFocusState: (state: SummaryState) => void;
}

export function LayoutSummaryChip({
  stations,
  onFocusState,
}: SummaryChipProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const summary = layoutSummary(stations);
  if (summary.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t('sites.layoutView.summaryLabel')}
      data-testid="site-layout-summary"
      className="pointer-events-auto inline-flex max-w-full flex-wrap items-center gap-x-1 rounded-md border bg-card px-1 py-0.5 text-xs font-semibold shadow-xs"
    >
      {summary.map(({ state, count }, i) => (
        <span key={state} className="flex items-center">
          {i > 0 && (
            <span aria-hidden="true" className="px-0.5 text-muted-foreground">
              ·
            </span>
          )}
          <button
            type="button"
            data-testid={`site-layout-summary-${state}`}
            className="rounded px-1 py-0.5 tabular-nums hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ color: stationStateTextColor(state) }}
            aria-label={t('sites.layoutView.summaryFocus', {
              n: count,
              state: t(stationStateLabelKey(state)),
            })}
            onClick={() => {
              onFocusState(state);
            }}
          >
            {count} {t(stationStateLabelKey(state))}
          </button>
        </span>
      ))}
    </div>
  );
}

interface StationListProps {
  stations: readonly LayoutStation[];
  currentDrawKw: (stationId: string) => number | undefined;
  selectedId: string | null;
  onSelect: (stationId: string) => void;
}

/** The station list beside the 3D view: one button per station, Up and Down move between them. */
export function LayoutStationList({
  stations,
  currentDrawKw,
  selectedId,
  onSelect,
}: StationListProps): React.JSX.Element {
  const { t } = useTranslation();
  const listRef = useRef<HTMLUListElement>(null);

  function move(from: HTMLElement, step: number): void {
    const buttons = [...(listRef.current?.querySelectorAll('button') ?? [])];
    const at = buttons.indexOf(from as HTMLButtonElement);
    const next = buttons[Math.min(buttons.length - 1, Math.max(0, at + step))];
    next?.focus();
  }

  return (
    <ul
      ref={listRef}
      aria-label={t('sites.layoutView.stationList')}
      data-testid="site-layout-station-list"
      className="grid gap-1"
    >
      {stations.map((s) => {
        const state = stationDisplayState(s);
        const stateLabel = t(stationStateLabelKey(state));
        const kw = currentDrawKw(s.id) ?? 0;
        const energy = s.session?.energyDeliveredWh ?? stationEnergyWh(s);
        const driver = s.session?.driver?.name ?? null;
        const sessionText =
          energy != null
            ? driver != null
              ? `${driver} · ${formatEnergy(energy)}`
              : formatEnergy(energy)
            : t('sites.layoutView.noSession');
        const power = `${formatNumber(kw, 1)} kW`;
        return (
          <li key={s.id}>
            <button
              type="button"
              data-testid={`site-layout-list-${s.id}`}
              aria-current={selectedId === s.id ? 'true' : undefined}
              aria-label={t('sites.layoutView.listItemLabel', {
                id: s.stationId,
                state: stateLabel,
                power,
                session: sessionText,
              })}
              className={cn(
                'grid w-full min-w-0 gap-0.5 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                selectedId === s.id ? 'border-primary bg-primary/5' : 'bg-card',
              )}
              onClick={() => {
                onSelect(s.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  move(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
                }
              }}
            >
              <span className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="min-w-0 truncate font-semibold">{s.stationId}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{power}</span>
              </span>
              <span className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="shrink-0" style={{ color: stationStateTextColor(state) }}>
                  {stateLabel}
                </span>
                <span className="min-w-0 truncate text-muted-foreground">{sessionText}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
