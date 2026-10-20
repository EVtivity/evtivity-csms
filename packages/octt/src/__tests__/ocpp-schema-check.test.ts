// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  assertOcppSchemasAvailable,
  compiledSchemaCount,
  ocppSchemaError,
} from '../ocpp-schema-check.js';

describe('ocppSchemaError on OCPP 2.0.1', () => {
  it('accepts a valid 2.0.1 request and response', () => {
    expect(ocppSchemaError('ocpp2.0.1', 'Reset', 'request', { type: 'Immediate' })).toBeNull();
    expect(
      ocppSchemaError('ocpp2.0.1', 'BootNotification', 'response', {
        currentTime: new Date().toISOString(),
        interval: 300,
        status: 'Accepted',
      }),
    ).toBeNull();
  });

  it('refuses an action 2.0.1 does not define', () => {
    expect(ocppSchemaError('ocpp2.0.1', 'SetDefaultTariff', 'request', {})).toBe(
      'SetDefaultTariff is not defined in OCPP 2.0.1',
    );
  });

  it('names a 2.1-only field, a 2.1-only value and a wrong type', () => {
    expect(
      ocppSchemaError('ocpp2.0.1', 'TransactionEvent', 'response', {
        transactionLimit: { maxCost: 1 },
      }),
    ).toMatch(/must NOT have additional properties \(transactionLimit\)/);
    expect(
      ocppSchemaError('ocpp2.0.1', 'Reset', 'request', { type: 'ImmediateAndResume' }),
    ).toMatch(
      /\/type must be equal to one of the allowed values \(\["Immediate","OnIdle"\], got "ImmediateAndResume"\)/,
    );
    expect(
      ocppSchemaError('ocpp2.0.1', 'GetChargingProfiles', 'request', {
        requestId: 1,
        chargingProfile: { chargingProfileId: 1 },
      }),
    ).toMatch(/\/chargingProfile\/chargingProfileId must be array/);
  });

  it('checks formats such as date-time', () => {
    expect(
      ocppSchemaError('ocpp2.0.1', 'Heartbeat', 'response', { currentTime: 'yesterday' }),
    ).toMatch(/\/currentTime must match format "date-time"/);
  });
});

describe('ocppSchemaError on OCPP 2.1', () => {
  it('accepts a 2.1-only action and field', () => {
    expect(
      ocppSchemaError('ocpp2.1', 'Reset', 'request', { type: 'ImmediateAndResume' }),
    ).toBeNull();
    expect(
      ocppSchemaError('ocpp2.1', 'TransactionEvent', 'response', {
        transactionLimit: { maxCost: 1 },
      }),
    ).toBeNull();
  });

  it('refuses an unknown field and an action 2.1 does not define', () => {
    expect(ocppSchemaError('ocpp2.1', 'Reset', 'request', { type: 'Immediate', x: 1 })).toBe(
      'Reset request fails the OCPP 2.1 schema: / must NOT have additional properties (x)',
    );
    expect(ocppSchemaError('ocpp2.1', 'RemoteStartTransaction', 'request', {})).toBe(
      'RemoteStartTransaction is not defined in OCPP 2.1',
    );
  });
});

describe('ocppSchemaError on OCPP 1.6', () => {
  it('reads the 1.6 request schema from <Action>.json and the response from <Action>Response.json', () => {
    expect(
      ocppSchemaError('ocpp1.6', 'RemoteStartTransaction', 'request', { idTag: 'A' }),
    ).toBeNull();
    expect(
      ocppSchemaError('ocpp1.6', 'RemoteStartTransaction', 'response', { status: 'Accepted' }),
    ).toBeNull();
    expect(ocppSchemaError('ocpp1.6', 'RemoteStartTransaction', 'request', {})).toMatch(
      /^RemoteStartTransaction request fails the OCPP 1.6 schema: \/ must have required property 'idTag'/,
    );
    expect(
      ocppSchemaError('ocpp1.6', 'RemoteStartTransaction', 'response', { status: 'Maybe' }),
    ).toMatch(/\/status must be equal to one of the allowed values/);
  });

  it('refuses a 2.x action', () => {
    expect(ocppSchemaError('ocpp1.6', 'RequestStartTransaction', 'request', {})).toBe(
      'RequestStartTransaction is not defined in OCPP 1.6',
    );
  });
});

describe('assertOcppSchemasAvailable', () => {
  it('passes when the checkout has the schemas of every version', () => {
    expect(() => {
      assertOcppSchemasAvailable(['ocpp2.1', 'ocpp2.0.1', 'ocpp1.6']);
    }).not.toThrow();
  });
});

describe('schema cache', () => {
  it('caches a found schema once and never an action without a schema', () => {
    ocppSchemaError('ocpp2.1', 'Heartbeat', 'request', {});
    const size = compiledSchemaCount();
    ocppSchemaError('ocpp2.1', 'Heartbeat', 'request', {});
    expect(compiledSchemaCount()).toBe(size);

    for (let i = 0; i < 50; i++) {
      expect(ocppSchemaError('ocpp2.1', `Unknown${String(i)}`, 'request', {})).toBe(
        `Unknown${String(i)} is not defined in OCPP 2.1`,
      );
    }
    expect(compiledSchemaCount()).toBe(size);
  });
});
