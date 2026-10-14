// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { AttachmentPreviews, addPendingFiles } from '../AttachmentPicker';

describe('attachment previews', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('never turns a chosen file into a URL in the page', () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    const original = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    onTestFinished(() => {
      if (original != null) Object.defineProperty(URL, 'createObjectURL', original);
    });
    const files = [
      new File(['<svg onload="alert(1)"/>'], 'x.png', { type: 'image/png' }),
      new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' }),
    ];
    const pending = addPendingFiles([], files);
    const { container } = render(
      <AttachmentPreviews attachments={pending} onRemove={vi.fn()} disabled={false} />,
    );
    expect(createObjectURL).not.toHaveBeenCalled();
    // No attribute holds a URL made from the file (the spinner keeps its own icon).
    for (const el of container.querySelectorAll('*')) {
      for (const attr of el.attributes) expect(attr.value).not.toMatch(/^(blob|data):/);
    }
    // The image gets a canvas thumbnail named after the file.
    const thumb = screen.getByRole('img', { name: 'x.png' });
    expect(thumb.tagName).toBe('CANVAS');
  });
});
