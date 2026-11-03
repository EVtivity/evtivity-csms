// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The material slots shared by the power equipment models of the 3D site
// layout: the split system satellite, its power cabinet and the panelboards.
// A kit merges each model's parts per slot; the scene passes one material
// per slot to `build`.

import type { ModelKit } from './site-layout-model-kit';

export const POWER_SLOTS = [
  /** The painted enclosure body. */
  'body',
  /** Doors and service panels. */
  'door',
  /** A front plate the scene tints (the satellite's front, the station accent). */
  'plate',
  /** Dark parts: plinths, bezels, louvers, gaskets, handles, end caps. */
  'trim',
  /** Bare or galvanized metal: hinges, latches, bolts, strut channel, base plates. */
  'metal',
  'concrete',
  'glass',
  /** The status light (emissive in the scene). */
  'light',
  /** The nameplate and the logo area (a light plate). */
  'label',
  /** Rigid conduit, hubs and straps. */
  'conduit',
] as const;
export type PowerSlot = (typeof POWER_SLOTS)[number];
export type PowerKit = ModelKit<PowerSlot>;
