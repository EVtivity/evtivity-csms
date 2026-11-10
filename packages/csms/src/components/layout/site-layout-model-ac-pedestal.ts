// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The AC Level 2 pedestal of the 3D site layout: its body kit. The scene adds
// holsters, handles, cables, readers, the logo and the glow.

import * as THREE from 'three';
import {
  ModelParts,
  boxG,
  cylG,
  frontProfileG,
  planPrismG,
  sideProfileG,
  torusG,
  type Vec3,
} from './site-layout-model-kit';
import { addCableGland } from './site-layout-model-cable-gland';
import {
  arc,
  roundedRect,
  type ChargerKit,
  type ChargerSlot,
} from './site-layout-model-charger-parts';

/**
 * A generic AC Level 2 dual-port pedestal. Its envelope is the median of
 * seven published pedestals, derived (H x W x D, mm): ChargePoint CT4021
 * 1830 x 347 (its drawing's head 289 deep), ChargePoint CPF50 dual 1810 x
 * 444 x 302, Enel X Way JuicePedestal 1880 x 505 x 203, Blink IQ 200
 * rectangle dual 1423 x 345 x 109 and triangle dual 1499 x 318 x 284,
 * SemaConnect Series 6 1422 high, ABB Terra AC pedestal 1400 x 345 x 245, so
 * 1499 high, 346 wide (the six with a width) and 245 deep (the head). The
 * features are typical of the class (for example the CT4021 drawing,
 * https://docs.chargepoint.com/ref-docs/content/pdfs/2-ac/ct4000/ct4000-ds.pdf):
 * a head on a column (233 mm wide), the holsters at 1186 mm (46.7 in), a
 * 5.7 in display (4:3, 116 by 87 mm) on the head front, the cable kept off
 * the ground. No top sign (owner decision 2026-11-02). Derived from the
 * envelope: the head from 0.9 m to the 1.5 m top, the cast foot, the column
 * depth and the lens sizes. The cables loop over the shared J cable hook
 * (site-layout-model-cable-hook.ts) on the column side, which the scene adds.
 */
export const AC_PEDESTAL = {
  post: { widthM: 0.233, depthM: 0.18 },
  head: { widthM: 0.346, depthM: 0.245, bottomM: 0.9, topM: 1.499 },
  /** The head front plane. */
  frontZ: 0.1225,
  screen: { y: 1.36, widthM: 0.116, heightM: 0.087 },
  /** The holster height (CT4021 drawing: 46.7 in). */
  holsterY: 1.186,
  /** The status lens of each port. */
  lensY: 1.15,
  lensR: 0.04,
  /** The x of each port's lens on a dual-port head (a single port: 0); its gland: `acGlandX`. */
  portX: 0.075,
  /** The glands' z under the head: 15 mm in front of the column, inside the head front. */
  glandZ: 0.105,
} as const;

/**
 * Where each port's RFID pad mounts on the head front: under its status lens
 * (a single port in the middle), its center 1.02 m up, inside the 15 to 48
 * in reach range (2010 ADA Standards 308.2, 308.3). Derived.
 */
export function acRfidPads(ports: 1 | 2): Vec3[] {
  const xs = ports === 2 ? [-AC_PEDESTAL.portX, AC_PEDESTAL.portX] : [0];
  // On the face panel (its front 7 mm proud of the head front).
  return xs.map((x) => [x, 1.02, AC_PEDESTAL.frontZ + 0.007] as const);
}

/** The sides of the column with a cable hook: one under each holster (one port: its holster's left). */
export function acHookSides(ports: 1 | 2): Array<-1 | 1> {
  return ports === 2 ? [-1, 1] : [-1];
}

/**
 * The x of the gland of the port whose holster is on `side`: under the head
 * toward its middle (0.035 m out), so each cable hangs from its gland in a U
 * of about its bend out to the hook on its side. Derived.
 */
export function acGlandX(ports: 1 | 2, side: -1 | 1): number {
  return ports === 2 ? side * AC_DUAL_GLAND_X_M : 0;
}

/** How far out from the middle a dual-port head's glands stand. */
export const AC_DUAL_GLAND_X_M = 0.035;

/** The charger slots a cable gland's parts go in. */
const AC_GLAND_SLOTS = { nut: 'metal', dome: 'trim', relief: 'rubber' } as const;

/** The cable gland of the port at `x` under the head, pointing down. */
export function acGland(x: number): { at: Vec3; axis: Vec3 } {
  return { at: [x, AC_PEDESTAL.head.bottomM, AC_PEDESTAL.glandZ], axis: [0, -1, 0] };
}

/** The center of the status lens of each port (EVSE order: left, right; one port in the middle). */
export function acLensAt(ports: 1 | 2): Vec3[] {
  const a = AC_PEDESTAL;
  const xs = ports === 2 ? [-a.portX, a.portX] : [0];
  return xs.map((x) => [x, a.lensY, a.frontZ + 0.006] as const);
}

/** A status lens dome, facing +z, centered on its own origin (the light the scene colors). */
export function acLensGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(
    AC_PEDESTAL.lensR - 0.004,
    16,
    4,
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  g.rotateX(Math.PI / 2);
  g.scale(1, 1, 0.35);
  return g;
}

/**
 * The AC pedestal kit with `ports` (1 or 2) status lenses and cable glands
 * for a cable of `cableDiameterM` (SAE J1772 cable, 12.5 mm, by default).
 */
export function createAcPedestalKit(ports: 1 | 2, cableDiameterM = 0.0125): ChargerKit {
  const a = AC_PEDESTAL;
  const p = new ModelParts<ChargerSlot>();
  // The cast foot and its four anchor bolts with nuts.
  p.add('trim', planPrismG(roundedRect(0.34, 0.3, 0.05), 0.035, 0.008));
  p.add('shell', planPrismG(roundedRect(0.27, 0.23, 0.04), 0.07, 0.01), { at: [0, 0.03, 0] });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      p.add('metal', cylG(0.014, 0.014, 0.012, 6), { at: [sx * 0.135, 0.041, sz * 0.115] });
      p.add('metal', cylG(0.006, 0.006, 0.03, 6), { at: [sx * 0.135, 0.05, sz * 0.115] });
    }
  }
  // The column, a rounded extrusion with an accent strip in a groove down its front.
  const h = a.head;
  const postH = h.bottomM + 0.02 - 0.1;
  p.add('shell', planPrismG(roundedRect(a.post.widthM, a.post.depthM, 0.04), postH), {
    at: [0, 0.1, 0],
  });
  p.add('trim', boxG(0.034, postH - 0.12, 0.006), {
    at: [0, 0.1 + postH / 2, a.post.depthM / 2],
  });
  p.add('accent', boxG(0.018, postH - 0.14, 0.004), {
    at: [0, 0.1 + postH / 2, a.post.depthM / 2 + 0.003],
  });
  // The head: a side silhouette with rounded front edges and the top falling to the back.
  const back = a.frontZ - h.depthM;
  p.add(
    'shell',
    sideProfileG(
      [
        [back, h.bottomM],
        [a.frontZ - 0.03, h.bottomM],
        ...arc(a.frontZ - 0.03, h.bottomM + 0.03, 0.03, -Math.PI / 2, 0, 3).slice(1),
        [a.frontZ, h.topM - 0.06],
        ...arc(a.frontZ - 0.06, h.topM - 0.06, 0.06, 0, Math.PI / 2, 4).slice(1),
        [back + 0.02, h.topM - 0.01],
        [back, h.topM - 0.03],
      ],
      h.widthM,
      0.03,
    ),
  );
  // The face panel (the AC accent) inset in the head front, the screen bezel and glass.
  p.add('accent', frontProfileG(roundedRect(0.29, 0.5, 0.03), 0.008, 0.002), {
    at: [0, (h.bottomM + h.topM) / 2 + 0.005, a.frontZ + 0.003],
  });
  p.add(
    'trim',
    frontProfileG(
      roundedRect(a.screen.widthM + 0.04, a.screen.heightM + 0.04, 0.012),
      0.008,
      0.002,
    ),
    { at: [0, a.screen.y, a.frontZ + 0.008] },
  );
  p.add('glass', boxG(a.screen.widthM, a.screen.heightM, 0.004), {
    at: [0, a.screen.y, a.frontZ + 0.012],
  });
  // The rain hood over the screen.
  p.add(
    'trim',
    sideProfileG(
      [
        [a.frontZ, a.screen.y + 0.065],
        [a.frontZ + 0.045, a.screen.y + 0.05],
        [a.frontZ + 0.045, a.screen.y + 0.06],
        [a.frontZ, a.screen.y + 0.085],
      ],
      a.screen.widthM + 0.07,
      0.003,
    ),
  );
  // A status lens per port in a chrome bezel: one port lit in the station state
  // color (the `light` slot); two ports each in its own EVSE's state, so the
  // scene adds those lenses (`acLensAt`, `acLensGeometry`). The port cable
  // leaves through a gland under the head.
  const xs = acLensAt(ports).map((at) => at[0]);
  for (const [k, x] of xs.entries()) {
    p.add('metal', torusG(a.lensR, 0.007, 6, 20), { at: [x, a.lensY, a.frontZ + 0.01] });
    if (ports === 1) p.add('light', acLensGeometry(), { at: [x, a.lensY, a.frontZ + 0.006] });
    const gland = acGland(ports === 2 ? acGlandX(2, k === 0 ? -1 : 1) : 0);
    addCableGland(p, AC_GLAND_SLOTS, gland.at, gland.axis, cableDiameterM);
  }
  return p.kit();
}
