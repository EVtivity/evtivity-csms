// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, putMock, postMock, deleteMock, toastMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  putMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, put: putMock, post: postMock, delete: deleteMock },
}));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { StationMessageSettings } from '../settings/StationMessageSettings';

const TEMPLATES = {
  data: [
    { state: 'available', language: 'en', body: 'EN available', updatedAt: null, updatedBy: null },
    { state: 'available', language: 'de', body: 'DE verfügbar', updatedAt: null, updatedBy: null },
  ],
};

function renderSettings(settings: Record<string, unknown>): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <StationMessageSettings settings={settings} />
    </QueryClientProvider>,
  );
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element == null) throw new Error(`Missing element #${id}`);
  return element;
}

function saveButton(index: number): HTMLElement {
  const buttons = screen.getAllByRole('button', { name: /common.save|save/i });
  const button = index < 0 ? buttons[buttons.length + index] : buttons[index];
  if (button == null) throw new Error('Missing save button');
  return button;
}

const body = (): HTMLTextAreaElement => byId('station-message-body') as HTMLTextAreaElement;

beforeEach(() => {
  getMock.mockResolvedValue(TEMPLATES);
  putMock.mockResolvedValue({});
  postMock.mockResolvedValue({ rendered: 'preview' });
  deleteMock.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StationMessageSettings', () => {
  it('edits the templates of the display language by default', async () => {
    renderSettings({ 'stationMessage.language': 'de' });
    await waitFor(() => {
      expect(body().value).toBe('DE verfügbar');
    });
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        '/v1/station-message-templates/preview',
        expect.objectContaining({ state: 'available', language: 'de' }),
      );
    });
  });

  it('does not request a preview before the templates load', async () => {
    let resolveTemplates: (value: typeof TEMPLATES) => void = () => {};
    getMock.mockReturnValue(
      new Promise((resolve) => {
        resolveTemplates = resolve;
      }),
    );
    renderSettings({ 'stationMessage.language': 'en' });

    // Longer than the 300 ms preview debounce, while the body is still empty.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(postMock).not.toHaveBeenCalled();

    resolveTemplates(TEMPLATES);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        '/v1/station-message-templates/preview',
        expect.objectContaining({ body: 'EN available' }),
      );
    });
  });

  it('switches the edited template language and saves with it', async () => {
    renderSettings({ 'stationMessage.language': 'de' });
    await waitFor(() => {
      expect(body().value).toBe('DE verfügbar');
    });

    fireEvent.change(byId('station-message-template-language'), {
      target: { value: 'en' },
    });
    await waitFor(() => {
      expect(body().value).toBe('EN available');
    });

    fireEvent.change(body(), { target: { value: 'EN edited' } });
    fireEvent.click(saveButton(-1));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/station-message-templates/available?language=en', {
        body: 'EN edited',
      });
    });
  });

  it('saves the display language setting', async () => {
    renderSettings({ 'stationMessage.language': 'en' });
    fireEvent.change(byId('station-message-display-language'), {
      target: { value: 'ko' },
    });
    fireEvent.click(saveButton(0));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/stationMessage.language', {
        value: 'ko',
      });
    });
  });

  it('lists the tax note and single price variables for the available state', async () => {
    renderSettings({});
    await waitFor(() => {
      expect(screen.getByText('{{taxRatePercent}}')).toBeTruthy();
    });
    for (const name of ['pricesIncludeTax', 'energyPrice', 'timePrice', 'sessionFee', 'idleFee']) {
      expect(screen.getByText(`{{${name}}}`)).toBeTruthy();
    }
  });
});
