// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSimProviderTestBaseUrlCache,
  getSimProviderTestBaseUrl,
  resolveSimProviderTestBaseUrl,
} from '../sim-test-base-url.js';

describe('resolveSimProviderTestBaseUrl', () => {
  it('is off when unset or empty, in any environment', () => {
    expect(resolveSimProviderTestBaseUrl({ NODE_ENV: 'production' })).toBeNull();
    expect(
      resolveSimProviderTestBaseUrl({ NODE_ENV: 'production', SIM_PROVIDER_TEST_BASE_URL: '  ' }),
    ).toBeNull();
  });

  it('accepts an http or https URL in development and test, without trailing slashes', () => {
    expect(
      resolveSimProviderTestBaseUrl({
        NODE_ENV: 'development',
        SIM_PROVIDER_TEST_BASE_URL: 'http://sim-mock:8080//',
      }),
    ).toBe('http://sim-mock:8080');
    expect(
      resolveSimProviderTestBaseUrl({
        NODE_ENV: 'test',
        SIM_PROVIDER_TEST_BASE_URL: 'https://localhost:7112',
      }),
    ).toBe('https://localhost:7112');
  });

  it('refuses a value outside development and test, unset NODE_ENV included', () => {
    for (const NODE_ENV of ['production', 'staging', undefined]) {
      expect(() =>
        resolveSimProviderTestBaseUrl({
          NODE_ENV,
          SIM_PROVIDER_TEST_BASE_URL: 'http://sim-mock:8080',
        }),
      ).toThrow(/NODE_ENV development or test/);
    }
  });

  it('refuses a URL that is not http or https, or carries credentials or a query', () => {
    for (const url of [
      'ftp://sim-mock',
      'sim-mock:8080',
      'not a url',
      'http://user:pass@sim-mock:8080',
      'http://sim-mock:8080/?x=1',
    ]) {
      expect(() =>
        resolveSimProviderTestBaseUrl({ NODE_ENV: 'test', SIM_PROVIDER_TEST_BASE_URL: url }),
      ).toThrow(/SIM_PROVIDER_TEST_BASE_URL must/);
    }
  });
});

describe('getSimProviderTestBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearSimProviderTestBaseUrlCache();
  });

  it('reads process.env once', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SIM_PROVIDER_TEST_BASE_URL', 'http://sim-mock:8080');
    clearSimProviderTestBaseUrlCache();
    expect(getSimProviderTestBaseUrl()).toBe('http://sim-mock:8080');
    vi.stubEnv('SIM_PROVIDER_TEST_BASE_URL', 'http://other:9090');
    expect(getSimProviderTestBaseUrl()).toBe('http://sim-mock:8080');
    clearSimProviderTestBaseUrlCache();
    expect(getSimProviderTestBaseUrl()).toBe('http://other:9090');
  });
});
