// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// SAE J1772 (Type 1, IEC 62196-2 standard sheet 2-I), seen looking into the
// socket, oriented as the reference drawing: the round 43.8 mm face (J1772
// sheet A-2) with its key tab on the rim at the bottom, the L1 and N power
// contacts above, PE below the middle and the PP and CP signal contacts
// beside it. Every contact center comes from CONNECTOR_SPECS.type1, the one
// geometry source the 3D handle shares (SAE J1772 OCT2012 sheets A-2 and C-2);
// the sizes are the contact insulators, measured off the Wikimedia Commons
// face drawing "J1772 connector.svg" (CC BY-SA 4.0) scaled to the 43.8 mm
// face. EN 17186:2019 identifies it as an AC connector. Here y points down.
//
// | Contact | x mm   | y mm | d mm | Role   |
// | ------- | ------ | ---- | ---- | ------ |
// | L1      | -7.85  | -6.8 | 13.9 | power  |
// | N       | 7.85   | -6.8 | 13.9 | power  |
// | PE      | 0      | 10.8 | 13.9 | earth  |
// | PP      | -10.65 | 5.6  | 10   | signal |
// | CP      | 10.65  | 5.6  | 10   | signal |
// Outline: circle r 21.9, key tab 8.3 wide, 3.0 below the rim.

import { CONNECTOR_SPECS } from '../layout/site-layout-connectors';
import {
  arcPoints,
  ConnectorFace,
  type ConnectorIconProps,
  type FaceGeometry,
} from './connector-face';
import { specContactMm } from './spec-contacts';

const J1772 = CONNECTOR_SPECS.type1.contacts;
const R = 21.9;
const TAB_HALF = 4.15;
const TAB_BOTTOM = R + 3;
const TAB_ROOT = Math.sqrt(R * R - TAB_HALF * TAB_HALF);
// From the tab's left root over the top round to its right root (y down).
const start = Math.atan2(TAB_ROOT, -TAB_HALF);
const end = Math.atan2(TAB_ROOT, TAB_HALF) + 2 * Math.PI;

export const TYPE1_FACE: FaceGeometry = {
  outline: [...arcPoints(0, 0, R, start, end, 48), [TAB_HALF, TAB_BOTTOM], [-TAB_HALF, TAB_BOTTOM]],
  contacts: [
    { name: 'L1', ...specContactMm(J1772, 0), d: 13.9, role: 'power' },
    { name: 'N', ...specContactMm(J1772, 1), d: 13.9, role: 'power' },
    { name: 'PE', ...specContactMm(J1772, 2), d: 13.9, role: 'earth' },
    { name: 'PP', ...specContactMm(J1772, 3), d: 10, role: 'signal' },
    { name: 'CP', ...specContactMm(J1772, 4), d: 10, role: 'signal' },
  ],
};

export function Type1Icon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="type1" geometry={TYPE1_FACE} />;
}
