// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The day replay controls of the site Layout tab (not the dashboard card): a
// day picker (today and the 90 days before), a timeline slider over the day,
// play and pause, the speed, and Back to Live. The replayed day is read once
// from GET /v1/sites/:id/layout/replay; the views draw the chosen moment
// (site-layout-replay.ts, replayFrame).

import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { LoadingLogo } from '@/components/loading-logo';
import { localDate, REPLAY_SPEEDS, type ReplaySpeed } from './site-layout-replay';

/** How many days back a day can be replayed. */
export const REPLAY_MAX_DAYS = 90;

function minuteLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface LayoutReplayBarProps {
  date: string;
  onDateChange: (date: string) => void;
  /** Minutes into the day (0 to 1439). */
  minute: number;
  onMinuteChange: (minute: number) => void;
  /** The last minute that can be shown (now on today). */
  lastMinute: number;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  speed: ReplaySpeed;
  onSpeedChange: (speed: ReplaySpeed) => void;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onExit: () => void;
}

export function LayoutReplayBar({
  date,
  onDateChange,
  minute,
  onMinuteChange,
  lastMinute,
  playing,
  onPlayingChange,
  speed,
  onSpeedChange,
  isLoading,
  isError,
  onRetry,
  onExit,
}: LayoutReplayBarProps): React.JSX.Element {
  const { t } = useTranslation();
  const sliderId = useId();
  const dateId = useId();
  const today = localDate(Date.now());
  const earliest = localDate(Date.now() - REPLAY_MAX_DAYS * 86_400_000);

  // Playing moves `speed` replayed minutes every real second, ten steps a second.
  const minuteRef = useRef(minute);
  minuteRef.current = minute;
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const next = minuteRef.current + speed / 10;
      if (next >= lastMinute) {
        onMinuteChange(lastMinute);
        onPlayingChange(false);
        return;
      }
      onMinuteChange(next);
    }, 100);
    return () => {
      window.clearInterval(id);
    };
  }, [playing, speed, lastMinute, onMinuteChange, onPlayingChange]);

  const shown = Math.floor(minute);
  return (
    <div
      className="mb-3 grid gap-2 rounded-lg border bg-card p-3 text-sm sm:grid-cols-[auto_1fr_auto] sm:items-center"
      data-testid="site-layout-replay"
      role="group"
      aria-label={t('sites.layoutView.replayLabel')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={dateId} className="text-muted-foreground">
          {t('sites.layoutView.replayDay')}
        </label>
        <Input
          id={dateId}
          type="date"
          className="w-auto"
          value={date}
          min={earliest}
          max={today}
          onChange={(e) => {
            const value = e.target.value;
            if (value !== '' && value >= earliest && value <= today) onDateChange(value);
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={
            playing ? t('sites.layoutView.replayPause') : t('sites.layoutView.replayPlay')
          }
          disabled={isLoading || isError}
          onClick={() => {
            if (!playing && shown >= lastMinute) onMinuteChange(0);
            onPlayingChange(!playing);
          }}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <label htmlFor={sliderId} className="sr-only">
          {t('sites.layoutView.replayTime')}
        </label>
        <Input
          id={sliderId}
          type="range"
          min={0}
          max={1439}
          step={1}
          value={shown}
          disabled={isLoading || isError}
          aria-valuetext={minuteLabel(shown)}
          data-testid="site-layout-replay-slider"
          className="w-full cursor-pointer border-0 bg-transparent px-0 accent-primary focus-visible:ring-offset-0"
          onChange={(e) => {
            onPlayingChange(false);
            onMinuteChange(Math.min(lastMinute, Number(e.target.value)));
          }}
        />
        <span className="w-12 shrink-0 text-right font-semibold tabular-nums" aria-live="off">
          {minuteLabel(shown)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="w-auto"
          aria-label={t('sites.layoutView.replaySpeed')}
          value={String(speed)}
          onChange={(e) => {
            const value = Number(e.target.value);
            const next = REPLAY_SPEEDS.find((s) => s === value);
            if (next != null) onSpeedChange(next);
          }}
        >
          {REPLAY_SPEEDS.map((s) => (
            <option key={s} value={s}>
              {t('sites.layoutView.replaySpeedValue', { value: s })}
            </option>
          ))}
        </Select>
        <Button type="button" variant="outline" onClick={onExit}>
          <Radio className="h-4 w-4" />
          {t('sites.layoutView.replayBackToLive')}
        </Button>
      </div>
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-3">
          <LoadingLogo size="inline" />
        </div>
      )}
      {isError && (
        <div className="flex items-center gap-2 text-xs text-destructive sm:col-span-3">
          {t('common.loadError')}
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </div>
      )}
    </div>
  );
}
