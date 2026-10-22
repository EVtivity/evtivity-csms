// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { SIM_RANGE_MAX_DAYS } from '@evtivity/lib/sim-settings';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { SimCoverageStrip } from './SimCoverageStrip';
import {
  customRange,
  DAY_MS,
  stationSimKey,
  zonedDate,
  type SimTimelinePage,
} from './sim-connectivity';

interface SimRangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stationId: string;
  timezone: string;
  /** Days back a range may start (the history window or the retention). */
  windowDays: number;
  /** YYYY-MM-DD dates the dialog opens with. */
  initialFrom: string;
  initialTo: string;
  isPending: boolean;
  /** The failed Fetch, shown in the dialog. */
  errorText: string | null;
  onFetch: (range: { from: Date; to: Date }) => void;
}

/** The Custom Range dialog: two dates, the stored coverage of the days between, and Fetch. */
export function SimRangeDialog(props: SimRangeDialogProps): React.JSX.Element {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} dismissible={!props.isPending}>
      {props.open && <SimRangeForm key={`${props.initialFrom}|${props.initialTo}`} {...props} />}
    </Dialog>
  );
}

function SimRangeForm({
  onOpenChange,
  stationId,
  timezone,
  windowDays,
  initialFrom,
  initialTo,
  isPending,
  errorText: fetchError,
  onFetch,
}: SimRangeDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate, setToDate] = useState(initialTo);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [now] = useState(() => new Date());
  const range = customRange(fromDate, toDate, timezone, windowDays, now);
  const today = zonedDate(now, timezone);
  const earliest = zonedDate(new Date(now.getTime() - windowDays * DAY_MS), timezone);

  // The coverage of the chosen days, from the database only.
  const coverage = useQuery({
    queryKey: [
      ...stationSimKey(stationId),
      'coverage',
      range.from?.toISOString(),
      range.to?.toISOString(),
    ],
    queryFn: () => {
      const params = new URLSearchParams({
        from: range.from?.toISOString() ?? '',
        to: range.to?.toISOString() ?? '',
        limit: '1',
      });
      return api.get<SimTimelinePage>(
        `/v1/stations/${stationId}/sim/timeline?${params.toString()}`,
      );
    },
    enabled: range.error == null,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const errorText =
    range.error === 'required'
      ? t('validation.required')
      : range.error === 'reversed'
        ? t('stations.sim.rangeReversed')
        : range.error === 'tooLong'
          ? t('stations.sim.rangeTooLong', { days: SIM_RANGE_MAX_DAYS })
          : range.error === 'beforeWindow'
            ? t('stations.sim.rangeBeforeWindow', { days: windowDays })
            : range.error === 'inFuture'
              ? t('stations.sim.rangeInFuture')
              : null;

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (range.from == null || range.to == null) return;
    onFetch({ from: range.from, to: range.to });
  }

  return (
    <DialogContent className="max-w-[95vw] md:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('stations.sim.customRangeTitle')}</DialogTitle>
      </DialogHeader>
      <form onSubmit={handleSubmit} noValidate className="grid min-w-0 gap-4">
        <DialogDescription>
          {t('stations.sim.customRangeDescription', {
            days: SIM_RANGE_MAX_DAYS,
            windowDays,
          })}
        </DialogDescription>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="sim-range-from">{t('common.startDate')}</Label>
            <Input
              id="sim-range-from"
              type="date"
              min={earliest}
              max={today}
              value={fromDate}
              className={hasSubmitted && errorText != null ? 'border-destructive' : ''}
              onChange={(e) => {
                setFromDate(e.target.value);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sim-range-to">{t('common.endDate')}</Label>
            <Input
              id="sim-range-to"
              type="date"
              min={earliest}
              max={today}
              value={toDate}
              className={hasSubmitted && errorText != null ? 'border-destructive' : ''}
              onChange={(e) => {
                setToDate(e.target.value);
              }}
            />
          </div>
        </div>
        {hasSubmitted && errorText != null && (
          <p className="text-sm text-destructive">{errorText}</p>
        )}
        {fetchError != null && <p className="text-sm text-destructive">{fetchError}</p>}
        {coverage.data != null && coverage.data.days.length > 0 && (
          <SimCoverageStrip days={coverage.data.days} />
        )}
        <DialogFooter className="flex-col-reverse md:flex-row">
          <Button
            type="button"
            variant="outline"
            className="w-full md:w-auto"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" className="relative w-full gap-1.5 md:w-auto" disabled={isPending}>
            {isPending && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              </div>
            )}
            <span className={`inline-flex items-center gap-1.5 ${isPending ? 'invisible' : ''}`}>
              <Download className="h-4 w-4" />
              {t('stations.sim.fetch')}
            </span>
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
