// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it } from 'vitest';
import { loginPathFor, rememberReturnTo, safeReturnTo, takeReturnTo } from '../return-to';

afterEach(() => {
  sessionStorage.clear();
});

describe('login return-to', () => {
  it('accepts same-origin relative paths with query and hash', () => {
    expect(safeReturnTo('/ai/insights/i1')).toBe('/ai/insights/i1');
    expect(safeReturnTo('/sessions?status=active#top')).toBe('/sessions?status=active#top');
  });

  it('refuses anything that could leave the CSMS (no open redirect)', () => {
    for (const bad of [
      'https://evil.example/ai/insights',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      ' /ai/insights',
      '/ai/insights\n//evil.example',
      'ai/insights',
      '',
      null,
      undefined,
    ]) {
      expect(safeReturnTo(bad), String(bad)).toBeNull();
    }
  });

  it('never returns to the sign-in pages or the home page', () => {
    expect(safeReturnTo('/login?returnTo=/x')).toBeNull();
    expect(safeReturnTo('/reset-password')).toBeNull();
    expect(safeReturnTo('/')).toBeNull();
  });

  it('builds the sign-in URL with the page encoded', () => {
    expect(loginPathFor('/ai/insights/i1?x=1')).toBe(
      '/login?returnTo=%2Fai%2Finsights%2Fi1%3Fx%3D1',
    );
    expect(loginPathFor('/')).toBe('/login');
    expect(loginPathFor('//evil.example')).toBe('/login');
  });

  it('remembers a valid returnTo once and checks it again on the way out', () => {
    rememberReturnTo(new URLSearchParams('returnTo=%2Fai%2Finsights%2Fi1'));
    expect(takeReturnTo()).toBe('/ai/insights/i1');
    expect(takeReturnTo()).toBeNull();
    rememberReturnTo(new URLSearchParams('returnTo=https%3A%2F%2Fevil.example'));
    expect(takeReturnTo()).toBeNull();
    sessionStorage.setItem('csms_return_to', '//evil.example');
    expect(takeReturnTo()).toBeNull();
  });
});
