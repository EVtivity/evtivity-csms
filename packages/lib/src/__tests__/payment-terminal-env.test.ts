// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  allowsUnverifiedTerminalAdapters,
  resolvePaymentTerminalTestBaseUrl,
} from '../payment-terminal-env.js';

describe('allowsUnverifiedTerminalAdapters', () => {
  it('allows only development and test, unset NODE_ENV included as refused', () => {
    expect(allowsUnverifiedTerminalAdapters({ NODE_ENV: 'development' })).toBe(true);
    expect(allowsUnverifiedTerminalAdapters({ NODE_ENV: 'test' })).toBe(true);
    expect(allowsUnverifiedTerminalAdapters({ NODE_ENV: 'production' })).toBe(false);
    expect(allowsUnverifiedTerminalAdapters({})).toBe(false);
  });
});

describe('resolvePaymentTerminalTestBaseUrl', () => {
  it('is null when unset or blank', () => {
    expect(resolvePaymentTerminalTestBaseUrl({ NODE_ENV: 'production' })).toBeNull();
    expect(
      resolvePaymentTerminalTestBaseUrl({ NODE_ENV: 'test', PAYMENT_TERMINAL_TEST_BASE_URL: '  ' }),
    ).toBeNull();
  });

  it('refuses a set value outside development and test', () => {
    for (const NODE_ENV of ['production', undefined]) {
      expect(() =>
        resolvePaymentTerminalTestBaseUrl({
          NODE_ENV,
          PAYMENT_TERMINAL_TEST_BASE_URL: 'http://terminal-mock:8080',
        }),
      ).toThrow(/needs NODE_ENV development or test/);
    }
  });

  it('refuses anything but a plain http(s) URL', () => {
    for (const url of [
      'ftp://mock',
      'not a url',
      'http://u:p@mock',
      'http://mock?x=1',
      'http://mock#a',
    ]) {
      expect(() =>
        resolvePaymentTerminalTestBaseUrl({
          NODE_ENV: 'test',
          PAYMENT_TERMINAL_TEST_BASE_URL: url,
        }),
      ).toThrow(/PAYMENT_TERMINAL_TEST_BASE_URL must/);
    }
  });

  it('returns the URL without trailing slashes', () => {
    expect(
      resolvePaymentTerminalTestBaseUrl({
        NODE_ENV: 'development',
        PAYMENT_TERMINAL_TEST_BASE_URL: ' https://mock.local:7120/base/// ',
      }),
    ).toBe('https://mock.local:7120/base');
  });
});
