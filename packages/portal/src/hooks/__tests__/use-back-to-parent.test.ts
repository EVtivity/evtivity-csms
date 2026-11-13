// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it } from 'vitest';
import { cameFrom, fromParent, isVisitStart } from '../use-back-to-parent';

afterEach(() => {
  window.history.replaceState(null, '');
});

describe('isVisitStart', () => {
  it('reads the BrowserRouter entry index, which survives a reload', () => {
    window.history.replaceState({ idx: 0, key: 'abc', usr: null }, '');
    expect(isVisitStart({ key: 'abc', state: null })).toBe(true);
    window.history.replaceState({ idx: 3, key: 'def', usr: null }, '');
    // After a reload React Router keys the entry 'default', yet it is not the
    // first page of the visit: the index decides.
    expect(isVisitStart({ key: 'default', state: null })).toBe(false);
  });

  it('falls back to the first entry key without an index (MemoryRouter)', () => {
    expect(isVisitStart({ key: 'default', state: null })).toBe(true);
    expect(isVisitStart({ key: 'x1', state: null })).toBe(false);
  });

  it('counts a page that replaced the first entry', () => {
    window.history.replaceState({ idx: 2, key: 'k', usr: null }, '');
    expect(isVisitStart({ key: 'k', state: { visitStart: true } })).toBe(true);
  });
});

describe('fromParent and cameFrom', () => {
  it('marks a link from the list and recognizes only that list', () => {
    const { state } = fromParent('/support');
    expect(cameFrom(state, '/support')).toBe(true);
    expect(cameFrom(state, '/sessions')).toBe(false);
    expect(cameFrom(null, '/support')).toBe(false);
    expect(cameFrom('x', '/support')).toBe(false);
  });
});
