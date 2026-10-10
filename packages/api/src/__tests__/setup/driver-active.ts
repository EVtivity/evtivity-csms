// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { vi } from 'vitest';

// Unit tests mock the database with results queued per route, so the driver
// status read that `driverTokenRejection` runs on every driver request would
// take a result meant for the route. Every API unit test therefore gets an
// active driver by default. A test of a deactivated driver sets
// `vi.mocked(isDriverActive).mockResolvedValue(false)`; `driver-active.test.ts`
// tests the real module (`vi.importActual`). Integration tests use the real
// database read.
vi.mock('../../lib/driver-active.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/driver-active.js')>()),
  isDriverActive: vi.fn(() => Promise.resolve(true)),
}));
