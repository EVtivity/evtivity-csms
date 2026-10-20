// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The CSMS cases that send signed meter values or certificates (TC_E_11,
// TC_J_04, TC_J_11, TC_M_12 to TC_M_21, 1.6 TC_075): they send real OCMF
// signed values and real certificate data, every message is valid for the
// case's version, and a CSMS answer the case document forbids fails them.

import { describe, it, expect, vi } from 'vitest';
import { verifyOcmfSignature } from '@evtivity/css/signed-meter-values';
import { getTestById } from '../registry.js';
import { ocppSchemaError } from '../ocpp-schema-check.js';
import type { OcppVersion, TestContext, TestResult } from '../types.js';

type Handler = (
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown> | null>;

interface Fake {
  ctx: TestContext;
  sent: Array<{ action: string; payload: Record<string, unknown> }>;
  replies: Array<{ action: string; payload: Record<string, unknown> }>;
}

/**
 * A test context whose CSMS answers each station call with `answer`, and
 * forwards each operator command to the station's handler, after `alter`.
 */
function fakeContext(
  version: OcppVersion,
  answer: (action: string, payload: Record<string, unknown>) => Record<string, unknown>,
  alter: (action: string, body: Record<string, unknown>) => Record<string, unknown> = (_a, b) => b,
): Fake {
  const sent: Fake['sent'] = [];
  const replies: Fake['replies'] = [];
  let handler: Handler | null = null;
  const client = {
    sendCall: vi.fn((action: string, payload: Record<string, unknown>) => {
      sent.push({ action, payload });
      return Promise.resolve(answer(action, payload));
    }),
    setIncomingCallHandler: (h: Handler) => {
      handler = h;
    },
  };
  const ctx = {
    client,
    version,
    stationId: 'OCTT-UNIT-1',
    tokens: { valid: 'OCTTVALID00001' },
    stationDbId: null,
    logger: {},
    config: { serverUrl: '' },
    triggerCommand: async (_v: string, action: string, body: Record<string, unknown>) => {
      // The command route takes stationId; the station receives the rest.
      const payload = Object.fromEntries(
        Object.entries(alter(action, body)).filter(([key]) => key !== 'stationId'),
      );
      const reply = (await handler?.('m1', action, payload)) ?? {};
      replies.push({ action, payload: reply });
      return { status: 'Accepted' };
    },
  } as unknown as TestContext;
  return { ctx, sent, replies };
}

async function run(id: string, version: OcppVersion, fake: Fake): Promise<TestResult> {
  const tc = getTestById(id, version);
  if (tc == null) throw new Error(`${id} ${version} not registered`);
  return tc.execute(fake.ctx);
}

function expectValidMessages(version: OcppVersion, fake: Fake): void {
  for (const { action, payload } of fake.sent) {
    expect(ocppSchemaError(version, action, 'request', payload), action).toBeNull();
  }
  for (const { action, payload } of fake.replies) {
    expect(ocppSchemaError(version, action, 'response', payload), action).toBeNull();
  }
}

function signedValues(payload: Record<string, unknown>): Record<string, unknown>[] {
  const meterValues = (payload['meterValue'] as Record<string, unknown>[] | undefined) ?? [];
  return meterValues.flatMap((mv) =>
    (mv['sampledValue'] as Record<string, unknown>[]).map(
      (sv) => sv['signedMeterValue'] as Record<string, unknown>,
    ),
  );
}

const accepted = (action: string): Record<string, unknown> => {
  if (action === 'BootNotification') {
    return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
  }
  if (action === 'Authorize' || action === 'TransactionEvent') {
    return { idTokenInfo: { status: 'Accepted' } };
  }
  return {};
};

describe.each(['ocpp2.1', 'ocpp2.0.1'] as const)('signed meter value cases on %s', (version) => {
  it.each([
    ['TC_J_04_CSMS', 'Sample.Clock'],
    ['TC_J_11_CSMS', 'Sample.Periodic'],
  ])('%s sends verifiable OCMF values (%s, then Transaction.End)', async (id, context) => {
    const fake = fakeContext(version, (action) =>
      action === 'TransactionEvent' ? {} : accepted(action),
    );
    const result = await run(id, version, fake);
    expect(result.status).toBe('passed');
    expectValidMessages(version, fake);

    const ended = fake.sent.find(
      (m) => m.action === 'TransactionEvent' && m.payload['eventType'] === 'Ended',
    );
    const meterValues = ended?.payload['meterValue'] as Record<string, unknown>[];
    const contexts = meterValues.map(
      (mv) => (mv['sampledValue'] as Record<string, unknown>[])[0]?.['context'],
    );
    expect(contexts).toEqual([context, 'Transaction.End']);
    const values = signedValues(ended?.payload ?? {});
    expect(values).toHaveLength(2);
    for (const v of values) {
      expect(v).toMatchObject({ signingMethod: 'ECDSA-secp256r1-SHA256', encodingMethod: 'OCMF' });
      expect(verifyOcmfSignature(v['signedMeterData'] as string, v['publicKey'] as string)).toBe(
        true,
      );
    }
  });

  it.each(['TC_J_04_CSMS', 'TC_J_11_CSMS'])(
    '%s fails on a TransactionEventResponse that is not valid',
    async (id) => {
      const fake = fakeContext(version, (action) =>
        action === 'TransactionEvent' ? { idTokenInfo: { status: 'Bogus' } } : accepted(action),
      );
      expect((await run(id, version, fake)).status).toBe('failed');
    },
  );

  it('TC_E_11_CSMS starts with a verifiable Transaction.Begin value and needs Accepted', async () => {
    const fake = fakeContext(version, accepted);
    expect((await run('TC_E_11_CSMS', version, fake)).status).toBe('passed');
    expectValidMessages(version, fake);
    const started = fake.sent.find(
      (m) => m.action === 'TransactionEvent' && m.payload['eventType'] === 'Started',
    );
    const [value] = signedValues(started?.payload ?? {});
    expect(
      verifyOcmfSignature(value?.['signedMeterData'] as string, value?.['publicKey'] as string),
    ).toBe(true);

    // Step 6: idTokenInfo.status must be Accepted; a response without it fails.
    const noInfo = fakeContext(version, (action) =>
      action === 'TransactionEvent' ? {} : accepted(action),
    );
    expect((await run('TC_E_11_CSMS', version, noInfo)).status).toBe('failed');
  });
});

describe('certificate cases', () => {
  it.each(['TC_M_12_CSMS', 'TC_M_15_CSMS', 'TC_M_18_CSMS'])(
    '%s reports real certificate hash data',
    async (id) => {
      const fake = fakeContext('ocpp2.1', accepted);
      expect((await run(id, 'ocpp2.1', fake)).status).toBe('passed');
      expectValidMessages('ocpp2.1', fake);
      const chain = fake.replies[0]?.payload['certificateHashDataChain'] as Record<
        string,
        Record<string, string>
      >[];
      for (const entry of chain) {
        expect(entry['certificateHashData']?.['issuerNameHash']).toMatch(/^[0-9a-f]{64}$/);
        expect(entry['certificateHashData']?.['issuerKeyHash']).toMatch(/^[0-9a-f]{64}$/);
      }
    },
  );

  it('TC_M_20_CSMS deletes with the returned hash data of each algorithm', async () => {
    const fake = fakeContext('ocpp2.1', accepted);
    const result = await run('TC_M_20_CSMS', 'ocpp2.1', fake);
    expect(result.status).toBe('passed');
    expect(result.steps).toHaveLength(6);
    expectValidMessages('ocpp2.1', fake);
    const algorithms = fake.replies
      .filter((r) => r.action === 'GetInstalledCertificateIds')
      .map(
        (r) =>
          (r.payload['certificateHashDataChain'] as Record<string, Record<string, string>>[])[0]?.[
            'certificateHashData'
          ]?.['hashAlgorithm'],
      );
    expect(algorithms).toEqual(['SHA256', 'SHA384', 'SHA512']);
  });

  it('TC_M_20_CSMS fails when the DeleteCertificateRequest names another certificate', async () => {
    const fake = fakeContext('ocpp2.1', accepted, (action, body) =>
      action === 'DeleteCertificate'
        ? {
            ...body,
            certificateHashData: {
              ...(body['certificateHashData'] as Record<string, unknown>),
              serialNumber: '1',
            },
          }
        : body,
    );
    expect((await run('TC_M_20_CSMS', 'ocpp2.1', fake)).status).toBe('failed');
  });

  it.each(['TC_075_1_CSMS', 'TC_075_2_CSMS'])(
    '%s installs a real root certificate and reports its hash data',
    async (id) => {
      const fake = fakeContext('ocpp1.6', () => ({
        currentTime: new Date().toISOString(),
        interval: 300,
        status: 'Accepted',
      }));
      expect((await run(id, 'ocpp1.6', fake)).status).toBe('passed');
      expectValidMessages('ocpp1.6', fake);

      const altered = fakeContext(
        'ocpp1.6',
        () => ({ currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' }),
        (action, body) =>
          action === 'InstallCertificate' ? { ...body, certificate: 'not the root' } : body,
      );
      expect((await run(id, 'ocpp1.6', altered)).status).toBe('failed');
    },
  );
});
