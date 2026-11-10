// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/formatting';

/** Ring geometry of the empty donut, close to the ApexCharts donut in a 300 px chart. */
const RING_SIZE = 200;
const RING_STROKE = 32;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;

/**
 * A donut chart with no data: an empty neutral ring with a total of 0 in the
 * middle and the empty text below, for the `ChartBody` `emptyChart`.
 */
export function EmptyDonut({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div data-testid="empty-donut" className="flex flex-col items-center gap-3">
      <div className="relative" style={{ width: RING_SIZE, height: RING_SIZE }}>
        <svg
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${String(RING_SIZE)} ${String(RING_SIZE)}`}
          aria-hidden="true"
        >
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
            className="stroke-muted"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xs text-muted-foreground">{t('charts.total')}</span>
          <span className="text-2xl font-semibold">{formatNumber(0, 0)}</span>
        </div>
      </div>
      <p data-testid="empty-state" className="text-center text-sm text-muted-foreground">
        {text}
      </p>
    </div>
  );
}
