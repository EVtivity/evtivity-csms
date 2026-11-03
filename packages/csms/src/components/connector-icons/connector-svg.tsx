// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The frame of the Stations list connector icons: the icon's own view box at
// its own size, or scaled to `size` px high. With a `label` the icon is an
// image with that accessible name and title; without one (the list, where a
// tooltip names it) it is plain drawing, as before.

export interface ConnectorIconProps {
  /** The line and pin color. */
  color?: string | undefined;
  /** The accessible name and title (for example "EVSE 1, CCS1, Charging"). */
  label?: string | undefined;
  /** The rendered height in px; absent keeps the icon's own size. */
  size?: number | undefined;
  className?: string | undefined;
}

export function ConnectorSvg({
  kind,
  width,
  height,
  viewBox,
  label,
  size,
  className = 'shrink-0',
  children,
}: Omit<ConnectorIconProps, 'color'> & {
  kind: string;
  width: number;
  height: number;
  viewBox: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const h = size ?? height;
  const w = (width * h) / height;
  return (
    <svg
      width={w}
      height={h}
      viewBox={viewBox}
      className={className}
      data-testid="connector-type-icon"
      data-connector={kind}
      {...(label != null ? { role: 'img', 'aria-label': label } : {})}
    >
      {label != null && <title>{label}</title>}
      {children}
    </svg>
  );
}
