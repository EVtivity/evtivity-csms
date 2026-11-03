// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// CCS1 (IEC 62196-3 configuration EE, SAE J1772 sheets C-2 and C-3), the
// vehicle inlet seen from the front: one continuous outline, the 43.8 mm
// J1772 face above flowing through a short waist into the DC section about
// as wide below. Every contact center comes from CONNECTOR_SPECS, the one
// geometry source the 3D handles share (SAE J1772 OCT2012 sheets A-2 and C-2:
// L1 and N 15.7 mm apart 6.8 mm above the center, CP and PP 21.3 mm apart
// 5.6 mm below, PE 10.8 mm below, the DC pins 26 mm apart 42 mm below). The
// insulator sizes are measured off the Wikimedia Commons drawing
// "J1772 (CCS1).svg" (CC BY-SA 4.0) scaled to the 43.8 mm face. EN 17186:2019
// identifies it as a DC connector. Here y points down.
//
// | Contact | x mm   | y mm | d mm | Role   |
// | ------- | ------ | ---- | ---- | ------ |
// | L1      | -7.85  | -6.8 | 11   | power  |
// | N       | 7.85   | -6.8 | 11   | power  |
// | PE      | 0      | 10.8 | 11   | earth  |
// | PP      | -10.65 | 5.6  | 9    | signal |
// | CP      | 10.65  | 5.6  | 9    | signal |
// | DC+     | -13    | 42   | 15.4 | power  |
// | DC-     | 13     | 42   | 15.4 | power  |
// Outline: AC circle r 21.9, waist 20 wide, DC section 51 by 25 centered on the DC pins.

import { CONNECTOR_SPECS } from '../layout/site-layout-connectors';
import {
  arcPoints,
  ConnectorFace,
  type ConnectorIconProps,
  type FaceGeometry,
} from './connector-face';
import { specContactMm } from './spec-contacts';

const R = 21.9;
const WAIST = 10;
const WAIST_Y = Math.sqrt(R * R - WAIST * WAIST);
const AC = CONNECTOR_SPECS.type1.contacts;
const CCS = CONNECTOR_SPECS.ccs1.contacts;
const L1 = specContactMm(AC, 0);
const N = specContactMm(AC, 1);
const PE = specContactMm(CCS, 0);
const PP = specContactMm(CCS, 1);
const CP = specContactMm(CCS, 2);
const DC_PLUS = specContactMm(CCS, 3);
const DC_MINUS = specContactMm(CCS, 4);
const DC_Y = DC_PLUS.y;
const DC_R = 12.5;
const DC_HALF = DC_MINUS.x;

export const CCS1_FACE: FaceGeometry = {
  outline: [
    ...arcPoints(
      0,
      0,
      R,
      Math.atan2(WAIST_Y, WAIST),
      Math.atan2(WAIST_Y, -WAIST) - 2 * Math.PI,
      48,
    ),
    [-WAIST, DC_Y - DC_R],
    ...arcPoints(-DC_HALF, DC_Y, DC_R, 1.5 * Math.PI, 0.5 * Math.PI, 16),
    ...arcPoints(DC_HALF, DC_Y, DC_R, 0.5 * Math.PI, -0.5 * Math.PI, 16),
    [WAIST, DC_Y - DC_R],
  ],
  contacts: [
    { name: 'L1', ...L1, d: 11, role: 'power' },
    { name: 'N', ...N, d: 11, role: 'power' },
    { name: 'PE', ...PE, d: 11, role: 'earth' },
    { name: 'PP', ...PP, d: 9, role: 'signal' },
    { name: 'CP', ...CP, d: 9, role: 'signal' },
    { name: 'DC+', ...DC_PLUS, d: 15.4, role: 'power' },
    { name: 'DC-', ...DC_MINUS, d: 15.4, role: 'power' },
  ],
};

export function Ccs1Icon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="ccs1" geometry={CCS1_FACE} />;
}
