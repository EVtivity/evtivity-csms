// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach } from 'vitest';
import { loginPathFor, rememberReturnPath, safeReturnPath, takeReturnPath } from '../return-path';

beforeEach(() => {
  sessionStorage.clear();
});

describe('sign-in return path', () => {
  it('takes only a path of this portal', () => {
    expect(safeReturnPath('/charge/EM4/6?unit=unt_1')).toBe('/charge/EM4/6?unit=unt_1');
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'charge',
      '',
      null,
      '/a\nb',
    ]) {
      expect(safeReturnPath(bad)).toBeNull();
    }
  });

  it('builds the sign-in link with the encoded path, or plain sign-in', () => {
    expect(loginPathFor('/charge/EM4/6')).toBe('/login?next=%2Fcharge%2FEM4%2F6');
    expect(loginPathFor('//evil.example')).toBe('/login');
  });

  it('keeps the path across the sign-in steps and reads it once', () => {
    rememberReturnPath('/charge/EM4/6');
    expect(takeReturnPath()).toBe('/charge/EM4/6');
    expect(takeReturnPath()).toBeNull();
    rememberReturnPath('//evil.example');
    expect(takeReturnPath()).toBeNull();
  });
});
