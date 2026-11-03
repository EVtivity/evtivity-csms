// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// NACS (SAE J3400, Tesla NACS specification TS-0023666 p.12-20, as
// CONNECTOR_SPECS.nacs), the connector seen from the front, as the reference
// drawing: a rounded, bean-like face 41 mm wide with convex curved sides,
// wide at the top where the two large shared AC and DC power sockets sit and
// round at the bottom, the PP, G (protective earth) and CP contacts as three
// small rings in a row near the bottom. Centers and sizes measured off the
// Wikimedia Commons drawing "NACS pinout annotated.svg" (CC BY-SA 4.0) scaled
// to the 41 mm face width.
//
// | Contact | x mm  | y mm | d mm | Role   |
// | ------- | ----- | ---- | ---- | ------ |
// | L1/DC+  | 10.8  | -6.6 | 11.5 | power  |
// | L2/DC-  | -10.8 | -6.6 | 11.5 | power  |
// | G       | 0     | 10.6 | 5.2  | earth  |
// | PP      | -8.6  | 10.6 | 5.0  | signal |
// | CP      | 8.6   | 10.6 | 5.0  | signal |
// Outline: a rounded oval 41 wide and 35.8 high (`beanOutline`), narrowing
// to 80 percent of its width at the bottom.

import {
  ConnectorFace,
  type ConnectorIconProps,
  type FaceGeometry,
  type FacePoint,
} from './connector-face';

const HALF_W = 20.5;
const HALF_H = 17.9;
/** How square the oval is (1 an ellipse; lower rounds the corners less). */
const EXPONENT = 0.8;
/** The share of the width the face keeps at its bottom. */
const BOTTOM_WIDTH = 0.8;

/** A convex rounded oval, wider at the top: every side a curve, no corner. */
function beanOutline(steps = 96): FacePoint[] {
  return Array.from({ length: steps }, (_, i) => {
    const t = (2 * Math.PI * i) / steps;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const y = HALF_H * Math.sign(s) * Math.abs(s) ** EXPONENT;
    // y down: positive y is the bottom, where the face narrows.
    const taper = 1 - (1 - BOTTOM_WIDTH) * ((y / HALF_H + 1) / 2);
    return [HALF_W * taper * Math.sign(c) * Math.abs(c) ** EXPONENT, y] as const;
  });
}

export const NACS_FACE: FaceGeometry = {
  outline: beanOutline(),
  contacts: [
    { name: 'L1/DC+', x: 10.8, y: -6.6, d: 11.5, role: 'power' },
    { name: 'L2/DC-', x: -10.8, y: -6.6, d: 11.5, role: 'power' },
    { name: 'G', x: 0, y: 10.6, d: 5.2, role: 'earth' },
    { name: 'PP', x: -8.6, y: 10.6, d: 5, role: 'signal', ring: true },
    { name: 'CP', x: 8.6, y: 10.6, d: 5, role: 'signal', ring: true },
  ],
};

export function NacsIcon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="nacs" geometry={NACS_FACE} />;
}
