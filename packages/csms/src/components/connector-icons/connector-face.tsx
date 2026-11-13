// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The React frame of the connector face pictograms; the geometry and the
// drawing rules are in @evtivity/lib/connector-faces.

import {
  faceDrawing,
  r3,
  type ConnectorIconSize,
  type FaceGeometry,
} from '@evtivity/lib/connector-faces';

export interface ConnectorIconProps {
  /** The accessible name and title (for example "EVSE 1, CCS1, Charging"). */
  label: string;
  /** The line color (a connector status color, or currentColor). */
  color?: string | undefined;
  /** The rendered size in px (the detail and line width follow it). */
  size?: ConnectorIconSize | undefined;
  className?: string | undefined;
}

export function ConnectorFace({
  label,
  color = 'currentColor',
  size = 20,
  className,
  kind,
  geometry,
}: ConnectorIconProps & {
  /** The connector kind (data-connector, for tests and styling). */
  kind: string;
  geometry: FaceGeometry;
}): React.JSX.Element {
  const d = faceDrawing(geometry, size);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      data-testid="connector-type-icon"
      data-connector={kind}
    >
      <title>{label}</title>
      <path
        d={d.outline}
        fill="none"
        stroke={color}
        strokeWidth={d.stroke}
        strokeLinejoin="round"
      />
      {d.contacts.map((c) =>
        c.ring ? (
          <circle
            key={c.name}
            data-contact={c.name}
            cx={r3(c.cx)}
            cy={r3(c.cy)}
            r={r3(c.r)}
            fill="none"
            stroke={color}
            strokeWidth={r3(c.stroke)}
          />
        ) : (
          <circle
            key={c.name}
            data-contact={c.name}
            cx={r3(c.cx)}
            cy={r3(c.cy)}
            r={r3(c.r)}
            fill={color}
          />
        ),
      )}
    </svg>
  );
}
