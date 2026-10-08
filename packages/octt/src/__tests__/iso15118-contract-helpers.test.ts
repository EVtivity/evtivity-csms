// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { StepResult, TestContext } from '../types.js';

const create = vi.hoisted(() =>
  vi.fn((edition: number) =>
    Promise.resolve({
      edition,
      pcid: 'PCID0123456789ABCD',
      oemRoot: { toString: () => 'OEM-ROOT-PEM' },
    }),
  ),
);
vi.mock('@evtivity/css/iso15118-test-ev', () => ({ TestEv: { create } }));

const { setUpContracts, skippedContractTest, pushResponseSteps } =
  await import('../iso15118-contract-helpers.js');

type Reply = { status: number; body: Record<string, unknown> };

function ctxWith(
  handler: ((method: string, path: string, body?: unknown) => Reply) | null,
  testDriverId: string | null = 'drv_1',
): { ctx: TestContext; calls: Array<[string, string, unknown]> } {
  const calls: Array<[string, string, unknown]> = [];
  const callApi = (method: string, path: string, body?: unknown): Promise<Reply> => {
    calls.push([method, path, body]);
    return Promise.resolve(handler?.(method, path, body) ?? { status: 200, body: {} });
  };
  return {
    calls,
    ctx: {
      client: {} as TestContext['client'],
      stationId: 'OCTT-1',
      tokens: {} as TestContext['tokens'],
      stationDbId: 'sta_1',
      logger: pino({ level: 'silent' }),
      config: { serverUrl: 'ws://x' },
      ...(handler != null ? { callApi: callApi } : {}),
      ...(testDriverId != null ? { testDriverId } : {}),
    },
  };
}

describe('setUpContracts', () => {
  it('installs the EV OEM root, creates the contracts, and removes the root on cleanup', async () => {
    let n = 0;
    const { ctx, calls } = ctxWith((method, path) => {
      if (path === '/pnc/settings/local-ca') return { status: 200, body: { configured: true } };
      if (method === 'POST' && path === '/pnc/ca-certificates') {
        return { status: 201, body: { id: 31 } };
      }
      if (method === 'POST' && path === '/drivers/drv_1/pnc-contracts') {
        return { status: 201, body: { emaid: `USOCTC${String(++n)}` } };
      }
      return { status: 200, body: {} };
    });
    const setup = await setUpContracts(ctx, 20, 2);
    if (typeof setup === 'string') throw new Error(setup);
    expect(create).toHaveBeenCalledWith(20);
    expect(setup.emaids).toEqual(['USOCTC1', 'USOCTC2']);
    expect(calls[1]).toEqual([
      'POST',
      '/pnc/ca-certificates',
      { certificateType: 'OEMRootCertificate', certificate: 'OEM-ROOT-PEM' },
    ]);
    expect(calls[2]).toEqual([
      'POST',
      '/drivers/drv_1/pnc-contracts',
      { pcid: 'PCID0123456789ABCD' },
    ]);
    await setup.cleanup();
    expect(calls.at(-1)).toEqual(['DELETE', '/pnc/ca-certificates/31', undefined]);
  });

  it('needs the API and a test driver', async () => {
    expect(await setUpContracts(ctxWith(null).ctx, 2, 1)).toContain('Needs the CSMS API');
    expect(
      await setUpContracts(ctxWith(() => ({ status: 200, body: {} }), null).ctx, 2, 1),
    ).toContain('Needs the CSMS API');
  });

  it('needs a local contract CA', async () => {
    const { ctx, calls } = ctxWith(() => ({ status: 200, body: { configured: false } }));
    expect(await setUpContracts(ctx, 2, 1)).toBe('The CSMS has no local contract CA');
    expect(calls).toHaveLength(1);
  });

  it('reports an OEM root the CSMS refused', async () => {
    const { ctx } = ctxWith((_m, path) =>
      path === '/pnc/settings/local-ca'
        ? { status: 200, body: { configured: true } }
        : { status: 400, body: { code: 'INVALID_CERTIFICATE' } },
    );
    expect(await setUpContracts(ctx, 2, 1)).toBe(
      'Could not install the Test System OEM root (400)',
    );
  });

  it('removes the OEM root again when a contract cannot be created', async () => {
    const { ctx, calls } = ctxWith((method, path) => {
      if (path === '/pnc/settings/local-ca') return { status: 200, body: { configured: true } };
      if (path === '/pnc/ca-certificates') return { status: 201, body: { id: 8 } };
      if (path.endsWith('/pnc-contracts')) {
        return { status: 409, body: { code: 'CONTRACT_LIMIT' } };
      }
      return { status: 200, body: {} };
    });
    expect(await setUpContracts(ctx, 2, 3)).toBe(
      'Could not create a contract (409 CONTRACT_LIMIT)',
    );
    expect(calls.at(-1)).toEqual(['DELETE', '/pnc/ca-certificates/8', undefined]);
  });

  it('treats a contract answer without an eMAID as a failure', async () => {
    const { ctx } = ctxWith((_m, path) => {
      if (path === '/pnc/settings/local-ca') return { status: 200, body: { configured: true } };
      if (path === '/pnc/ca-certificates') return { status: 201, body: { id: 8 } };
      return { status: 201, body: {} };
    });
    expect(await setUpContracts(ctx, 2, 1)).toBe('Could not create a contract (201 )');
  });
});

describe('contract test results', () => {
  it('skippedContractTest reports the precondition as skipped', () => {
    expect(skippedContractTest('no CA')).toEqual({
      status: 'skipped',
      durationMs: 0,
      steps: [{ step: 0, description: 'Precondition', status: 'skipped', actual: 'no CA' }],
    });
  });

  it('pushResponseSteps checks status, exiResponse and remainingContracts', () => {
    const steps: StepResult[] = [];
    pushResponseSteps(
      steps,
      4,
      { status: 'Accepted', exiResponse: 'AAAA', remainingContracts: 1 },
      1,
    );
    expect(steps.map((s) => [s.description, s.status])).toEqual([
      ['Get15118EVCertificateResponse status', 'passed'],
      ['exiResponse holds the Base64 encoded CertificateInstallationRes', 'passed'],
      ['remainingContracts', 'passed'],
    ]);
    expect(steps[1]?.actual).toBe('4 characters');
  });

  it('pushResponseSteps fails a rejected answer without exiResponse', () => {
    const steps: StepResult[] = [];
    pushResponseSteps(steps, 2, { status: 'Failed', exiResponse: '', remainingContracts: 0 }, 2);
    expect(steps.map((s) => s.status)).toEqual(['failed', 'failed', 'failed']);
    expect(steps[1]?.actual).toBe('Missing');
    expect(steps[2]?.actual).toBe('remainingContracts = 0');

    const noRemaining: StepResult[] = [];
    pushResponseSteps(noRemaining, 2, { status: 'Accepted', exiResponse: 'x' });
    expect(noRemaining).toHaveLength(2);
  });
});
