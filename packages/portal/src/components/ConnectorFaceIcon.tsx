// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  CONNECTOR_FACES,
  faceDrawing,
  knownConnectorKind,
  r3,
  type ConnectorIconSize,
} from '@evtivity/lib/connector-faces';

// A connector's face pictogram, from the same geometry as the CSMS 2D charger
// cards and the plug-in animation (@evtivity/lib/connector-faces). An unknown
// type shows a neutral round face. Drawn in currentColor, so the caller picks
// the theme token. Decorative: the type label stands next to it.

export function ConnectorFaceIcon({
  type,
  size = 16,
  className,
}: {
  /** The connector type as the station reports it (OCPP or CSMS spelling). */
  type: string | null;
  size?: ConnectorIconSize;
  className?: string;
}): React.JSX.Element {
  const kind = knownConnectorKind(type);
  const common = {
    'aria-hidden': true,
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    className,
    'data-testid': 'connector-face-icon',
  } as const;
  if (kind == null) {
    return (
      <svg {...common} data-connector="neutral">
        <circle cx={8} cy={8} r={6.5} fill="none" stroke="currentColor" strokeWidth={1.4} />
      </svg>
    );
  }
  const d = faceDrawing(CONNECTOR_FACES[kind], size);
  return (
    <svg {...common} data-connector={kind}>
      <path
        d={d.outline}
        fill="none"
        stroke="currentColor"
        strokeWidth={d.stroke}
        strokeLinejoin="round"
      />
      {d.contacts.map((c) =>
        c.ring ? (
          <circle
            key={c.name}
            cx={r3(c.cx)}
            cy={r3(c.cy)}
            r={r3(c.r)}
            fill="none"
            stroke="currentColor"
            strokeWidth={r3(c.stroke)}
          />
        ) : (
          <circle key={c.name} cx={r3(c.cx)} cy={r3(c.cy)} r={r3(c.r)} fill="currentColor" />
        ),
      )}
    </svg>
  );
}
