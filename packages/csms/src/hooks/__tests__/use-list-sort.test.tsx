// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { BrowserRouter, useLocation } from 'react-router';
import { useListSort } from '../use-list-sort';

const KEYS = ['name', 'createdAt'] as const;

function setup(initialUrl: string) {
  window.history.replaceState(null, '', initialUrl);
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(BrowserRouter, null, children);
  const { result } = renderHook(
    () => {
      const sort = useListSort(KEYS);
      const location = useLocation();
      return { ...sort, search: location.search };
    },
    { wrapper },
  );
  return result;
}

describe('useListSort', () => {
  it('starts in the default order with no params', () => {
    const result = setup('/sites');
    expect(result.current.sort).toBeNull();
    expect(result.current.params).toEqual({});
  });

  it('cycles ascending, descending, then back to the default order, in the URL', () => {
    const result = setup('/sites?siteId=s1');
    act(() => {
      result.current.toggle('name');
    });
    expect(result.current.sort).toBe('name');
    expect(result.current.order).toBe('asc');
    expect(result.current.params).toEqual({ sort: 'name', order: 'asc' });
    expect(new URLSearchParams(result.current.search).get('siteId')).toBe('s1');

    act(() => {
      result.current.toggle('name');
    });
    expect(result.current.order).toBe('desc');
    expect(result.current.params).toEqual({ sort: 'name', order: 'desc' });

    act(() => {
      result.current.toggle('name');
    });
    expect(result.current.sort).toBeNull();
    const params = new URLSearchParams(result.current.search);
    expect(params.has('sort')).toBe(false);
    expect(params.has('order')).toBe(false);
    expect(params.get('siteId')).toBe('s1');
  });

  it('starts another column ascending', () => {
    const result = setup('/sites?sort=name&order=desc');
    act(() => {
      result.current.toggle('createdAt');
    });
    expect(result.current.params).toEqual({ sort: 'createdAt', order: 'asc' });
  });

  it('reads the sort from a shared link', () => {
    const result = setup('/sites?sort=createdAt&order=desc');
    expect(result.current.sort).toBe('createdAt');
    expect(result.current.order).toBe('desc');
  });

  it('ignores a sort key the table does not offer', () => {
    const result = setup('/sites?sort=password&order=desc');
    expect(result.current.sort).toBeNull();
    expect(result.current.params).toEqual({});
  });

  it('reads an unknown order as ascending', () => {
    const result = setup('/sites?sort=name&order=sideways');
    expect(result.current.params).toEqual({ sort: 'name', order: 'asc' });
  });
});
