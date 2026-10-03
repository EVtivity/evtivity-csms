// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { WysiwygEditor } from '../wysiwyg-editor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('WysiwygEditor', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('registers each extension once and keeps links', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(
      <WysiwygEditor
        value='<p><a href="https://example.com">Example</a></p>'
        onChange={() => {}}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('a[href="https://example.com"]')).not.toBeNull();
    });
    const duplicateWarnings = warn.mock.calls.filter((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes('Duplicate extension names')),
    );
    expect(duplicateWarnings).toEqual([]);
  });
});
