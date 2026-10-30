// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The notification preferences use the shared Checkbox, named by their labels.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const { get, put } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get, put } }));

import { AccountNotificationPrefs } from '../account/AccountNotificationPrefs';

afterEach(cleanup);

describe('AccountNotificationPrefs', () => {
  it('loads the preferences into the checkboxes and saves the change', async () => {
    get.mockResolvedValue({ emailEnabled: true, smsEnabled: false });
    put.mockResolvedValue({});
    render(<AccountNotificationPrefs />);
    const email = screen.getByRole('checkbox', { name: 'profile.emailNotifications' });
    const sms = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'profile.smsNotifications',
    });
    await waitFor(() => {
      expect(sms.checked).toBe(false);
    });
    fireEvent.click(email);
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(put).toHaveBeenCalledWith('/v1/portal/driver/notification-preferences', {
        emailEnabled: false,
        smsEnabled: false,
      });
    });
  });
});
