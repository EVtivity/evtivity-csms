// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isRequiredDriverEventType } from '@evtivity/lib/notification-events';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) =>
      opts?.['event'] == null
        ? key
        : opts['channel'] == null
          ? `${key}:${opts['event']}`
          : `${key}:${opts['event']}:${opts['channel']}`,
  }),
}));

const access = vi.hoisted(() => ({ canWrite: true }));
// Mocked so the test can prove the editor renders no History list of its own.
vi.mock('@/components/EntityHistoryTab', () => ({
  EntityHistoryTab: ({ entityType, entityId }: { entityType: string; entityId: string | null }) => (
    <div data-testid="entity-history">{`${entityType}:${entityId ?? '*'}`}</div>
  ),
}));

vi.mock('@/lib/auth', () => ({ useHasCompanyWidePermission: () => access.canWrite }));

vi.mock('@/components/TemplateEditPanel', () => ({
  TemplateEditPanel: (): null => null,
}));

vi.mock('@/components/ui/language-select', () => ({
  LanguageSelect: (): null => null,
}));

import { EventSettingsLayout, type EventSwitch } from '../EventSettingsLayout';
import en from '@/i18n/locales/en.json';
import de from '@/i18n/locales/de.json';
import es from '@/i18n/locales/es.json';
import ko from '@/i18n/locales/ko.json';
import zh from '@/i18n/locales/zh.json';
import zhTW from '@/i18n/locales/zh-TW.json';

afterEach(() => {
  cleanup();
  access.canWrite = true;
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
    // Template changes are listed in the Notifications History tab, not under the editor.
    expect(screen.queryByTestId('entity-history')).toBeNull();
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

  it('disables the switch and hides Save and Reset for a site-restricted user', () => {
    access.canWrite = false;
    renderLayout(makeSwitch());
    fireEvent.click(screen.getByText('driver.Welcome'));
    expect(screen.getByRole<HTMLButtonElement>('switch').disabled).toBe(true);
    expect(screen.queryByText('notifications.save')).toBeNull();
    expect(screen.queryByText('notifications.resetToDefault')).toBeNull();
    expect(screen.getByText('notifications.preview')).toBeTruthy();
  });

  it('shows Save and Reset to a user with company-wide notification write access', () => {
    renderLayout(makeSwitch());
    fireEvent.click(screen.getByText('driver.Welcome'));
    expect(screen.getByText('notifications.save')).toBeTruthy();
    expect(screen.getByText('notifications.resetToDefault')).toBeTruthy();
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

describe('EventSettingsLayout template toggle', () => {
  it('names the template switch after the event and channel it controls', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <EventSettingsLayout
          sidebarTitle="OCPP"
          emptyMessage="Pick one"
          sections={[{ title: 'Stations', events: ['station.Offline'] }]}
          channels={['email', 'sms']}
          toggleEndpoint="/v1/notifications/ocpp-events"
          toggleQueryKey={['ocpp-events']}
          enabledMap={new Map([['station.Offline:email', true]])}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText('station.Offline'));
    const toggle = screen.getByRole('switch', {
      name: 'notifications.channelToggleLabel:station.Offline:Email',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'SMS' }));
    expect(
      screen.getByRole('switch', { name: 'notifications.channelToggleLabel:station.Offline:SMS' }),
    ).toBeTruthy();
  });

  it('has the switch names in all six locales with their variables', () => {
    for (const [lang, locale] of Object.entries({ en, de, es, ko, zh, 'zh-TW': zhTW })) {
      const text = locale.notifications.channelToggleLabel;
      expect(text, lang).toContain('{{event}}');
      expect(text, lang).toContain('{{channel}}');
      expect(locale.notifications.eventToggleLabel, lang).toContain('{{event}}');
    }
  });

  it('names the event switch after its event and keeps the state as the visible label', () => {
    renderLayout(makeSwitch());
    fireEvent.click(screen.getByText('session.Receipt'));
    const toggle = screen.getByRole('switch', {
      name: 'notifications.eventToggleLabel:session.Receipt',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('common.inactive')).toBeTruthy();
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
