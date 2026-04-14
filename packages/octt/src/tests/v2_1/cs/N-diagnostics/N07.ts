// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

export const TC_N_20_CS: CsTestCase = {
  id: 'TC_N_20_CS',
  name: 'Alert Event - Threshold value exceeded',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'A monitored variable exceeds a threshold causing a NotifyEventRequest.',
  purpose: 'To test that Charging Station supports threshold monitors.',
  execute: async (_ctx) => {
    // Requires real threshold monitoring with actual variable value changes.
    // CSS does not simulate variable value changes that cross thresholds.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_N_21_CS: CsTestCase = {
  id: 'TC_N_21_CS',
  name: 'Alert Event - Caused by hardwired trigger',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'A hardwired event is reported by the firmware.',
  purpose: 'To test that Charging Station reports hardwired notifications.',
  execute: async (_ctx) => {
    // Requires the CSS to proactively send hardwired NotifyEvent messages.
    // CSS does not simulate firmware-level event triggers.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_N_22_CS: CsTestCase = {
  id: 'TC_N_22_CS',
  name: 'Offline Notification - Queued (severity equal or lower)',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Charging Station queues event notifications when offline.',
  purpose:
    'To test that Charging Station queues events with severity at or below the configured level.',
  execute: async (_ctx) => {
    // Requires offline/reconnect simulation with event queuing by severity.
    // CSS does not implement offline event queue by monitoring severity level.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_N_23_CS: CsTestCase = {
  id: 'TC_N_23_CS',
  name: 'Offline Notification - Not queued (severity higher)',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Charging Station does not queue event notifications with severity above the threshold.',
  purpose:
    'To test that Charging Station does not queue events with severity higher than the configured level.',
  execute: async (_ctx) => {
    // Requires offline/reconnect simulation with severity-based event filtering.
    // CSS does not implement offline event queue by monitoring severity level.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_N_45_CS: CsTestCase = {
  id: 'TC_N_45_CS',
  name: 'Alert Event - Delta value exceeded',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'A monitored delta value is exceeded and reported via NotifyEventRequest.',
  purpose: 'To verify if the Charging Station correctly reports when a delta value is exceeded.',
  execute: async (_ctx) => {
    // Requires real variable value changes that exceed delta thresholds.
    // CSS does not simulate variable value changes for monitoring.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
