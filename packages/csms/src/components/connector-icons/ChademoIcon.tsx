// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// CHAdeMO (IEC 62196-3 configuration AA, the CHAdeMO Association connector
// documents behind CONNECTOR_SPECS.chademo), a simplified pictogram of the
// face seen from the front (owner decision 2026-11-03): the large round
// 82 mm shell, the two large DC contacts side by side low in the face and a
// small arc of signal contacts above them, so nothing overlaps. The DC
// centers 31 mm apart and the shell size as measured off the Wikimedia
// Commons drawing "CHAdeMO connector.svg" (CC BY-SA 4.0) scaled to the 70 mm
// face; the insert ring and the two signal islands of the drawing are left
// out. EN 17186:2019 identifies it as a DC connector.
//
// | Contact | x mm  | y mm  | d mm | Role   |
// | ------- | ----- | ----- | ---- | ------ |
// | DC+     | -15.6 | 8.0   | 30.0 | power  |
// | DC-     | 15.6  | 8.0   | 30.0 | power  |
// | FG      | -20.8 | -12.0 | 5.0  | signal |
// | SS1     | -12.0 | -20.8 | 5.0  | signal |
// | DCP     | 0.0   | -24.0 | 5.0  | signal |
// | PP      | 12.0  | -20.8 | 5.0  | signal |
// | SS2     | 20.8  | -12.0 | 5.0  | signal |
// Outline: shell circle r 41.

import {
  arcPoints,
  ConnectorFace,
  type ConnectorIconProps,
  type FaceGeometry,
} from './connector-face';

export const CHADEMO_FACE: FaceGeometry = {
  outline: arcPoints(0, 0, 41, 0, 2 * Math.PI, 64),
  contacts: [
    { name: 'DC+', x: -15.6, y: 8.0, d: 30.0, role: 'power' },
    { name: 'DC-', x: 15.6, y: 8.0, d: 30.0, role: 'power' },
    { name: 'FG', x: -20.8, y: -12.0, d: 5.0, role: 'signal' },
    { name: 'SS1', x: -12.0, y: -20.8, d: 5.0, role: 'signal' },
    { name: 'DCP', x: 0.0, y: -24.0, d: 5.0, role: 'signal' },
    { name: 'PP', x: 12.0, y: -20.8, d: 5.0, role: 'signal' },
    { name: 'SS2', x: 20.8, y: -12.0, d: 5.0, role: 'signal' },
  ],
};

export function ChademoIcon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="chademo" geometry={CHADEMO_FACE} />;
}
