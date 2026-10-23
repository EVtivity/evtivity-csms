// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { CalendarRange } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { RefreshButton } from '@/components/refresh-button';
import { formatNumber } from '@/lib/formatting';
import { DisabledWithReason } from './DisabledWithReason';
import { SimRangeDialog } from './SimRangeDialog';
import {
  DAY_MS,
  providerName,
  refreshResultLines,
  simErrorMessage,
  zonedDate,
} from './sim-connectivity';
import type { SimRefreshController } from './use-sim-refresh';

interface SimRefreshCardProps {
  controller: SimRefreshController;
  title: string;
  /** What a Refresh reads, under the controls. */
  hint: string;
  /** Set while a Refresh is refused (an inactive SIM): the controls are disabled with this reason. */
  disabledReason?: string | null;
}

/**
 * The Refresh card of a SIM source: the period select, Refresh, Custom Range,
 * the period limits, the hint and the result lines of the last Refresh.
 */
export function SimRefreshCard({
  controller,
  title,
  hint,
  disabledReason,
}: SimRefreshCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { info, options, days, refresh, result, dialog, today } = controller;
  const blockedByHistory = options.some((o) => o.blockedBy === 'history');
  const blockedByRetention = options.some((o) => o.blockedBy === 'retention');
  const blocked = disabledReason != null;
  const refreshButton = (
    <RefreshButton
      label={t('stations.sim.refresh')}
      isPending={refresh.isPending}
      disabled={blocked}
      onClick={() => {
        controller.refreshWithDays();
      }}
    />
  );
  const rangeButton = (
    <Button
      variant="outline"
      className="gap-1.5"
      disabled={blocked || refresh.isPending}
      onClick={() => {
        controller.openDialog(
          zonedDate(new Date(Date.now() - (days - 1) * DAY_MS), info.coverageTimeZone),
          today,
        );
      }}
    >
      <CalendarRange className="h-4 w-4" />
      {t('stations.sim.customRange')}
    </Button>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-2">
            <Label htmlFor="sim-refresh-period">{t('stations.sim.period')}</Label>
            <Select
              id="sim-refresh-period"
              className="w-auto"
              value={String(days)}
              disabled={blocked || refresh.isPending}
              onChange={(e) => {
                controller.setDays(Number(e.target.value));
              }}
            >
              {options.map((o) => (
                <option
                  key={o.days}
                  value={String(o.days)}
                  disabled={o.blockedBy != null}
                  title={
                    o.blockedBy === 'history'
                      ? t('stations.sim.periodBeyondHistory', {
                          provider: providerName(info.provider),
                          days: info.historyDays ?? 0,
                        })
                      : o.blockedBy === 'retention'
                        ? t('stations.sim.periodBeyondRetention', { days: info.retentionDays })
                        : undefined
                  }
                >
                  {t('stations.sim.lastDays', { count: o.days })}
                </option>
              ))}
            </Select>
          </div>
          {disabledReason != null ? (
            <>
              <DisabledWithReason reason={disabledReason} testId="sim-refresh-disabled">
                {refreshButton}
              </DisabledWithReason>
              <DisabledWithReason reason={disabledReason}>{rangeButton}</DisabledWithReason>
            </>
          ) : (
            <>
              {refreshButton}
              {rangeButton}
            </>
          )}
        </div>
        {(blockedByHistory || blockedByRetention) && (
          <div className="space-y-1 text-xs text-muted-foreground" data-testid="sim-period-limits">
            {blockedByHistory && (
              <p>
                {t('stations.sim.periodBlockedHistory', {
                  provider: providerName(info.provider),
                  days: info.historyDays ?? 0,
                })}
              </p>
            )}
            {blockedByRetention && (
              <p>{t('stations.sim.periodBlockedRetention', { days: info.retentionDays })}</p>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">{hint}</p>
        {result != null && (
          <ul className="space-y-1 text-sm" data-testid="sim-refresh-result">
            {refreshResultLines(result, controller.source.kind).map((line) => {
              const counts = Object.fromEntries(
                Object.entries(line.counts ?? {}).map(([name, c]) => [
                  name,
                  t(c.key as 'stations.sim.result.sessionCount', {
                    count: c.count,
                    formatted: formatNumber(c.count, 0),
                  }),
                ]),
              );
              return (
                <li key={line.key}>
                  {t(line.key as 'stations.sim.refresh', { ...line.values, ...counts })}
                </li>
              );
            })}
          </ul>
        )}
        {refresh.isError && dialog == null && (
          <p className="text-sm text-destructive">{simErrorMessage(refresh.error, t)}</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The Custom Range dialog of a SIM source. The Refresh card and the timeline
 * Fetch rows open it, so it sits beside both (they can be on different tabs).
 */
export function SimRefreshRangeDialog({
  controller,
}: {
  controller: SimRefreshController;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { info, refresh, dialog, today } = controller;
  return (
    <SimRangeDialog
      open={dialog != null}
      onOpenChange={(open) => {
        if (!open) controller.closeDialog();
      }}
      source={controller.source}
      timezone={info.coverageTimeZone}
      windowDays={controller.windowDays}
      initialFrom={dialog?.from ?? today}
      initialTo={dialog?.to ?? today}
      isPending={refresh.isPending}
      errorText={refresh.isError ? simErrorMessage(refresh.error, t) : null}
      onFetch={({ from, to }) => {
        refresh.mutate({ from: from.toISOString(), to: to.toISOString() });
      }}
    />
  );
}
