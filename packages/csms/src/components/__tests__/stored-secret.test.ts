// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { isHiddenSecret, secretChange } from '../settings/stored-secret';

const SHOWN = { value: 'stored', configured: true };
const HIDDEN = { value: null, configured: true };
const UNSET = { value: null, configured: false };

describe('isHiddenSecret', () => {
  it('is true only for a stored value the GET did not return', () => {
    expect(isHiddenSecret(HIDDEN)).toBe(true);
    expect(isHiddenSecret(SHOWN)).toBe(false);
    expect(isHiddenSecret(UNSET)).toBe(false);
  });
});

describe('secretChange', () => {
  it('sends a shown secret only when it changed, and an emptied one as a clear', () => {
    expect(secretChange('stored', SHOWN, false)).toBeUndefined();
    expect(secretChange(' new ', SHOWN, false)).toBe('new');
    expect(secretChange('', SHOWN, false)).toBe('');
  });

  it('keeps a hidden secret when the field is empty, unless it is removed', () => {
    expect(secretChange('', HIDDEN, false)).toBeUndefined();
    expect(secretChange('  ', HIDDEN, false)).toBeUndefined();
    expect(secretChange('', HIDDEN, true)).toBe('');
    expect(secretChange('new', HIDDEN, false)).toBe('new');
  });

  it('sends a value typed for an unset secret', () => {
    expect(secretChange('', UNSET, false)).toBeUndefined();
    expect(secretChange('new', UNSET, false)).toBe('new');
  });
});
