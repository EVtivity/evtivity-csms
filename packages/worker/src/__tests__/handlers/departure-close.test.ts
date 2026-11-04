// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const { mockClose } = vi.hoisted(() => ({ mockClose: vi.fn() }));

vi.mock('@evtivity/services/departure-notice.service', () => ({
  closePassedDepartures: mockClose,
}));
vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: ['/templates'] }));
vi.mock('../../lib/config.js', () => ({ config: { CSMS_URL: 'https://csms.example.com' } }));

import { departureCloseHandler } from '../../handlers/departure-close.js';

function makeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

beforeEach(() => mockClose.mockReset());

describe('departure-close', () => {
  it('closes with the CSMS link, the templates and the run time, and logs what it completed', async () => {
    const now = new Date('2026-11-01T05:31:00Z');
    const result = { completed: 3, met: 1, short: 1, noVehicle: 1, notified: 2 };
    mockClose.mockResolvedValue(result);
    const log = makeLog();
    await departureCloseHandler(log, now);
    const deps = mockClose.mock.calls[0]?.[0] as Record<string, unknown> & { now: () => Date };
    expect(deps).toMatchObject({
      log,
      csmsUrl: 'https://csms.example.com',
      templatesDirs: ['/templates'],
    });
    expect(deps.now()).toBe(now);
    expect(log.info).toHaveBeenCalledWith(result, 'Passed departures completed');
  });

  it('logs nothing when no departure passed', async () => {
    mockClose.mockResolvedValue({ completed: 0, met: 0, short: 0, noVehicle: 0, notified: 0 });
    const log = makeLog();
    await departureCloseHandler(log);
    expect(log.info).not.toHaveBeenCalled();
  });
});
