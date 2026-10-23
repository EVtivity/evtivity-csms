// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The station picker takes an id for its Label and marks a form error.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

import { StationCombobox } from '@/components/station-combobox';
import { Label } from '@/components/ui/label';

afterEach(cleanup);

describe('StationCombobox', () => {
  it('is named by a Label through its id', () => {
    render(
      <>
        <Label htmlFor="pick">Station</Label>
        <StationCombobox id="pick" value={null} onSelect={() => undefined} />
      </>,
    );
    expect(screen.getByLabelText('Station').tagName).toBe('INPUT');
  });

  it('keeps the id on the picked station', () => {
    render(
      <>
        <Label htmlFor="pick">Station</Label>
        <StationCombobox
          id="pick"
          value={{ id: 'sta_1', stationId: 'CS-001' }}
          onSelect={() => undefined}
        />
      </>,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Station').value).toBe('CS-001');
  });

  it('marks a form error with the error border and aria-invalid', () => {
    render(<StationCombobox id="pick" invalid value={null} onSelect={() => undefined} />);
    const input = screen.getByRole('textbox');
    expect(input.className).toContain('border-destructive');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});
