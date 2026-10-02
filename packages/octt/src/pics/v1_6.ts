// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Pics, PicsItem, PicsPrerequisite } from './types.js';

/**
 * PICS of the EVtivity charging station simulator (CSS) for OCPP 1.6.
 *
 * Item ids follow the rows of "PICS OCPP 1.6 certificate" (OCPP Compliance
 * Testing test procedures, Appendix A.1). Add an unsupported item with a
 * reason and map the affected test ids in `testPrerequisites` to report them
 * `notApplicable`.
 */
const items: Record<string, PicsItem> = {
  Core: {
    id: 'Core',
    description:
      'Basic Charging Station functionality: booting, authorization (incl. cache), configuration, transactions, remote control',
    supported: true,
  },
  Reservation: {
    id: 'Reservation',
    description: 'Optional feature: Reservation of a Connector',
    supported: true,
  },
  LocalAuthListManagement: {
    id: 'LocalAuthListManagement',
    description: 'Optional feature: Local Authorization List Management',
    supported: true,
  },
  SmartCharging: {
    id: 'SmartCharging',
    description: 'Smart Charging: all profile types, including stacking',
    supported: true,
  },
  AdvancedSecurity: {
    id: 'AdvancedSecurity',
    description: 'Security Profile 3: TLS with client side certificates',
    supported: true,
  },
};

const testPrerequisites: Record<string, PicsPrerequisite[]> = {};

export const PICS_V1_6: Pics = {
  sut: 'cs',
  version: 'ocpp1.6',
  items,
  testPrerequisites,
};
