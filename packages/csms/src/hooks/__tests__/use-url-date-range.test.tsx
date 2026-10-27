// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { dayRangeApiParams, useUrlDateRange, validDay } from '../use-url-date-range';
import { LogDateRangeFilter } from '@/components/LogDateRangeFilter';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('day helpers', () => {
  it('accepts real calendar days only', () => {
    expect(validDay('2026-10-05')).toBe('2026-10-05');
    expect(validDay('2026-13-05')).toBe('');
    expect(validDay('yesterday')).toBe('');
    expect(validDay(null)).toBe('');
  });

  it('sends the start of from and the end of to', () => {
    expect(dayRangeApiParams('2026-10-01', '2026-10-02')).toEqual({
      from: new Date('2026-10-01T00:00:00').toISOString(),
      to: new Date('2026-10-02T23:59:59.999').toISOString(),
    });
    expect(dayRangeApiParams('', '')).toEqual({});
  });
});

describe('useUrlDateRange', () => {
  it('keeps the range in the URL next to the other params', () => {
    window.history.replaceState(null, '', '/logs?tab=api');
    const { result } = renderHook(() => useUrlDateRange(), { wrapper: BrowserRouter });
    act(() => {
      result.current.setFrom('2026-10-01');
    });
    act(() => {
      result.current.setTo('2026-10-03');
    });
    const params = new URLSearchParams(window.location.search);
    expect(params.get('tab')).toBe('api');
    expect(params.get('from')).toBe('2026-10-01');
    expect(params.get('to')).toBe('2026-10-03');
    expect(result.current.apiParams['from']).toBe(new Date('2026-10-01T00:00:00').toISOString());
    act(() => {
      result.current.clear();
    });
    expect(window.location.search).toBe('?tab=api');
  });
});

describe('LogDateRangeFilter', () => {
  function Harness(): React.JSX.Element {
    const range = useUrlDateRange();
    return <LogDateRangeFilter range={range} />;
  }

  it('limits To to days on or after From and clears both', () => {
    window.history.replaceState(null, '', '/logs?from=2026-10-01');
    render(
      <BrowserRouter>
        <Harness />
      </BrowserRouter>,
    );
    const to = screen.getByLabelText('common.to');
    expect(to.getAttribute('min')).toBe('2026-10-01');
    fireEvent.change(to, { target: { value: '2026-10-04' } });
    expect(screen.getByLabelText('common.from').getAttribute('max')).toBe('2026-10-04');
    fireEvent.click(screen.getByText('common.clearDates'));
    expect(window.location.search).toBe('');
    expect(screen.queryByText('common.clearDates')).toBeNull();
  });
});
