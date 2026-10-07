// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, putMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  putMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/language-select', () => ({
  LanguageSelect: (): null => null,
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, put: putMock, delete: deleteMock, post: vi.fn() },
}));

import { EventSettingsLayout } from '../EventSettingsLayout';

// Email HTML the editor normalizes (attribute order, the table body, a trailing paragraph),
// as the stored and default templates do.
const EMAIL_BODY =
  '<div><table width="100%"><tr><td><h1>Hello {{firstName}}</h1><p>Your session ended.</p></td></tr></table></div>';

function templateFor(url: string): Record<string, unknown> {
  const params = new URL(url, 'http://localhost').searchParams;
  const channel = params.get('channel') ?? 'email';
  const eventType = params.get('eventType') ?? '';
  return {
    eventType,
    channel,
    language: 'en',
    subject: channel === 'email' ? `Subject of ${eventType}` : null,
    bodyHtml: channel === 'email' ? EMAIL_BODY : `Text of ${eventType}`,
    isCustomized: false,
  };
}

const WARNING = 'notifications.unsavedChangesWarning';

interface RenderOptions {
  withToggle?: boolean;
  isSettingsExtraDirty?: () => boolean;
}

function renderLayout(options: RenderOptions = {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EventSettingsLayout
        sidebarTitle="Events"
        emptyMessage="Pick one"
        sections={[{ title: 'Events', events: ['event.A', 'event.B'] }]}
        channels={['email', 'sms']}
        {...(options.withToggle === true
          ? {
              toggleEndpoint: '/v1/ocpp-event-settings',
              toggleQueryKey: ['ocpp-event-settings'],
              enabledMap: new Map([['event.A:email', true]]),
              defaultEnabled: false,
              onSave: vi.fn().mockResolvedValue(undefined),
            }
          : {})}
        {...(options.isSettingsExtraDirty != null
          ? { isSettingsExtraDirty: options.isSettingsExtraDirty }
          : {})}
      />
    </QueryClientProvider>,
  );
}

async function openEvent(name: string): Promise<void> {
  fireEvent.click(screen.getByText(name));
  await waitFor(() => {
    expect(document.getElementById('tpl-subject')).not.toBeNull();
  });
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'notifications.save' });
}

beforeEach(() => {
  getMock.mockImplementation((url: string) => Promise.resolve(templateFor(url)));
  putMock.mockResolvedValue({});
  deleteMock.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EventSettingsLayout unsaved changes', () => {
  it('opens templates and switches between them without a warning when nothing changed', async () => {
    renderLayout();
    await openEvent('event.A');
    // Let the editor settle (normalization, sync effects).
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).not.toBeNull();
    });
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(screen.getByText('event.B'));
    await waitFor(() => {
      expect((document.getElementById('tpl-subject') as HTMLInputElement).value).toBe(
        'Subject of event.B',
      );
    });
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('warns after a subject edit and stops warning once the edit is undone', async () => {
    renderLayout();
    await openEvent('event.A');
    const subject = document.getElementById('tpl-subject') as HTMLInputElement;

    fireEvent.change(subject, { target: { value: 'Changed' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(screen.getByText('event.B'));
    expect(screen.getByText(WARNING)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    fireEvent.change(subject, { target: { value: 'Subject of event.A' } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByText('event.B'));
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('warns after an SMS body edit', async () => {
    renderLayout();
    await openEvent('event.A');
    fireEvent.click(screen.getByRole('button', { name: 'SMS' }));
    await waitFor(() => {
      expect(document.getElementById('tpl-body')).not.toBeNull();
    });
    const body = document.getElementById('tpl-body') as HTMLTextAreaElement;
    expect(body.value).toBe('Text of event.A');
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(body, { target: { value: 'New text' } });
    fireEvent.click(screen.getByText('event.B'));
    expect(screen.getByText(WARNING)).toBeTruthy();
  });

  it('does not warn after viewing the HTML source without editing it', async () => {
    renderLayout();
    await openEvent('event.A');
    fireEvent.click(screen.getByTitle('editor.htmlSource'));
    fireEvent.click(screen.getByTitle('editor.htmlSource'));
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByText('event.B'));
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('does not warn after a save', async () => {
    renderLayout();
    await openEvent('event.A');
    fireEvent.change(document.getElementById('tpl-subject') as HTMLInputElement, {
      target: { value: 'Saved subject' },
    });
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith(
        '/v1/notification-templates',
        expect.objectContaining({ eventType: 'event.A', subject: 'Saved subject' }),
      );
    });
    await waitFor(() => {
      expect(saveButton().disabled).toBe(true);
    });
    fireEvent.click(screen.getByText('event.B'));
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('counts a channel toggle only while it differs from the stored state', async () => {
    renderLayout({ withToggle: true });
    await openEvent('event.A');
    const toggle = screen.getByRole('switch');

    fireEvent.click(toggle);
    fireEvent.click(screen.getByText('event.B'));
    expect(screen.getByText(WARNING)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    fireEvent.click(toggle);
    fireEvent.click(screen.getByText('event.B'));
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('warns when the settings extra reports a change', async () => {
    const isSettingsExtraDirty = vi.fn(() => true);
    renderLayout({ isSettingsExtraDirty });
    await openEvent('event.A');
    expect(isSettingsExtraDirty).toHaveBeenCalledWith({
      selectedEvent: 'event.A',
      channel: 'email',
    });
    fireEvent.click(screen.getByText('event.B'));
    expect(screen.getByText(WARNING)).toBeTruthy();
  });
});
