// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  TC_B_08_CSMS,
  waitForItemsPerMessageStored,
} from '../tests/v2_1/csms/B-provisioning/TC_B_08_CSMS.js';
import type { TestContext } from '../types.js';

type IncomingHandler = (
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * Simulated CSMS. NotifyReport is answered immediately, but the reported
 * ItemsPerMessage is stored only after `pollsUntilStored` variable reads, the
 * way the CSMS event projection persists the report after the response. The
 * GetVariables trigger reads the stored limit at call time and splits the
 * request like the API route does (no limit known: one request).
 */
function makeCsms(opts: { pollsUntilStored: number; honorLimit?: boolean }) {
  let handler: IncomingHandler | null = null;
  let reported: Record<string, unknown>[] = [];
  let stored: { component: string; variable: string; value: string }[] = [];
  let polls = 0;
  const events: string[] = [];

  const client = {
    sendCall: vi.fn((action: string, payload: Record<string, unknown>) => {
      if (action === 'NotifyReport') {
        reported = payload['reportData'] as Record<string, unknown>[];
      }
      return Promise.resolve({});
    }),
    setIncomingCallHandler: vi.fn((h: IncomingHandler) => {
      handler = h;
    }),
  };

  const callApi = vi.fn((method: string, path: string) => {
    if (method === 'GET' && path.includes('/variables')) {
      polls++;
      events.push('poll');
      if (polls >= opts.pollsUntilStored && stored.length === 0) {
        stored = reported.map((r) => {
          const attrs = r['variableAttribute'] as { value: string }[];
          return {
            component: (r['component'] as { name: string }).name,
            variable: (r['variable'] as { name: string }).name,
            value: attrs[0]?.value ?? '',
          };
        });
        events.push('stored');
      }
      return Promise.resolve({ status: 200, body: { data: stored, total: stored.length } });
    }
    return Promise.resolve({ status: 404, body: {} });
  });

  const triggerCommand = vi.fn(
    async (_version: string, _action: string, body: Record<string, unknown>) => {
      events.push('trigger');
      const items = body['getVariableData'] as unknown[];
      const row = stored.find(
        (s) => s.component === 'DeviceDataCtrlr' && s.variable === 'ItemsPerMessage',
      );
      const limit =
        opts.honorLimit === false || row == null ? items.length : parseInt(row.value, 10);
      for (let i = 0; i < items.length; i += limit) {
        if (handler == null) throw new Error('no incoming handler');
        await handler('msg', 'GetVariables', { getVariableData: items.slice(i, i + limit) });
      }
      return { status: 'accepted' };
    },
  );

  const ctx = {
    client,
    stationId: 'OCTT-B08',
    stationDbId: 'sta_b08',
    tokens: {},
    logger: pino({ level: 'silent' }),
    config: { serverUrl: 'ws://csms' },
    triggerCommand,
    callApi,
  } as unknown as TestContext;

  return { ctx, events, triggerCommand };
}

describe('TC_B_08_CSMS', () => {
  it('waits for the CSMS to store ItemsPerMessage before requesting variables', async () => {
    // The report is stored on the third read. A fixed delay would have sent
    // the request before that, when the CSMS still knows no limit.
    const { ctx, events } = makeCsms({ pollsUntilStored: 3 });

    const result = await TC_B_08_CSMS.execute(ctx);

    expect(events).toEqual(['poll', 'poll', 'poll', 'stored', 'trigger']);
    expect(result.status).toBe('passed');
    expect(result.steps[1]?.actual).toBe('Request sizes: 4, 1');
  });

  it('requests the five variables of the OCTT scenario', async () => {
    const { ctx, triggerCommand } = makeCsms({ pollsUntilStored: 1 });

    await TC_B_08_CSMS.execute(ctx);

    const body = triggerCommand.mock.calls[0]?.[2] as { getVariableData: unknown[] };
    expect(body.getVariableData).toEqual([
      {
        component: { name: 'DeviceDataCtrlr' },
        variable: { name: 'ItemsPerMessage', instance: 'GetReport' },
      },
      {
        component: { name: 'DeviceDataCtrlr' },
        variable: { name: 'ItemsPerMessage', instance: 'GetVariables' },
      },
      {
        component: { name: 'DeviceDataCtrlr' },
        variable: { name: 'BytesPerMessage', instance: 'GetReport' },
      },
      {
        component: { name: 'DeviceDataCtrlr' },
        variable: { name: 'BytesPerMessage', instance: 'GetVariables' },
      },
      { component: { name: 'AuthCtrlr' }, variable: { name: 'AuthorizeRemoteStart' } },
    ]);
  });

  it('fails when the CSMS exceeds the reported limit', async () => {
    const { ctx } = makeCsms({ pollsUntilStored: 1, honorLimit: false });

    const result = await TC_B_08_CSMS.execute(ctx);

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.status).toBe('failed');
    expect(result.steps[1]).toMatchObject({ status: 'failed', actual: 'Request sizes: 5' });
  });
});

describe('waitForItemsPerMessageStored', () => {
  it('returns false when the CSMS never stores the limit', async () => {
    const { ctx } = makeCsms({ pollsUntilStored: Number.POSITIVE_INFINITY });

    await expect(waitForItemsPerMessageStored(ctx, 30, 5)).resolves.toBe(false);
  });

  it('returns false without an API client', async () => {
    const { ctx } = makeCsms({ pollsUntilStored: 1 });

    await expect(waitForItemsPerMessageStored({ ...ctx, callApi: undefined })).resolves.toBe(false);
  });
});
