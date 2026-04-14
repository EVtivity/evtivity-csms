// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

interface PowerDataPoint {
  timestamp: string;
  powerW: number;
}

interface PowerChartProps {
  data: PowerDataPoint[];
  height?: number;
}

export function PowerChart({ data, height = 160 }: PowerChartProps): React.JSX.Element {
  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height }}
      >
        Collecting data...
      </div>
    );
  }

  const paddingLeft = 44;
  const paddingRight = 8;
  const paddingTop = 8;
  const paddingBottom = 24;
  const width = 400;

  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  const maxPower = Math.max(...data.map((d) => d.powerW), 1);
  const roundedMax = Math.ceil(maxPower / 1000) * 1000;

  const times = data.map((d) => new Date(d.timestamp).getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeRange = maxTime - minTime || 1;

  function xPos(timestamp: string): number {
    const t = new Date(timestamp).getTime();
    return paddingLeft + ((t - minTime) / timeRange) * chartWidth;
  }

  function yPos(power: number): number {
    return paddingTop + chartHeight - (power / roundedMax) * chartHeight;
  }

  const linePath = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${String(xPos(d.timestamp))},${String(yPos(d.powerW))}`)
    .join(' ');

  const firstTimestamp = data[0]?.timestamp ?? '';
  const lastTimestamp = data[data.length - 1]?.timestamp ?? '';
  const areaPath = `${linePath} L${String(xPos(lastTimestamp))},${String(paddingTop + chartHeight)} L${String(xPos(firstTimestamp))},${String(paddingTop + chartHeight)} Z`;

  const yTicks = [0, roundedMax / 2, roundedMax];
  const totalMinutes = (maxTime - minTime) / 60000;
  const tickCount = totalMinutes > 30 ? 4 : totalMinutes > 10 ? 3 : 2;
  const xTicks: number[] = [];
  for (let i = 0; i < tickCount; i++) {
    xTicks.push(minTime + (timeRange / (tickCount - 1)) * i);
  }

  function formatTime(ms: number): string {
    const d = new Date(ms);
    const h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${String(h12)}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  function formatPower(w: number): string {
    if (w >= 1000) return `${(w / 1000).toFixed(0)}kW`;
    return `${w.toFixed(0)}W`;
  }

  return (
    <svg viewBox={`0 0 ${String(width)} ${String(height)}`} className="w-full" style={{ height }}>
      {yTicks.map((tick) => (
        <g key={tick}>
          <line
            x1={paddingLeft}
            y1={yPos(tick)}
            x2={width - paddingRight}
            y2={yPos(tick)}
            stroke="hsl(var(--border))"
            strokeWidth="1"
            strokeDasharray="4 2"
          />
          <text
            x={paddingLeft - 4}
            y={yPos(tick) + 4}
            textAnchor="end"
            className="fill-muted-foreground"
            fontSize="10"
          >
            {formatPower(tick)}
          </text>
        </g>
      ))}
      {xTicks.map((tick) => (
        <text
          key={tick}
          x={paddingLeft + ((tick - minTime) / timeRange) * chartWidth}
          y={height - 4}
          textAnchor="middle"
          className="fill-muted-foreground"
          fontSize="10"
        >
          {formatTime(tick)}
        </text>
      ))}
      <path d={areaPath} fill="hsl(var(--primary))" opacity="0.1" />
      <path
        d={linePath}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {data.length > 0 && (
        <circle
          cx={xPos(lastTimestamp)}
          cy={yPos(data[data.length - 1]?.powerW ?? 0)}
          r="4"
          fill="hsl(var(--primary))"
        />
      )}
    </svg>
  );
}
