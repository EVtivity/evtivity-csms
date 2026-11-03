// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// IEC 62196-2 Type 2 (standard sheet 2-IIa), the face seen from the front:
// the round 70 mm body cut flat across the top, PP and CP in the top row,
// L1, PE and N across the middle, L2 and L3 below (layout as in the
// Phoenix Contact EV-T2G3C drawing behind CONNECTOR_SPECS.type2). Centers
// and insulator sizes measured off the Wikimedia Commons drawing "Stecker-Typ
// 2 Belegung.svg" (public domain) scaled to the 70 mm body. EN 17186:2019
// identifies it as an AC connector.
//
// | Contact | x mm  | y mm  | d mm | Role   |
// | ------- | ----- | ----- | ---- | ------ |
// | PP      | -10.5 | -17.7 | 12.3 | signal |
// | CP      | 10.5  | -17.7 | 12.3 | signal |
// | L1      | -20.2 | -3.9  | 15.3 | power  |
// | PE      | 0     | -3.9  | 15.3 | earth  |
// | N       | 20.2  | -3.9  | 15.3 | power  |
// | L2      | -10.5 | 13.3  | 15.3 | power  |
// | L3      | 10.5  | 13.3  | 15.3 | power  |
// Outline: circle r 35, cut flat at y -29.5.

import {
  arcPoints,
  ConnectorFace,
  type ConnectorIconProps,
  type FaceGeometry,
} from './connector-face';

const R = 35;
const FLAT_Y = -29.5;
const FLAT_HALF = Math.sqrt(R * R - FLAT_Y * FLAT_Y);

export const TYPE2_FACE: FaceGeometry = {
  outline: arcPoints(
    0,
    0,
    R,
    Math.atan2(FLAT_Y, FLAT_HALF),
    Math.atan2(FLAT_Y, -FLAT_HALF) + 2 * Math.PI,
    48,
  ),
  contacts: [
    { name: 'PP', x: -10.5, y: -17.7, d: 12.3, role: 'signal' },
    { name: 'CP', x: 10.5, y: -17.7, d: 12.3, role: 'signal' },
    { name: 'L1', x: -20.2, y: -3.9, d: 15.3, role: 'power' },
    { name: 'PE', x: 0, y: -3.9, d: 15.3, role: 'earth' },
    { name: 'N', x: 20.2, y: -3.9, d: 15.3, role: 'power' },
    { name: 'L2', x: -10.5, y: 13.3, d: 15.3, role: 'power' },
    { name: 'L3', x: 10.5, y: 13.3, d: 15.3, role: 'power' },
  ],
};

export function Type2Icon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="type2" geometry={TYPE2_FACE} />;
}
