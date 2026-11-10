// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The notification preferences matrix (discussion 56): per event and channel,
// the configured channels only, mandatory rows locked on.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars != null ? `${key}:${Object.values(vars).join('|')}` : key,
    i18n: { language: 'en' },
  }),
}));
const { get, put } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get, put }, ApiError: class ApiError extends Error {} }));

import {
  AccountNotificationPrefs,
  type NotificationPreferences,
} from '../account/AccountNotificationPrefs';

afterEach(cleanup);

const on = { enabled: true, mandatory: false };
const off = { enabled: false, mandatory: false };
const locked = { enabled: true, mandatory: true };

function prefs(patch: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    emailEnabled: true,
    smsEnabled: true,
    channels: { email: true, sms: true, push: true },
    events: [
      { eventType: 'session.Started', group: 'sessions', email: on, sms: off },
      { eventType: 'session.Faulted', group: 'sessions', email: locked, sms: on },
      { eventType: 'invoice.Sent', group: 'invoices', email: on, sms: on },
    ],
    ...patch,
  };
}

const cell = (event: string, channel: string) =>
  screen.getByRole<HTMLInputElement>('checkbox', {
    name: `notificationPrefs.eventChannelLabel:notificationPrefs.events.${event}|notificationPrefs.channels.${channel}`,
  });
const all = (channel: string) =>
  screen.getByRole<HTMLInputElement>('checkbox', {
    name: `notificationPrefs.allChannelLabel:notificationPrefs.channels.${channel}`,
  });

describe('AccountNotificationPrefs', () => {
  it('shows each event per channel, grouped, with a mandatory row locked on', async () => {
    get.mockResolvedValue(prefs());
    render(<AccountNotificationPrefs />);
    await waitFor(() => {
      expect(cell('session.Started', 'sms').checked).toBe(false);
    });
    expect(screen.getByText('notificationPrefs.groups.sessions')).toBeTruthy();
    expect(screen.getByText('notificationPrefs.groups.invoices')).toBeTruthy();
    const faulted = cell('session.Faulted', 'email');
    expect(faulted.checked).toBe(true);
    expect(faulted.disabled).toBe(true);
    expect(screen.getByTestId('required-session.Faulted-email')).toBeTruthy();
    expect(screen.getByText('notificationPrefs.requiredNote')).toBeTruthy();
    expect(screen.getByText('notificationPrefs.alwaysSentNote')).toBeTruthy();
  });

  it('saves only the changed event choices', async () => {
    get.mockResolvedValue(prefs());
    put.mockResolvedValue(prefs());
    render(<AccountNotificationPrefs />);
    await waitFor(() => {
      expect(cell('session.Started', 'email').checked).toBe(true);
    });
    fireEvent.click(cell('session.Started', 'email'));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(put).toHaveBeenCalledWith('/v1/portal/driver/notification-preferences', {
        events: [{ eventType: 'session.Started', channel: 'email', enabled: false }],
      });
    });
  });

  it('turns every optional event of a channel off with All, leaving a mandatory one on', async () => {
    get.mockResolvedValue(prefs());
    put.mockResolvedValue(prefs());
    render(<AccountNotificationPrefs />);
    await waitFor(() => {
      expect(all('email').checked).toBe(true);
    });
    fireEvent.click(all('email'));
    expect(cell('session.Started', 'email').checked).toBe(false);
    expect(cell('invoice.Sent', 'email').checked).toBe(false);
    expect(cell('session.Faulted', 'email').checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(put).toHaveBeenCalledWith('/v1/portal/driver/notification-preferences', {
        emailEnabled: false,
        events: [
          { eventType: 'session.Started', channel: 'email', enabled: false },
          { eventType: 'invoice.Sent', channel: 'email', enabled: false },
        ],
      });
    });
  });

  it('shows the All checkbox mixed when some events are on', async () => {
    get.mockResolvedValue(prefs());
    render(<AccountNotificationPrefs />);
    await waitFor(() => {
      expect(all('sms').indeterminate).toBe(true);
    });
  });

  it('hides a channel the operator has not configured', async () => {
    get.mockResolvedValue(prefs({ channels: { email: true, sms: false, push: true } }));
    render(<AccountNotificationPrefs />);
    await waitFor(() => {
      expect(cell('session.Started', 'email')).toBeTruthy();
    });
    expect(screen.queryByText('notificationPrefs.channels.sms')).toBeNull();
  });

  it('says so when no channel is configured', async () => {
    get.mockResolvedValue(prefs({ channels: { email: false, sms: false, push: true } }));
    render(<AccountNotificationPrefs />);
    await waitFor(() => {
      expect(screen.getByText('notificationPrefs.noChannels')).toBeTruthy();
    });
    expect(screen.queryByTestId('notification-matrix')).toBeNull();
    expect(screen.queryByRole('button', { name: 'common.save' })).toBeNull();
  });

  it('shows the refusal of a save', async () => {
    get.mockResolvedValue(prefs());
    put.mockRejectedValue(new Error('refused'));
    render(<AccountNotificationPrefs />);
    await waitFor(() => {
      expect(cell('invoice.Sent', 'sms').checked).toBe(true);
    });
    fireEvent.click(cell('invoice.Sent', 'sms'));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(screen.getByText('profile.preferencesFailed')).toBeTruthy();
    });
  });
});
