// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The station picker takes an id for its Label and marks a form error.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { get } }));

import { StationCombobox } from '@/components/station-combobox';
import { Label } from '@/components/ui/label';

// jsdom has no layout: the highlighted result scrolls into view through this stub.
Element.prototype.scrollIntoView = vi.fn();

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
    const input = screen.getByRole('combobox');
    expect(input.className).toContain('border-destructive');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('searches, then picks a result with the keyboard and skips excluded stations', async () => {
    vi.useFakeTimers();
    get.mockResolvedValue({
      data: [
        { id: 'sta_1', stationId: 'CS-001', isOnline: true },
        { id: 'sta_2', stationId: 'CS-002', isOnline: false },
      ],
      total: 2,
    });
    const onSelect = vi.fn();
    render(
      <StationCombobox
        value={null}
        siteId="site_1"
        excludeIds={new Set(['sta_1'])}
        onSelect={onSelect}
      />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'CS' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();
    expect(get).toHaveBeenCalledWith('/v1/stations?search=CS&limit=10&page=1&siteId=site_1');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['CS-002']);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith({ id: 'sta_2', stationId: 'CS-002' });
  });
});
