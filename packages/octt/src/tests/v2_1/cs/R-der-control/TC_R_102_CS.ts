// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_R_102_CS: CsTestCase = {
  id: 'TC_R_102_CS',
  name: 'Configure DER control settings at CS - clearing controlTypes',
  module: 'R-der-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Setting some controlTypes and let the Charging Station clear them.',
  purpose: 'To check if the CS behaves correctly when clearing controlTypes in different ways.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_R_103_CS: CsTestCase = {
  id: 'TC_R_103_CS',
  name: 'Configure DER control settings at CS - validations',
  module: 'R-der-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Test System tries to set, clear or get DER controls which is not supported, set, or supported by the CS.',
  purpose: 'To check if the CS returns the correct status.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_R_104_CS: CsTestCase = {
  id: 'TC_R_104_CS',
  name: 'Configure DER control settings at CS - superseding future DER control',
  module: 'R-der-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Test System tries to set a DER control which supersedes another with different priority.',
  purpose:
    'To check if the CS behaves correctly when setting controlTypes with different priorities.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_R_105_CS: CsTestCase = {
  id: 'TC_R_105_CS',
  name: 'Configure DER control settings at CS - superseding active DER control',
  module: 'R-der-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Test System sets active DER controls and verifies superseding behavior with start/stop notifications.',
  purpose:
    'To check if the CS correctly notifies when an active DER control is superseded by a higher priority one.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_R_106_CS: CsTestCase = {
  id: 'TC_R_106_CS',
  name: 'Configure DER control settings at CS - Active DER control supersedes new DER control',
  module: 'R-der-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Test System sets an active DER control with higher priority that supersedes a new one.',
  purpose:
    'To check if the CS correctly reports superseded status when an active control has higher priority.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
