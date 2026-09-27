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
            unknown: 'An unexpected error occurred',
            STATION_NOT_FOUND: 'Station not found',
          },
          stations: { uploadFailed: 'Image upload failed' },
        },
      },
    },
  });
  t = instance.t;
});

describe('getErrorMessage', () => {
  it('returns the translation for a known error code', () => {
    const err = new ApiError(404, { error: 'English text', code: 'STATION_NOT_FOUND' });
    expect(getErrorMessage(err, t)).toBe('Station not found');
  });

  it('falls back to body.error when the code has no translation', () => {
    const err = new ApiError(400, { error: 'Server said no', code: 'NOT_A_REAL_CODE' });
    expect(getErrorMessage(err, t)).toBe('Server said no');
  });

  it('falls back to body.error when there is no code', () => {
    expect(getErrorMessage(new ApiError(400, { error: 'Server said no' }), t)).toBe(
      'Server said no',
    );
  });

  it('returns errors.unknown instead of "API error N" when the body is null', () => {
    expect(getErrorMessage(new ApiError(400, null), t)).toBe('An unexpected error occurred');
  });

  it('returns errors.unknown instead of "API error N" when the body is not an object', () => {
    expect(getErrorMessage(new ApiError(502, 'Bad Gateway'), t)).toBe(
      'An unexpected error occurred',
    );
  });

  it('returns errors.unknown when the body has neither code nor error', () => {
    expect(getErrorMessage(new ApiError(500, {}), t)).toBe('An unexpected error occurred');
  });

  it('keeps the message of a plain Error thrown by the caller', () => {
    expect(getErrorMessage(new Error('Reboot rejected: Rejected'), t)).toBe(
      'Reboot rejected: Rejected',
    );
  });

  it('returns the fallback key for an ApiError with no usable body', () => {
    expect(getErrorMessage(new ApiError(500, null), t, 'stations.uploadFailed')).toBe(
      'Image upload failed',
    );
  });

  it('returns the fallback key for a network failure instead of "Failed to fetch"', () => {
    expect(getErrorMessage(new TypeError('Failed to fetch'), t, 'stations.uploadFailed')).toBe(
      'Image upload failed',
    );
  });

  it('returns the fallback key for non-Error values', () => {
    expect(getErrorMessage('boom', t, 'stations.uploadFailed')).toBe('Image upload failed');
  });

  it('returns errors.unknown for non-Error values', () => {
    expect(getErrorMessage('boom', t)).toBe('An unexpected error occurred');
  });
});
