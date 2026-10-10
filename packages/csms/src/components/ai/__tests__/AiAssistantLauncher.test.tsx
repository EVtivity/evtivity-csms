// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, permissions } = vi.hoisted(() => ({
  getMock: vi.fn(),
  permissions: { read: true },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (perm: string) => (perm === 'aiAssistant:read' ? permissions.read : false),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('../AiPanel', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="ai-panel">
      <button type="button" onClick={onClose}>
        close-panel
      </button>
    </div>
  ),
}));

import { AiAssistantLauncher, isAiShortcut } from '../AiAssistantLauncher';

function renderLauncher(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <button type="button">page button</button>
      <AiAssistantLauncher />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  permissions.read = true;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AiAssistantLauncher', () => {
  it('renders the button when the status says the assistant is available', async () => {
    getMock.mockResolvedValue({ enabled: true, supportAssistEnabled: false });
    renderLauncher();
    expect(await screen.findByTestId('ai-launcher')).toBeTruthy();
    expect(getMock).toHaveBeenCalledWith('/v1/assistant/status');
  });

  it('renders nothing when the chatbot is disabled or has no provider key (enabled: false)', async () => {
    getMock.mockResolvedValue({ enabled: false, supportAssistEnabled: true });
    renderLauncher();
    await waitFor(() => {
      expect(getMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('ai-launcher')).toBeNull();
    expect(screen.queryByTestId('ai-panel')).toBeNull();
  });

  it('renders nothing and does not ask the API without aiAssistant:read', () => {
    permissions.read = false;
    renderLauncher();
    expect(screen.queryByTestId('ai-launcher')).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('fails closed when the status request fails', async () => {
    getMock.mockRejectedValue(new Error('403'));
    renderLauncher();
    await waitFor(() => {
      expect(getMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('ai-launcher')).toBeNull();
  });

  it('Ctrl+K is ignored while the assistant is unavailable', async () => {
    getMock.mockResolvedValue({ enabled: false, supportAssistEnabled: false });
    renderLauncher();
    await waitFor(() => {
      expect(getMock).toHaveBeenCalled();
    });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByTestId('ai-panel')).toBeNull();
  });

  it('TC-AI-UI-07: Ctrl+K toggles the panel and closing returns focus', async () => {
    getMock.mockResolvedValue({ enabled: true, supportAssistEnabled: false });
    renderLauncher();
    await screen.findByTestId('ai-launcher');
    const pageButton = screen.getByText('page button');
    pageButton.focus();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByTestId('ai-panel')).toBeTruthy();
    expect(screen.queryByTestId('ai-launcher')).toBeNull();
    fireEvent.click(screen.getByText('close-panel'));
    await waitFor(() => {
      expect(document.activeElement).toBe(pageButton);
    });
    fireEvent.keyDown(window, { key: 'K', metaKey: true });
    expect(await screen.findByTestId('ai-panel')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await waitFor(() => {
      expect(screen.queryByTestId('ai-panel')).toBeNull();
    });
  });

  it('isAiShortcut matches Ctrl+K and Cmd+K only', () => {
    const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    expect(isAiShortcut(ev({ key: 'k', ctrlKey: true }))).toBe(true);
    expect(isAiShortcut(ev({ key: 'k', metaKey: true }))).toBe(true);
    expect(isAiShortcut(ev({ key: 'k' }))).toBe(false);
    expect(isAiShortcut(ev({ key: 'k', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isAiShortcut(ev({ key: 'j', ctrlKey: true }))).toBe(false);
  });
});
