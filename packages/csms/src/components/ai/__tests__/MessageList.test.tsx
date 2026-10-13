// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  PORTAL_BASE_URL: 'https://portal.example.com',
}));

import { MessageBubble } from '../MessageList';
import { emptyAssistantMessage } from '../ai-turn';
import type { AiMessageView } from '../ai-turn';

afterEach(cleanup);

function answer(citations: AiMessageView['citations']): AiMessageView {
  return { ...emptyAssistantMessage(), text: 'Open Settings.', finish: 'end', citations };
}

describe('MessageBubble sources (TC-AI-M-06)', () => {
  it('lists the sources of an answer as links under it', () => {
    render(
      <MessageBubble
        message={answer([
          {
            id: '7',
            title: 'Settings - Company',
            url: 'https://evtivity.com/docs/csms/settings#company',
          },
          { id: '9', title: 'Sites', url: 'https://evtivity.com/de/docs/csms/sites' },
        ])}
        canDecide={false}
        onConfirm={() => {}}
        onReject={() => {}}
      />,
    );
    const list = screen.getByRole('list', { name: 'ai.citations' });
    const links = within(list).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Settings - Company', 'Sites']);
    expect(links[0]?.getAttribute('href')).toBe('https://evtivity.com/docs/csms/settings#company');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    // No icon in the heading of the list.
    expect(screen.getByText('ai.citations').querySelector('svg')).toBeNull();
  });

  it('renders a source outside the link allowlist as text, never as a link', () => {
    render(
      <MessageBubble
        message={answer([
          { id: '1', title: 'Elsewhere', url: 'https://evil.example.com/docs' },
          { id: '2', title: 'Script', url: 'javascript:alert(1)' },
        ])}
        canDecide={false}
        onConfirm={() => {}}
        onReject={() => {}}
      />,
    );
    const list = screen.getByRole('list', { name: 'ai.citations' });
    expect(within(list).queryAllByRole('link')).toEqual([]);
    expect(within(list).getByText('Elsewhere')).toBeTruthy();
  });

  it('shows no sources section for an answer without citations', () => {
    render(
      <MessageBubble
        message={answer([])}
        canDecide={false}
        onConfirm={() => {}}
        onReject={() => {}}
      />,
    );
    expect(screen.queryByText('ai.citations')).toBeNull();
  });
});
