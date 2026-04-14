// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

interface EnergyDataPoint {
  timestamp: string;
  energyWh: number;
}

interface EnergyChartProps {
  data: EnergyDataPoint[];
  height?: number;
}

export function EnergyChart({ data, height = 160 }: EnergyChartProps): React.JSX.Element {
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

  const energyKwh = data.map((d) => d.energyWh / 1000);
  const maxEnergy = Math.max(...energyKwh, 0.01);
  const roundedMax = ceilToNice(maxEnergy);

  const times = data.map((d) => new Date(d.timestamp).getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeRange = maxTime - minTime || 1;

  function xPos(timestamp: string): number {
    const t = new Date(timestamp).getTime();
    return paddingLeft + ((t - minTime) / timeRange) * chartWidth;
  }

  function yPos(kwh: number): number {
    return paddingTop + chartHeight - (kwh / roundedMax) * chartHeight;
  }

  const linePath = data
    .map(
      (d, i) =>
        `${i === 0 ? 'M' : 'L'}${String(xPos(d.timestamp))},${String(yPos(d.energyWh / 1000))}`,
    )
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

  function formatEnergy(kwh: number): string {
    if (kwh >= 10) return `${kwh.toFixed(0)} kWh`;
    if (kwh >= 1) return `${kwh.toFixed(1)} kWh`;
    return `${kwh.toFixed(2)} kWh`;
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
            {formatEnergy(tick)}
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
      <path d={areaPath} fill="hsl(var(--success))" opacity="0.1" />
      <path
        d={linePath}
        fill="none"
        stroke="hsl(var(--success))"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {data.length > 0 && (
        <circle
          cx={xPos(lastTimestamp)}
          cy={yPos((data[data.length - 1]?.energyWh ?? 0) / 1000)}
          r="4"
          fill="hsl(var(--success))"
        />
      )}
    </svg>
  );
}

function ceilToNice(value: number): number {
  if (value <= 0.1) return 0.1;
  if (value <= 0.5) return 0.5;
  if (value <= 1) return 1;
  if (value <= 5) return 5;
  if (value <= 10) return 10;
  return Math.ceil(value / 5) * 5;
}
