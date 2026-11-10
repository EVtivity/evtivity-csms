// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars != null ? `${key}:${Object.values(vars).join('|')}` : key,
  }),
}));

import { DriverChoiceCard } from '../DriverChoiceCard';

const NONE = { email: false, sms: false, push: false };

afterEach(() => {
  cleanup();
});

describe('DriverChoiceCard', () => {
  it('shows Optional or Mandatory per channel and saves a change', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(
      <DriverChoiceCard
        eventType="session.Faulted"
        eventOn
        mandatory={{ email: true, sms: false, push: false }}
        available={{ email: true, sms: true, push: true }}
        canEdit
        onChange={onChange}
      />,
    );
    const email = screen.getByLabelText<HTMLSelectElement>(
      'notifications.driverChoice.selectLabel:notifications.driverChoice.channelEmail|session.Faulted',
    );
    expect(email.value).toBe('mandatory');
    const sms = screen.getByLabelText<HTMLSelectElement>(
      'notifications.driverChoice.selectLabel:notifications.driverChoice.channelSms|session.Faulted',
    );
    expect(sms.value).toBe('optional');
    fireEvent.change(sms, { target: { value: 'mandatory' } });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('sms', true);
    });
  });

  it('says a channel that is not configured sends nothing', () => {
    render(
      <DriverChoiceCard
        eventType="session.Faulted"
        eventOn
        mandatory={NONE}
        available={{ email: true, sms: false, push: true }}
        canEdit
        onChange={vi.fn()}
      />,
    );
    expect(screen.getAllByText('notifications.driverChoice.notConfigured')).toHaveLength(1);
  });

  it('says an event turned off is not sent, mandatory or not', () => {
    render(
      <DriverChoiceCard
        eventType="session.Started"
        eventOn={false}
        mandatory={{ email: true, sms: false, push: false }}
        available={undefined}
        canEdit
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('notifications.driverChoice.eventOff')).toBeTruthy();
  });

  it.each(['driver.ForgotPassword', 'mfa.VerificationCode', 'driver.Welcome'])(
    'offers no choice for %s, which drivers always get',
    (eventType) => {
      render(
        <DriverChoiceCard
          eventType={eventType}
          eventOn
          mandatory={NONE}
          available={undefined}
          canEdit
          onChange={vi.fn()}
        />,
      );
      expect(screen.getByText('notifications.driverChoice.alwaysSent')).toBeTruthy();
      expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    },
  );

  it('is read-only without the permission', () => {
    render(
      <DriverChoiceCard
        eventType="session.Faulted"
        eventOn
        mandatory={NONE}
        available={undefined}
        canEdit={false}
        onChange={vi.fn()}
      />,
    );
    for (const select of screen.getAllByRole<HTMLSelectElement>('combobox')) {
      expect(select.disabled).toBe(true);
    }
  });

  it('shows the error of a refused save', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('nope'));
    render(
      <DriverChoiceCard
        eventType="session.Faulted"
        eventOn
        mandatory={NONE}
        available={undefined}
        canEdit
        onChange={onChange}
      />,
    );
    const [first] = screen.getAllByRole('combobox');
    if (first == null) throw new Error('no channel select');
    fireEvent.change(first, { target: { value: 'mandatory' } });
    await waitFor(() => {
      expect(screen.getByTestId('driver-choice-card').textContent).toContain('nope');
    });
  });
});
