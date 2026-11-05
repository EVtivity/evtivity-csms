// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  AWS_S3_REGIONS,
  WASABI_REGIONS,
  isR2AccountId,
  parseR2Endpoint,
  providerOfTab,
  r2Endpoint,
  storageTabOf,
  storageTabParam,
  wasabiEndpoint,
  wasabiRegionOf,
} from '../storage-providers';

const ACCOUNT = '0123456789abcdef0123456789abcdef';

// The R2 host rule of validateR2Endpoint (services storage-endpoint.ts).
const API_R2_HOST = /^[0-9a-f]{32}\.(?:(?:eu|fedramp|us)\.)?r2\.cloudflarestorage\.com$/;

describe('storage provider tabs', () => {
  it('maps the stored provider and endpoint to a tab', () => {
    expect(storageTabOf(undefined, '')).toBe('aws');
    expect(storageTabOf('s3', '')).toBe('aws');
    expect(storageTabOf('r2', `https://${ACCOUNT}.r2.cloudflarestorage.com`)).toBe('r2');
    expect(storageTabOf('s3-compatible', 'https://s3.eu-central-2.wasabisys.com')).toBe('wasabi');
    expect(storageTabOf('s3-compatible', 'https://s3.wasabisys.com')).toBe('wasabi');
    expect(storageTabOf('s3-compatible', 'http://minio:9000')).toBe('compatible');
    // A Wasabi-looking host on another port or scheme is not a Wasabi service URL.
    expect(storageTabOf('s3-compatible', 'http://s3.us-east-1.wasabisys.com')).toBe('compatible');
    expect(storageTabOf('s3-compatible', 'https://s3.mars-1.wasabisys.com')).toBe('compatible');
  });

  it('saves the API provider value of each tab', () => {
    expect(providerOfTab('aws')).toBe('s3');
    expect(providerOfTab('r2')).toBe('r2');
    expect(providerOfTab('wasabi')).toBe('s3-compatible');
    expect(providerOfTab('compatible')).toBe('s3-compatible');
  });

  it('reads known tab ids only', () => {
    expect(storageTabParam('wasabi')).toBe('wasabi');
    expect(storageTabParam('s3')).toBeNull();
    expect(storageTabParam(null)).toBeNull();
  });
});

describe('Cloudflare R2 S3 API URL', () => {
  it('builds the URL of each jurisdiction that the API accepts', () => {
    for (const jurisdiction of ['default', 'eu', 'fedramp', 'us'] as const) {
      const url = r2Endpoint(` ${ACCOUNT.toUpperCase()} `, jurisdiction);
      expect(API_R2_HOST.test(new URL(url).hostname)).toBe(true);
      expect(parseR2Endpoint(url)).toEqual({ accountId: ACCOUNT, jurisdiction });
    }
    expect(r2Endpoint(ACCOUNT, 'eu')).toBe(`https://${ACCOUNT}.eu.r2.cloudflarestorage.com`);
    expect(r2Endpoint(ACCOUNT, 'us')).toBe(`https://${ACCOUNT}.us.r2.cloudflarestorage.com`);
  });

  it('parses nothing from another URL', () => {
    expect(parseR2Endpoint('https://example.com')).toEqual({
      accountId: '',
      jurisdiction: 'default',
    });
  });

  it('checks the account ID shape', () => {
    expect(isR2AccountId(ACCOUNT)).toBe(true);
    expect(isR2AccountId(ACCOUNT.slice(1))).toBe(false);
    expect(isR2AccountId(`${ACCOUNT.slice(1)}g`)).toBe(false);
  });
});

describe('Wasabi service URLs', () => {
  it('round-trips every region', () => {
    for (const { code } of WASABI_REGIONS) {
      expect(wasabiRegionOf(wasabiEndpoint(code))).toBe(code);
    }
  });

  it('reads the region of the alias service URLs', () => {
    expect(wasabiRegionOf('https://s3.wasabisys.com')).toBe('us-east-1');
    expect(wasabiRegionOf('https://s3.nl-1.wasabisys.com')).toBe('eu-central-1');
    expect(wasabiRegionOf('https://s3.wasabisys.com/bucket')).toBeNull();
  });
});

describe('AWS regions', () => {
  it('lists each region code once', () => {
    const codes = AWS_S3_REGIONS.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain('us-east-1');
  });
});
