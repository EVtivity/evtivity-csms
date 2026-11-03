// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// CCS2 (IEC 62196-3 configuration FF), the connector seen from the front:
// one continuous outline, the flat-topped Type 2 face above with CP, PP and
// PE (the DC connector carries no AC power contacts) flowing through a short
// waist into the DC section about as wide below, with its two large DC
// contacts. Centers and insulator sizes measured off the Wikimedia Commons
// drawing "IEC 62196 Type 2 (M, DC, CCS Combo 2).svg" (CC BY-SA 4.0) scaled
// to the 63 mm Type 2 face. EN 17186:2019 identifies it as a DC connector.
//
// | Contact | x mm  | y mm  | d mm | Role   |
// | ------- | ----- | ----- | ---- | ------ |
// | CP      | -8.3  | -10.5 | 10   | signal |
// | PP      | 8.3   | -10.5 | 10   | signal |
// | PE      | 0     | 0     | 13.4 | earth  |
// | DC+     | -15.1 | 56.6  | 26   | power  |
// | DC-     | 15.1  | 56.6  | 26   | power  |
// Outline: AC circle r 31.5 cut flat at y -20.1, waist 24 wide, DC section
// 65.5 by 35 centered at y 56.6.

import {
  arcPoints,
  ConnectorFace,
  type ConnectorIconProps,
  type FaceGeometry,
} from './connector-face';

const R = 31.5;
const FLAT_Y = -20.1;
const FLAT_HALF = Math.sqrt(R * R - FLAT_Y * FLAT_Y);
const WAIST = 12;
const WAIST_Y = Math.sqrt(R * R - WAIST * WAIST);
const DC_Y = 56.6;
const DC_R = 17.5;
const DC_HALF = 65.5 / 2 - DC_R;

export const CCS2_FACE: FaceGeometry = {
  outline: [
    ...arcPoints(0, 0, R, Math.atan2(WAIST_Y, WAIST), Math.atan2(FLAT_Y, FLAT_HALF), 16),
    ...arcPoints(
      0,
      0,
      R,
      Math.atan2(FLAT_Y, -FLAT_HALF),
      Math.atan2(WAIST_Y, -WAIST) - 2 * Math.PI,
      16,
    ),
    [-WAIST, DC_Y - DC_R],
    ...arcPoints(-DC_HALF, DC_Y, DC_R, 1.5 * Math.PI, 0.5 * Math.PI, 16),
    ...arcPoints(DC_HALF, DC_Y, DC_R, 0.5 * Math.PI, -0.5 * Math.PI, 16),
    [WAIST, DC_Y - DC_R],
  ],
  contacts: [
    { name: 'CP', x: -8.3, y: -10.5, d: 10, role: 'signal' },
    { name: 'PP', x: 8.3, y: -10.5, d: 10, role: 'signal' },
    { name: 'PE', x: 0, y: 0, d: 13.4, role: 'earth' },
    { name: 'DC+', x: -15.1, y: 56.6, d: 26, role: 'power' },
    { name: 'DC-', x: 15.1, y: 56.6, d: 26, role: 'power' },
  ],
};

export function Ccs2Icon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="ccs2" geometry={CCS2_FACE} />;
}
