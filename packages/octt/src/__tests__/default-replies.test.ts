// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { Ajv } from 'ajv';
import { DEFAULT_REPLY_ACTIONS, defaultReply } from '../default-replies.js';
import type { OcppVersion } from '../types.js';

// The default replies carry no formatted strings (date-time, uri).
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateSchema: false,
  validateFormats: false,
});

const SCHEMA_DIRS: Record<OcppVersion, string> = {
  'ocpp1.6': '../../../../schemas/ocpp-1.6/',
  'ocpp2.1': '../../../../schemas/ocpp-2.1/',
};

function responseSchema(version: OcppVersion, action: string): Record<string, unknown> {
  const url = new URL(`${SCHEMA_DIRS[version]}${action}Response.json`, import.meta.url);
  const schema = JSON.parse(readFileSync(url, 'utf-8')) as Record<string, unknown>;
  // Compiled without the meta-schema reference and id (draft-04 and draft-06 files).
  delete schema['$schema'];
  delete schema['$id'];
  delete schema['id'];
  return schema;
}

/** Requests as the CSMS sends them, for the actions whose reply echoes the request. */
const REQUESTS: Record<string, Record<string, unknown>> = {
  SetVariables: {
    setVariableData: [
      {
        attributeValue: '60',
        component: { name: 'WebPaymentsCtrlr' },
        variable: { name: 'ValidityTime' },
      },
      {
        attributeType: 'Actual',
        attributeValue: 'true',
        component: { name: 'AuthCtrlr', evse: { id: 1 } },
        variable: { name: 'Enabled' },
      },
    ],
  },
  GetVariables: {
    getVariableData: [
      { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'NetworkConfigurationPriority' } },
    ],
  },
  ClearVariableMonitoring: { id: [3, 7] },
  GetConfiguration: { key: ['HeartbeatInterval', 'AuthorizationKey'] },
};

describe('defaultReply', () => {
  for (const version of ['ocpp2.1', 'ocpp1.6'] as const) {
    for (const action of DEFAULT_REPLY_ACTIONS[version]) {
      it(`${version} ${action} is valid against ${action}Response.json`, async () => {
        const validate = ajv.compile(responseSchema(version, action));
        const reply = await defaultReply(version, action, REQUESTS[action] ?? {});
        expect(validate(reply), JSON.stringify(validate.errors)).toBe(true);
      });
    }
  }

  it('rejects the replies test handlers used to fall back to (the check is real)', () => {
    expect(ajv.compile(responseSchema('ocpp2.1', 'SetVariables'))({ status: 'NotSupported' })).toBe(
      false,
    );
    expect(ajv.compile(responseSchema('ocpp2.1', 'SetDisplayMessage'))({})).toBe(false);
    expect(ajv.compile(responseSchema('ocpp1.6', 'RemoteStopTransaction'))({})).toBe(false);
  });

  it('answers one result per SetVariables item, echoing component and variable', async () => {
    const reply = await defaultReply('ocpp2.1', 'SetVariables', REQUESTS['SetVariables'] ?? {});
    expect(reply['setVariableResult']).toEqual([
      {
        attributeStatus: 'Accepted',
        component: { name: 'WebPaymentsCtrlr' },
        variable: { name: 'ValidityTime' },
      },
      {
        attributeType: 'Actual',
        attributeStatus: 'Accepted',
        component: { name: 'AuthCtrlr', evse: { id: 1 } },
        variable: { name: 'Enabled' },
      },
    ]);
  });

  it('reports the requested 1.6 configuration keys as unknown', async () => {
    const reply = await defaultReply(
      'ocpp1.6',
      'GetConfiguration',
      REQUESTS['GetConfiguration'] ?? {},
    );
    expect(reply).toEqual({
      configurationKey: [],
      unknownKey: ['HeartbeatInterval', 'AuthorizationKey'],
    });
  });

  it('answers an action without a default with the CALLERROR NotImplemented', async () => {
    await expect(defaultReply('ocpp2.1', 'SetDERControl', {})).rejects.toThrow('NotImplemented');
    // Version specific: RemoteStartTransaction is 1.6 only.
    await expect(defaultReply('ocpp2.1', 'RemoteStartTransaction', {})).rejects.toThrow(
      'NotImplemented',
    );
  });
});
