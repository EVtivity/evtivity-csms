// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { prefixedId, ID_PARAMS } from '../lib/id-validation.js';

describe('prefixedId', () => {
  it('accepts a valid prefixed nanoid', () => {
    const schema = prefixedId('drv');
    expect(schema.safeParse('drv_v1stgxr8z5jc').success).toBe(true);
  });

  it('rejects wrong prefix', () => {
    const schema = prefixedId('drv');
    expect(schema.safeParse('usr_v1stgxr8z5jc').success).toBe(false);
  });

  it('rejects old UUID format', () => {
    const schema = prefixedId('drv');
    expect(schema.safeParse('00000000-0000-0000-0000-000000000001').success).toBe(false);
  });

  it('rejects wrong length', () => {
    const schema = prefixedId('drv');
    expect(schema.safeParse('drv_abc').success).toBe(false);
  });

  it('rejects uppercase characters', () => {
    const schema = prefixedId('drv');
    expect(schema.safeParse('drv_V1StGXR8Z5jC').success).toBe(false);
  });
});

describe('ID_PARAMS', () => {
  it('has a validator for each nanoid entity', () => {
    expect(ID_PARAMS.driverId.safeParse('drv_v1stgxr8z5jc').success).toBe(true);
    expect(ID_PARAMS.sessionId.safeParse('ses_v1stgxr8z5jc').success).toBe(true);
    expect(ID_PARAMS.stationId.safeParse('sta_v1stgxr8z5jc').success).toBe(true);
  });
});
