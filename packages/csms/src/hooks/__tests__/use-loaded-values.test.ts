// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { isEditedField, useLoadedValues, withoutUntouchedSecrets } from '../use-loaded-values';

interface Values {
  minLength: number;
}

function setup(initial: Values, onReplace?: () => void) {
  return renderHook(({ loaded }: { loaded: Values }) => useLoadedValues(loaded, onReplace), {
    initialProps: { loaded: initial },
  });
}

describe('useLoadedValues', () => {
  it('replaces the values on a reload while the form is clean', () => {
    const onReplace = vi.fn();
    const { result, rerender } = setup({ minLength: 12 }, onReplace);
    rerender({ loaded: { minLength: 20 } });
    expect(result.current[0]).toEqual({ minLength: 20 });
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  it('keeps a dirty edit when the settings reload', () => {
    const onReplace = vi.fn();
    const { result, rerender } = setup({ minLength: 12 }, onReplace);
    act(() => {
      result.current[1]({ minLength: 16 });
    });
    rerender({ loaded: { minLength: 20 } });
    expect(result.current[0]).toEqual({ minLength: 16 });
    expect(onReplace).not.toHaveBeenCalled();
  });

  it('does nothing when the reload brings back its own saved values', () => {
    const onReplace = vi.fn();
    const { result, rerender } = setup({ minLength: 12 }, onReplace);
    act(() => {
      result.current[1]({ minLength: 16 });
    });
    const before = result.current[0];
    rerender({ loaded: { minLength: 16 } });
    expect(result.current[0]).toBe(before);
    expect(onReplace).not.toHaveBeenCalled();
  });

  it('ignores a rerender with equal loaded values', () => {
    const onReplace = vi.fn();
    const { result, rerender } = setup({ minLength: 12 }, onReplace);
    const before = result.current[0];
    rerender({ loaded: { minLength: 12 } });
    expect(result.current[0]).toBe(before);
    expect(onReplace).not.toHaveBeenCalled();
  });

  it('takes the stored form of its own save on the next reload', () => {
    const { result, rerender } = setup({ minLength: 12 });
    act(() => {
      result.current[1]({ minLength: 16 });
    });
    act(() => {
      result.current[2]({ minLength: 16 });
    });
    // The server stored another form of the saved value.
    rerender({ loaded: { minLength: 17 } });
    expect(result.current[0]).toEqual({ minLength: 17 });
    // Clean again: the next reload replaces it.
    rerender({ loaded: { minLength: 18 } });
    expect(result.current[0]).toEqual({ minLength: 18 });
  });

  it('keeps an edit made after its own save', () => {
    const { result, rerender } = setup({ minLength: 12 });
    act(() => {
      result.current[1]({ minLength: 16 });
      result.current[2]({ minLength: 16 });
    });
    act(() => {
      result.current[1]({ minLength: 30 });
    });
    rerender({ loaded: { minLength: 17 } });
    expect(result.current[0]).toEqual({ minLength: 30 });
  });

  it('keeps the loaded values as the base of a dirty form', () => {
    const { result, rerender } = setup({ minLength: 12 });
    act(() => {
      result.current[1]({ minLength: 16 });
    });
    rerender({ loaded: { minLength: 20 } });
    expect(result.current[3]).toEqual({ minLength: 12 });
  });

  it('moves the base with a reload that replaces the values or equals them', () => {
    const { result, rerender } = setup({ minLength: 12 });
    rerender({ loaded: { minLength: 20 } });
    expect(result.current[3]).toEqual({ minLength: 20 });
    act(() => {
      result.current[1]({ minLength: 30 });
    });
    rerender({ loaded: { minLength: 30 } });
    expect(result.current[3]).toEqual({ minLength: 30 });
  });
});

describe('withoutUntouchedSecrets', () => {
  interface Form {
    host: string;
    password: string;
  }

  function form(initial: Form) {
    return renderHook(({ loaded }: { loaded: Form }) => useLoadedValues(loaded), {
      initialProps: { loaded: initial },
    });
  }

  it('leaves out a secret the user did not edit, also after another user rotated it', () => {
    const { result, rerender } = form({ host: 'a', password: 'loaded' });
    act(() => {
      result.current[1]((v) => ({ ...v, host: 'b' }));
    });
    rerender({ loaded: { host: 'a', password: 'rotated' } });
    const [values, , , base] = result.current;
    expect(values.password).toBe('loaded');
    expect(isEditedField(values, base, 'password')).toBe(false);
    expect(withoutUntouchedSecrets(values, base, ['password'])).toEqual({ host: 'b' });
  });

  it('keeps a secret the user edited, an emptied one included', () => {
    const { result } = form({ host: 'a', password: 'loaded' });
    act(() => {
      result.current[1]((v) => ({ ...v, password: 'typed' }));
    });
    expect(withoutUntouchedSecrets(result.current[0], result.current[3], ['password'])).toEqual({
      host: 'a',
      password: 'typed',
    });
    act(() => {
      result.current[1]((v) => ({ ...v, password: '' }));
    });
    expect(withoutUntouchedSecrets(result.current[0], result.current[3], ['password'])).toEqual({
      host: 'a',
      password: '',
    });
  });
});
