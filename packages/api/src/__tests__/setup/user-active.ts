// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { vi } from 'vitest';

// Unit tests mock the database with results queued per route, so the operator
// status read that `operatorTokenRejection` runs on every operator request
// would take a result meant for the route. Every API unit test therefore gets
// an active operator at session version 0 by default. A test of a
// deactivated operator sets `vi.mocked(getUserSessionState).mockResolvedValue(
// { active: false, sessionVersion: 0 })`; `user-active.test.ts`
// tests the real module (`vi.importActual`). Integration tests use the real
// database read.
vi.mock('../../lib/user-active.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/user-active.js')>()),
  getUserSessionState: vi.fn(() => Promise.resolve({ active: true, sessionVersion: 0 })),
}));
