// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { ocppSchemaUrl } from '../use-ocpp-schema';

describe('ocppSchemaUrl', () => {
  it('asks for the schema of the station protocol', () => {
    expect(ocppSchemaUrl('Reset', 'ocpp1.6')).toBe('/v1/ocpp/commands/v16/Reset/schema');
    expect(ocppSchemaUrl('Reset', 'ocpp2.0.1')).toBe(
      '/v1/ocpp/commands/v21/Reset/schema?protocol=ocpp2.0.1',
    );
    expect(ocppSchemaUrl('Reset', 'ocpp2.1')).toBe('/v1/ocpp/commands/v21/Reset/schema');
    expect(ocppSchemaUrl('Reset')).toBe('/v1/ocpp/commands/v21/Reset/schema');
  });
});
