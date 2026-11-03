// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// MCS (SAE J3271, IEC 63379, CharIN MCS white paper v1.3 p.11-13, as
// CONNECTOR_SPECS.mcs), the connector seen from the front: a smooth rounded
// body 116 mm wide, wider at the top, with generous fillets (owner decision
// 2026-11-03: no sharp triangle corners), DC+ and DC- large at the top, the
// communication contact pair between them (drawn as one), CP and PP below
// and PE at the bottom. Centers and sizes measured off the Wikimedia Commons
// drawing "Megawatt Charging System Schematic Plug Design.svg" (CC BY-SA
// 4.0) scaled to the 116 mm width. EN 17186:2019 identifies DC connectors in
// a square frame.
//
// | Contact | x mm  | y mm  | d mm | Role   |
// | ------- | ----- | ----- | ---- | ------ |
// | DC+     | -30.7 | -24.9 | 44   | power  |
// | DC-     | 30.7  | -24.9 | 44   | power  |
// | COMM    | 0     | 0.6   | 10   | signal |
// | CP      | -19.1 | 12.8  | 14   | signal |
// | PP      | 19.1  | 12.8  | 14   | signal |
// | PE      | 0     | 32.5  | 25.5 | earth  |
// Outline: the hull of the top round corners (r 24 at x 34, y -30.5) and
// the round bottom (r 32 at y 22.5): 116 wide, 109 high.

import {
  ConnectorFace,
  hullOfCircles,
  type ConnectorIconProps,
  type FaceGeometry,
} from './connector-face';

export const MCS_FACE: FaceGeometry = {
  outline: hullOfCircles([
    { x: -34, y: -30.5, r: 24 },
    { x: 34, y: -30.5, r: 24 },
    { x: 0, y: 22.5, r: 32 },
  ]),
  contacts: [
    { name: 'DC+', x: -30.7, y: -24.9, d: 44, role: 'power' },
    { name: 'DC-', x: 30.7, y: -24.9, d: 44, role: 'power' },
    { name: 'COMM', x: 0, y: 0.6, d: 10, role: 'signal' },
    { name: 'CP', x: -19.1, y: 12.8, d: 14, role: 'signal' },
    { name: 'PP', x: 19.1, y: 12.8, d: 14, role: 'signal' },
    { name: 'PE', x: 0, y: 32.5, d: 25.5, role: 'earth' },
  ],
};

export function McsIcon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="mcs" geometry={MCS_FACE} />;
}
