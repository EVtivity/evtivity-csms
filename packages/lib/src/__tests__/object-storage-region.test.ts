// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { S3_COMPATIBLE_DEFAULT_REGION, effectiveStorageRegion } from '../object-storage-region.js';

describe('effectiveStorageRegion', () => {
  it('uses the stored region, trimmed, for both providers', () => {
    expect(effectiveStorageRegion('s3', ' eu-west-1 ')).toBe('eu-west-1');
    expect(effectiveStorageRegion('s3-compatible', 'eu-central-1')).toBe('eu-central-1');
  });

  it('defaults an empty region to us-east-1 for an S3-compatible provider', () => {
    expect(S3_COMPATIBLE_DEFAULT_REGION).toBe('us-east-1');
    expect(effectiveStorageRegion('s3-compatible', '')).toBe('us-east-1');
    expect(effectiveStorageRegion('s3-compatible', '   ')).toBe('us-east-1');
    expect(effectiveStorageRegion('s3-compatible', undefined)).toBe('us-east-1');
  });

  it('always uses auto for Cloudflare R2', () => {
    expect(effectiveStorageRegion('r2', '')).toBe('auto');
    expect(effectiveStorageRegion('r2', undefined)).toBe('auto');
    expect(effectiveStorageRegion('r2', 'eu-west-1')).toBe('auto');
  });

  it('gives no region for AWS S3 or an unset provider without one', () => {
    expect(effectiveStorageRegion('s3', '')).toBeNull();
    expect(effectiveStorageRegion(undefined, undefined)).toBeNull();
    expect(effectiveStorageRegion('s3', 42)).toBeNull();
  });
});
