// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isRequiredDriverEventType } from '@evtivity/lib/notification-events';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/TemplateEditPanel', () => ({
  TemplateEditPanel: (): null => null,
}));

vi.mock('@/components/ui/language-select', () => ({
  LanguageSelect: (): null => null,
}));

import { EventSettingsLayout, type EventSwitch } from '../EventSettingsLayout';

afterEach(() => {
  cleanup();
});

function renderLayout(eventSwitch: EventSwitch): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EventSettingsLayout
        sidebarTitle="Driver"
        emptyMessage="Pick one"
        sections={[
          { title: 'Account', events: ['driver.ForgotPassword', 'driver.Welcome'] },
          { title: 'Sessions', events: ['session.Receipt'] },
        ]}
        channels={['email', 'sms']}
        eventSwitch={eventSwitch}
      />
    </QueryClientProvider>,
  );
}

function makeSwitch(overrides: Partial<EventSwitch> = {}): EventSwitch {
  return {
    enabledMap: new Map([['session.Receipt', false]]),
    isRequired: isRequiredDriverEventType,
    requiredTooltip: 'always on',
    switchTooltip: 'switch',
    canEdit: true,
    onChange: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('EventSettingsLayout event switch', () => {
  it('shows a switch that turns a driver event type off', async () => {
    const eventSwitch = makeSwitch();
    renderLayout(eventSwitch);
    fireEvent.click(screen.getByText('driver.Welcome'));

    const toggle = screen.getByRole<HTMLButtonElement>('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(eventSwitch.onChange).toHaveBeenCalledWith('driver.Welcome', false);
    });
    expect(await screen.findByText('notifications.eventTurnedOff')).toBeTruthy();
  });

  it('shows a stored disabled event type as off', () => {
    renderLayout(makeSwitch());
    expect(screen.getByTestId('event-switch-dot-session.Receipt').className).toContain(
      'bg-muted-foreground',
    );
    fireEvent.click(screen.getByText('session.Receipt'));
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('locks a required event type on, even with a stored disabled row', () => {
    renderLayout(makeSwitch({ enabledMap: new Map([['driver.ForgotPassword', false]]) }));
    expect(screen.getByTestId('event-switch-dot-driver.ForgotPassword').className).toContain(
      'bg-success',
    );
    fireEvent.click(screen.getByText('driver.ForgotPassword'));
    const toggle = screen.getByRole<HTMLButtonElement>('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.disabled).toBe(true);
  });

  it('disables the switch without the notifications write permission', () => {
    renderLayout(makeSwitch({ canEdit: false }));
    fireEvent.click(screen.getByText('driver.Welcome'));
    expect(screen.getByRole<HTMLButtonElement>('switch').disabled).toBe(true);
  });

  it('shows no switch without eventSwitch', () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <EventSettingsLayout
          sidebarTitle="System"
          emptyMessage="Pick one"
          sections={[{ title: 'Operator', events: ['operator.UserCreated'] }]}
          channels={['email', 'sms']}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText('operator.UserCreated'));
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('EventSettingsLayout channels per event', () => {
  it('offers only the channels an event type is sent on', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <EventSettingsLayout
          sidebarTitle="Driver"
          emptyMessage="Pick one"
          sections={[
            { title: 'Account', events: ['driver.AccountVerification', 'driver.Welcome'] },
          ]}
          channels={['email', 'sms']}
          channelsFor={(et) => (et === 'driver.AccountVerification' ? ['email'] : ['email', 'sms'])}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText('driver.Welcome'));
    fireEvent.click(screen.getByRole('button', { name: 'SMS' }));
    expect(screen.getByRole('button', { name: 'SMS' }).className).toContain('bg-primary');

    fireEvent.click(screen.getByText('driver.AccountVerification'));
    expect(screen.getByRole('button', { name: 'Email' }).className).toContain('bg-primary');
    expect(screen.queryByRole('button', { name: 'SMS' })).toBeNull();
  });
});
