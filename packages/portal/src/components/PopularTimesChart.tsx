// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/auth';
import { CHART_COLORS, getGridColor } from '@/lib/chart-theme';
import { Users } from 'lucide-react';

export interface PopularTimesData {
  dow: number;
  hour: number;
  avgSessions: number;
}

interface PopularTimesChartProps {
  data: PopularTimesData[];
  weeks?: number;
}

const DOW_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function formatHour(hour: number): string {
  if (hour === 0) return '12a';
  if (hour < 12) return `${String(hour)}a`;
  if (hour === 12) return '12p';
  return `${String(hour - 12)}p`;
}

function getBusynessKey(ratio: number): string {
  if (ratio <= 0.25) return 'charts.usuallyNotBusy';
  if (ratio <= 0.5) return 'charts.usuallyALittleBusy';
  if (ratio <= 0.75) return 'charts.usuallyBusy';
  return 'charts.usuallyVeryBusy';
}

export function PopularTimesChart({ data, weeks = 4 }: PopularTimesChartProps): React.JSX.Element {
  const { t } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';
  const today = new Date().getDay();
  const [selectedDow, setSelectedDow] = useState(today);
  const currentHour = new Date().getHours();

  const dayData = HOURS.map((hour) => {
    const entry = data.find((d) => d.dow === selectedDow && d.hour === hour);
    return entry?.avgSessions ?? 0;
  });

  const maxAcrossAllDays = Math.max(...data.map((d) => d.avgSessions), 1);
  const maxForDay = Math.max(...dayData, 1);
  const currentHourValue = selectedDow === today ? (dayData[currentHour] ?? 0) : null;
  const busynessRatio = currentHourValue != null ? currentHourValue / maxAcrossAllDays : null;

  const barColors = dayData.map((_, i) =>
    selectedDow === today && i === currentHour ? CHART_COLORS.primary : `${CHART_COLORS.primary}99`,
  );

  const options = useMemo<ApexOptions>(
    () => ({
      chart: {
        type: 'bar',
        toolbar: { show: false },
        zoom: { enabled: false },
        fontFamily: 'inherit',
        background: 'transparent',
        animations: { enabled: true, speed: 300 },
      },
      theme: { mode: isDark ? 'dark' : 'light' },
      grid: {
        borderColor: getGridColor(isDark),
        yaxis: { lines: { show: true } },
        xaxis: { lines: { show: false } },
      },
      plotOptions: {
        bar: {
          borderRadius: 4,
          borderRadiusApplication: 'end',
          columnWidth: '70%',
          distributed: true,
        },
      },
      legend: { show: false },
      dataLabels: { enabled: false },
      xaxis: {
        categories: HOURS.map(formatHour),
        labels: {
          style: { fontSize: '11px' },
          rotate: 0,
          hideOverlappingLabels: true,
        },
        axisBorder: { show: true },
        axisTicks: { show: false },
      },
      yaxis: {
        max: Math.ceil(maxForDay * 1.1) || 1,
        labels: {
          formatter: (val: number) => String(Math.round(val)),
        },
      },
      tooltip: {
        y: {
          formatter: (val: number) => `${String(val)} ${t('charts.avgSessions')}`,
        },
      },
      colors: barColors,
      responsive: [
        {
          breakpoint: 768,
          options: {
            chart: { height: 220 },
            xaxis: {
              labels: {
                show: true,
                rotate: 0,
                hideOverlappingLabels: true,
              },
            },
          },
        },
      ],
    }),
    [isDark, barColors, maxForDay, t],
  );

  const series = useMemo(() => [{ name: t('charts.avgSessions'), data: dayData }], [t, dayData]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {t('charts.popularTimesInfo', { weeks: String(weeks) })}
      </div>
      <div className="flex gap-1">
        {DOW_KEYS.map((key, i) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setSelectedDow(i);
            }}
            className={`px-2 py-1 text-xs font-medium rounded-md transition-colors uppercase ${
              selectedDow === i
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            {t(`charts.${key}`)}
          </button>
        ))}
      </div>
      {busynessRatio != null && (
        <div className="flex items-center gap-1.5 text-sm">
          <Users className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{formatHour(currentHour).toUpperCase()}:</span>
          <span className="text-muted-foreground">{t(getBusynessKey(busynessRatio) as never)}</span>
        </div>
      )}
      <ReactApexChart options={options} series={series} type="bar" height={280} />
    </div>
  );
}
