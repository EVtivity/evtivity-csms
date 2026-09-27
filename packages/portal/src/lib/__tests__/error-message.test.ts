// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll } from 'vitest';
import i18next, { type TFunction } from 'i18next';
import { ApiError } from '../api';
import { getErrorMessage } from '../error-message';

let t: TFunction;

beforeAll(async () => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    resources: {
      en: {
        translation: {
          errors: {
            unknown: 'Something went wrong',
            RESERVATION_CONFLICT: 'This time slot is already reserved',
          },
          favorites: { removeFailed: 'Could not remove favorite' },
        },
      },
    },
  });
  t = instance.t;
});

describe('getErrorMessage', () => {
  it('returns the translation for a known error code', () => {
    const err = new ApiError(409, { error: 'Conflict', code: 'RESERVATION_CONFLICT' });
    expect(getErrorMessage(err, t)).toBe('This time slot is already reserved');
  });

  it('prefers the code translation over the English body error', () => {
    const err = new ApiError(409, { error: 'English text', code: 'RESERVATION_CONFLICT' });
    expect(getErrorMessage(err, t, 'favorites.removeFailed')).toBe(
      'This time slot is already reserved',
    );
  });

  it('falls back to body.error when the code has no translation', () => {
    const err = new ApiError(400, { error: 'Server said no', code: 'NOT_A_REAL_CODE' });
    expect(getErrorMessage(err, t)).toBe('Server said no');
  });

  it('falls back to body.error when there is no code', () => {
    const err = new ApiError(400, { error: 'Server said no' });
    expect(getErrorMessage(err, t)).toBe('Server said no');
  });

  it('ignores an empty code', () => {
    const err = new ApiError(400, { error: 'Server said no', code: '' });
    expect(getErrorMessage(err, t)).toBe('Server said no');
  });

  it('returns the fallback key when the body is null', () => {
    expect(getErrorMessage(new ApiError(500, null), t, 'favorites.removeFailed')).toBe(
      'Could not remove favorite',
    );
  });

  it('returns the fallback key when the body is not an object', () => {
    expect(getErrorMessage(new ApiError(502, 'Bad Gateway'), t)).toBe('Something went wrong');
  });

  it('returns the fallback key for non-ApiError errors instead of their message', () => {
    expect(getErrorMessage(new TypeError('Failed to fetch'), t)).toBe('Something went wrong');
  });

  it('defaults the fallback to errors.unknown', () => {
    expect(getErrorMessage(undefined, t)).toBe('Something went wrong');
  });
});
