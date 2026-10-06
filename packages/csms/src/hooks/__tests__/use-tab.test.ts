// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { useTab } from '../use-tab';

function setup(
  initialUrl: string,
  defaultTab: string,
  paramName?: string,
  clearParams?: string[],
): { current: { tab: string; setTab: (t: string) => void; search: string } } {
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(MemoryRouter, { initialEntries: [initialUrl] }, children);
  const { result } = renderHook(
    () => {
      const [tab, setTab] =
        paramName === undefined ? useTab(defaultTab) : useTab(defaultTab, paramName, clearParams);
      const location = useLocation();
      return { tab, setTab, search: location.search };
    },
    { wrapper },
  );
  return result;
}

describe('useTab', () => {
  it('returns the default tab when the param is absent', () => {
    const result = setup('/stations/1', 'details');
    expect(result.current.tab).toBe('details');
  });

  it('reads the tab from the URL', () => {
    const result = setup('/stations/1?tab=sessions', 'details');
    expect(result.current.tab).toBe('sessions');
  });

  it('writes a non-default tab to the URL', () => {
    const result = setup('/stations/1?q=x', 'details');
    act(() => {
      result.current.setTab('logs');
    });
    expect(result.current.tab).toBe('logs');
    const params = new URLSearchParams(result.current.search);
    expect(params.get('tab')).toBe('logs');
    expect(params.get('q')).toBe('x');
  });

  it('removes the param when switching back to the default tab', () => {
    const result = setup('/stations/1?tab=logs', 'details');
    act(() => {
      result.current.setTab('details');
    });
    expect(result.current.tab).toBe('details');
    expect(result.current.search).toBe('');
  });

  it('uses a custom param name and clears listed params on change', () => {
    const result = setup('/x?view=a&page=3&sort=name&keep=1', 'a', 'view', ['page', 'sort']);
    expect(result.current.tab).toBe('a');
    act(() => {
      result.current.setTab('b');
    });
    const params = new URLSearchParams(result.current.search);
    expect(params.get('view')).toBe('b');
    expect(params.get('page')).toBeNull();
    expect(params.get('sort')).toBeNull();
    expect(params.get('keep')).toBe('1');
    expect(params.get('tab')).toBeNull();
  });
});
