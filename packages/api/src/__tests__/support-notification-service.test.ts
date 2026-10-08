// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbResults: unknown[][] = [];

vi.mock('@evtivity/database', () => {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => Promise.resolve(dbResults.shift() ?? [])),
  };
  return {
    db: { select: vi.fn(() => query) },
    client: {},
    users: { id: 'id', email: 'email', phone: 'phone', language: 'language', roleId: 'roleId' },
    roles: { id: 'id', name: 'name' },
    isSupportEnabled: vi.fn().mockResolvedValue(true),
  };
});

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dispatchSystemNotification: vi.fn().mockResolvedValue(undefined) };
});

import { dispatchSystemNotification } from '@evtivity/lib';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { dispatchOperatorNotification } from '../services/support-notification.service.js';

describe('dispatchOperatorNotification', () => {
  beforeEach(() => {
    dbResults.length = 0;
    vi.mocked(dispatchSystemNotification).mockClear();
  });

  // Finding J2: a dispatch without the template directories (or with a path
  // that does not exist in the image) sends the notification unrendered.
  it('renders from the API and OCPP template directories', async () => {
    dbResults.push([{ id: 'usr_1', email: 'op@example.com', phone: null, language: 'en' }]);

    await dispatchOperatorNotification('new_case', 'case_1', 'SC-1', 'Help', 'usr_1');

    expect(dispatchSystemNotification).toHaveBeenCalledWith(
      expect.anything(),
      'supportCase.NewCaseFromDriver',
      expect.objectContaining({ email: 'op@example.com', userId: 'usr_1' }),
      expect.objectContaining({ caseNumber: 'SC-1' }),
      ALL_TEMPLATES_DIRS,
    );
  });
});
