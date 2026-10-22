// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  Clock,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatCalendarDate } from '@/lib/formatting';
import { COVERAGE_LABELS, type CoverageDay, type CoverageLabel } from './sim-connectivity';

// The tone marks the border, the fill and the icon; the date and label stay in the
// body text color, since a tone color as small text is below 4.5:1 on its own fill.
const LABEL_STYLE: Record<CoverageLabel, { icon: LucideIcon; box: string; iconClass: string }> = {
  has_data: {
    icon: CircleCheck,
    box: 'border-success/60 bg-success/10',
    iconClass: 'text-success',
  },
  no_sessions: {
    icon: CircleMinus,
    box: 'border-border bg-muted',
    iconClass: 'text-muted-foreground',
  },
  partial: {
    icon: CircleDashed,
    box: 'border-warning/60 bg-warning/10',
    iconClass: 'text-warning',
  },
  pending: { icon: Clock, box: 'border-info/60 bg-info/10', iconClass: 'text-info' },
  not_fetched: {
    icon: CircleHelp,
    box: 'border-dashed border-warning/60 bg-background',
    iconClass: 'text-warning',
  },
  unavailable: {
    icon: Ban,
    box: 'border-border bg-background',
    iconClass: 'text-muted-foreground',
  },
};

const LABEL_KEYS = {
  has_data: 'stations.simCoverage.hasData',
  no_sessions: 'stations.simCoverage.noSessions',
  partial: 'stations.simCoverage.partial',
  pending: 'stations.simCoverage.pending',
  not_fetched: 'stations.simCoverage.notFetched',
  unavailable: 'stations.simCoverage.unavailable',
} as const;

/** Days a click can fetch: those never or only partly fetched. */
export function isFetchableDay(label: CoverageLabel): boolean {
  return label === 'not_fetched' || label === 'partial';
}

interface SimCoverageStripProps {
  days: CoverageDay[];
  /** Opens the date dialog for a Not Fetched or Partly Fetched day. */
  onSelectDay?: (date: string) => void;
}

/**
 * One cell per day with an icon and a text label (never color alone), a
 * legend under it, and its own sideways scroll so a month never widens a phone page.
 */
export function SimCoverageStrip({ days, onSelectDay }: SimCoverageStripProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 space-y-2">
      <div className="max-w-full overflow-x-auto pb-1" data-testid="sim-coverage-scroll">
        <ul className="flex w-max gap-1" aria-label={t('stations.simCoverage.title')}>
          {days.map((day) => {
            const style = LABEL_STYLE[day.label];
            const Icon = style.icon;
            const label = t(LABEL_KEYS[day.label]);
            const date = formatCalendarDate(day.date);
            const name = t('stations.simCoverage.dayLabel', { date, label });
            const body = (
              <>
                <span className="text-xs font-medium">{date}</span>
                <Icon className={cn('h-4 w-4', style.iconClass)} aria-hidden="true" />
                <span className="text-xs">{label}</span>
              </>
            );
            const cellClass = cn(
              'flex w-20 flex-col items-center gap-1 rounded-md border px-1 py-2 text-center text-foreground',
              style.box,
            );
            return (
              <li key={day.date} data-testid={`sim-coverage-day-${day.date}`}>
                <Tooltip content={name}>
                  {onSelectDay != null && isFetchableDay(day.label) ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="cell"
                      aria-label={name}
                      onClick={() => {
                        onSelectDay(day.date);
                      }}
                    >
                      <span data-testid="sim-coverage-cell" className={cellClass}>
                        {body}
                      </span>
                    </Button>
                  ) : (
                    <span
                      role="img"
                      aria-label={name}
                      data-testid="sim-coverage-cell"
                      className={cellClass}
                    >
                      {body}
                    </span>
                  )}
                </Tooltip>
              </li>
            );
          })}
        </ul>
      </div>
      <SimCoverageLegend />
    </div>
  );
}

export function SimCoverageLegend(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">
        {t('stations.simCoverage.legend')}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {COVERAGE_LABELS.map((label) => {
          const Icon = LABEL_STYLE[label].icon;
          return (
            <li key={label} className="flex items-center gap-1 text-xs text-muted-foreground">
              <Icon
                className={cn('h-3.5 w-3.5', LABEL_STYLE[label].iconClass)}
                aria-hidden="true"
              />
              {t(LABEL_KEYS[label])}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
