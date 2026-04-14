// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  strokeColor?: string;
  fillColor?: string;
}

export function Sparkline({
  data,
  width = 120,
  height = 32,
  strokeColor = 'hsl(var(--primary))',
  fillColor = 'hsl(var(--primary) / 0.1)',
}: SparklineProps): React.JSX.Element | null {
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const padding = 2;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (width - padding * 2) + padding;
    const y = height - padding - ((v - min) / range) * (height - padding * 2);
    return `${String(x)},${String(y)}`;
  });

  const polylinePoints = points.join(' ');
  const fillPoints = `${String(padding)},${String(height - padding)} ${polylinePoints} ${String(width - padding)},${String(height - padding)}`;

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="none"
      className="w-full overflow-visible"
      style={{ height }}
    >
      <polygon points={fillPoints} fill={fillColor} />
      <polyline
        points={polylinePoints}
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
