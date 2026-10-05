// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendOcppCommandAndWaitMock, selectState } = vi.hoisted(() => ({
  sendOcppCommandAndWaitMock: vi.fn(),
  selectState: { idx: 0, failPushUpdateOnce: false },
}));

vi.mock('@evtivity/services/ocpp-command', () => ({
  sendOcppCommandAndWait: sendOcppCommandAndWaitMock,
}));

// Record every db.update().set(...).where(...) call so we can assert the
// per-station status writes the push pipeline makes.
interface UpdateCall {
  table: string;
  set: Record<string, unknown>;
}
const updateCalls: UpdateCall[] = [];
let lastInsertedPush: { id: string } | null = null;
let templateRow: unknown[] = [];
let targetStationRows: unknown[] = [];

vi.mock('@evtivity/database', () => {
  const makeSelectChain = (rows: () => unknown[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where']) chain[m] = vi.fn(() => chain);
    let awaited = false;
    chain['then'] = (res?: (v: unknown) => unknown, rej?: (r: unknown) => unknown) => {
      if (!awaited) {
        awaited = true;
        return Promise.resolve(rows()).then(res, rej);
      }
      return Promise.resolve([]).then(res, rej);
    };
    return chain;
  };

  return {
    db: {
      select: vi.fn(() => {
        const idx = selectState.idx++;
        // first select -> template, second -> target stations
        return makeSelectChain(() => (idx === 0 ? templateRow : targetStationRows));
      }),
      update: vi.fn((table: { _: { name?: string } } | string) => {
        const tableName =
          typeof table === 'string'
            ? table
            : ((table as { tableName?: string }).tableName ?? 'unknown');
        const setObj: Record<string, unknown> = {};
        const chain: Record<string, unknown> = {
          set: vi.fn((v: Record<string, unknown>) => {
            Object.assign(setObj, v);
            updateCalls.push({ table: tableName, set: setObj });
            return chain;
          }),
          where: vi.fn(() => {
            if (tableName === 'configTemplatePushes' && selectState.failPushUpdateOnce) {
              selectState.failPushUpdateOnce = false;
              return Promise.reject(new Error('push update failed'));
            }
            return Promise.resolve(undefined);
          }),
        };
        return chain;
      }),
      insert: vi.fn(() => {
        const chain: Record<string, unknown> = {
          values: vi.fn(() => chain),
          returning: vi.fn(() => {
            lastInsertedPush = { id: 'ctp_1' };
            return Promise.resolve([lastInsertedPush]);
          }),
        };
        // For configTemplatePushStations insert (no returning) the chain itself
        // must be awaitable.
        let awaited = false;
        chain['then'] = (res?: (v: unknown) => unknown, rej?: (r: unknown) => unknown) => {
          if (!awaited) {
            awaited = true;
            return Promise.resolve(undefined).then(res, rej);
          }
          return Promise.resolve(undefined).then(res, rej);
        };
        return chain;
      }),
    },
    configTemplates: { id: 'id', tableName: 'configTemplates' },
    configTemplatePushes: { id: 'id', tableName: 'configTemplatePushes' },
    configTemplatePushStations: {
      pushId: 'pushId',
      stationId: 'stationId',
      tableName: 'configTemplatePushStations',
    },
    chargingStations: {
      id: 'id',
      stationId: 'stationId',
      isOnline: 'isOnline',
      ocppProtocol: 'ocppProtocol',
      siteId: 'siteId',
    },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
}));

import { processConfigPush, pushTemplateToSiteStations } from '../lib/config-push.js';

beforeEach(() => {
  vi.clearAllMocks();
  updateCalls.length = 0;
  lastInsertedPush = null;
  templateRow = [];
  targetStationRows = [];
  selectState.idx = 0;
  selectState.failPushUpdateOnce = false;
});

const variables = [{ component: 'AuthCtrlr', variable: 'Enabled', value: 'false' }];

function findStationUpdate(): UpdateCall | undefined {
  return updateCalls.find((c) => c.table === 'configTemplatePushStations');
}
function findPushUpdate(): UpdateCall | undefined {
  return updateCalls.find((c) => c.table === 'configTemplatePushes');
}

describe('processConfigPush (OCPP 2.1)', () => {
  it('marks a station accepted on a successful bulk SetVariables and triggers GetBaseReport', async () => {
    sendOcppCommandAndWaitMock
      .mockResolvedValueOnce({
        response: { setVariableResult: [{ attributeStatus: 'Accepted' }] },
      })
      .mockResolvedValueOnce({ response: {} }); // GetBaseReport refresh

    await processConfigPush('ctp_1', [{ id: 'sta_1', stationId: 'CS-1' }], variables, '2.1');

    const stationUpdate = findStationUpdate();
    expect(stationUpdate?.set['status']).toBe('accepted');

    // SetVariables sent in bulk form.
    const firstCall = sendOcppCommandAndWaitMock.mock.calls[0];
    expect(firstCall?.[1]).toBe('SetVariables');
    expect(firstCall?.[2]).toEqual({
      setVariableData: [
        {
          component: { name: 'AuthCtrlr' },
          variable: { name: 'Enabled' },
          attributeValue: 'false',
        },
      ],
    });
    // Refresh command sent.
    expect(sendOcppCommandAndWaitMock.mock.calls[1]?.[1]).toBe('GetBaseReport');
    expect(findPushUpdate()?.set['status']).toBe('completed');
  });

  it('marks a station failed when the command returns an error', async () => {
    sendOcppCommandAndWaitMock.mockResolvedValueOnce({ error: 'No response within 35s' });

    await processConfigPush('ctp_1', [{ id: 'sta_1', stationId: 'CS-1' }], variables, '2.1');

    const stationUpdate = findStationUpdate();
    expect(stationUpdate?.set['status']).toBe('failed');
    expect(stationUpdate?.set['errorInfo']).toBe('No response within 35s');
  });

  it('marks a station rejected when a variable is not Accepted', async () => {
    sendOcppCommandAndWaitMock.mockResolvedValueOnce({
      response: {
        setVariableResult: [
          {
            attributeStatus: 'Rejected',
            component: { name: 'AuthCtrlr' },
            variable: { name: 'Enabled' },
          },
        ],
      },
    });

    await processConfigPush('ctp_1', [{ id: 'sta_1', stationId: 'CS-1' }], variables, '2.1');

    const stationUpdate = findStationUpdate();
    expect(stationUpdate?.set['status']).toBe('rejected');
    expect(stationUpdate?.set['errorInfo']).toBe('AuthCtrlr.Enabled: Rejected');
  });

  it('marks accepted when the 2.1 response has no setVariableResult array', async () => {
    sendOcppCommandAndWaitMock
      .mockResolvedValueOnce({ response: {} }) // setVariableResult undefined -> defaults to []
      .mockResolvedValueOnce({ response: {} }); // refresh
    await processConfigPush('ctp_1', [{ id: 'sta_1', stationId: 'CS-1' }], variables, '2.1');
    expect(findStationUpdate()?.set['status']).toBe('accepted');
  });

  it('renders empty component/variable names in the rejection detail when missing', async () => {
    sendOcppCommandAndWaitMock.mockResolvedValueOnce({
      response: { setVariableResult: [{ attributeStatus: 'Rejected' }] },
    });
    await processConfigPush('ctp_1', [{ id: 'sta_1', stationId: 'CS-1' }], variables, '2.1');
    expect(findStationUpdate()?.set['status']).toBe('rejected');
    expect(findStationUpdate()?.set['errorInfo']).toBe('.: Rejected');
  });

  it('falls back to Unknown when a rejected 2.1 item omits attributeStatus', async () => {
    sendOcppCommandAndWaitMock.mockResolvedValueOnce({
      response: {
        setVariableResult: [{ component: { name: 'C' }, variable: { name: 'V' } }],
      },
    });
    await processConfigPush('ctp_1', [{ id: 'sta_1', stationId: 'CS-1' }], variables, '2.1');
    expect(findStationUpdate()?.set['errorInfo']).toBe('C.V: Unknown');
  });

  it('still marks accepted when the post-push GetBaseReport refresh throws', async () => {
    sendOcppCommandAndWaitMock
      .mockResolvedValueOnce({ response: { setVariableResult: [{ attributeStatus: 'Accepted' }] } })
      .mockRejectedValueOnce(new Error('refresh failed'));

    await processConfigPush('ctp_1', [{ id: 'sta_1', stationId: 'CS-1' }], variables, '2.1');

    expect(findStationUpdate()?.set['status']).toBe('accepted');
    expect(findPushUpdate()?.set['status']).toBe('completed');
  });

  it('marks a station failed when sendOcppCommandAndWait throws', async () => {
    sendOcppCommandAndWaitMock.mockRejectedValueOnce(new Error('boom'));

    await processConfigPush('ctp_1', [{ id: 'sta_1', stationId: 'CS-1' }], variables, '2.1');

    const stationUpdate = findStationUpdate();
    expect(stationUpdate?.set['status']).toBe('failed');
    expect(stationUpdate?.set['errorInfo']).toBe('Internal error');
  });
});

describe('processConfigPush (OCPP 1.6)', () => {
  it('marks accepted when each per-variable SetVariables is Accepted and triggers GetConfiguration', async () => {
    sendOcppCommandAndWaitMock
      .mockResolvedValueOnce({ response: { status: 'Accepted' } }) // SetVariables
      .mockResolvedValueOnce({ response: {} }); // GetConfiguration refresh

    await processConfigPush('ctp_1', [{ id: 'sta_1', stationId: 'CS-1' }], variables, '1.6');

    expect(findStationUpdate()?.set['status']).toBe('accepted');
    // No version: the OCPP server translates SetVariables to ChangeConfiguration
    // for 1.6. With a version the 2.1 action reached the station unchanged.
    expect(sendOcppCommandAndWaitMock.mock.calls[0]?.[1]).toBe('SetVariables');
    expect(sendOcppCommandAndWaitMock.mock.calls[0]).toHaveLength(3);
    expect(sendOcppCommandAndWaitMock.mock.calls[1]?.[1]).toBe('GetConfiguration');
  });

  it('marks rejected and joins per-variable errors when a 1.6 variable is not Accepted', async () => {
    sendOcppCommandAndWaitMock.mockResolvedValueOnce({ response: { status: 'Rejected' } });

    await processConfigPush(
      'ctp_1',
      [{ id: 'sta_1', stationId: 'CS-1' }],
      [{ component: 'C', variable: 'Enabled', value: 'x' }],
      '1.6',
    );

    const stationUpdate = findStationUpdate();
    expect(stationUpdate?.set['status']).toBe('rejected');
    expect(stationUpdate?.set['errorInfo']).toBe('Enabled: Rejected');
  });

  it('collects the command error string for a 1.6 variable', async () => {
    sendOcppCommandAndWaitMock.mockResolvedValueOnce({ error: 'timeout' });

    await processConfigPush(
      'ctp_1',
      [{ id: 'sta_1', stationId: 'CS-1' }],
      [{ component: 'C', variable: 'Enabled', value: 'x' }],
      '1.6',
    );

    expect(findStationUpdate()?.set['errorInfo']).toBe('Enabled: timeout');
  });

  it('reads the 2.1-style setVariableResult status on a 1.6 push when present', async () => {
    sendOcppCommandAndWaitMock
      .mockResolvedValueOnce({ response: { setVariableResult: [{ attributeStatus: 'Accepted' }] } })
      .mockResolvedValueOnce({ response: {} });

    await processConfigPush('ctp_1', [{ id: 'sta_1', stationId: 'CS-1' }], variables, '1.6');

    expect(findStationUpdate()?.set['status']).toBe('accepted');
  });

  it('still marks accepted when the GetConfiguration refresh throws', async () => {
    sendOcppCommandAndWaitMock
      .mockResolvedValueOnce({ response: { status: 'Accepted' } })
      .mockRejectedValueOnce(new Error('refresh failed'));

    await processConfigPush('ctp_1', [{ id: 'sta_1', stationId: 'CS-1' }], variables, '1.6');

    expect(findStationUpdate()?.set['status']).toBe('accepted');
  });

  it('reports Unknown when a 1.6 response has neither a status nor a setVariableResult', async () => {
    sendOcppCommandAndWaitMock.mockResolvedValueOnce({ response: {} });

    await processConfigPush(
      'ctp_1',
      [{ id: 'sta_1', stationId: 'CS-1' }],
      [{ component: 'C', variable: 'Enabled', value: 'x' }],
      '1.6',
    );

    expect(findStationUpdate()?.set['errorInfo']).toBe('Enabled: Unknown');
  });
});

describe('processConfigPush batching', () => {
  it('processes more than the concurrency limit across multiple batches', async () => {
    sendOcppCommandAndWaitMock.mockResolvedValue({
      response: { setVariableResult: [{ attributeStatus: 'Accepted' }] },
    });
    const stations = Array.from({ length: 12 }, (_, i) => ({
      id: `sta_${String(i)}`,
      stationId: `CS-${String(i)}`,
    }));

    await processConfigPush('ctp_1', stations, variables, '2.1');

    const acceptedWrites = updateCalls.filter(
      (c) => c.table === 'configTemplatePushStations' && c.set['status'] === 'accepted',
    );
    expect(acceptedWrites.length).toBe(12);
    expect(findPushUpdate()?.set['status']).toBe('completed');
  });

  it('retries the completed-mark via the outer catch when the first push update throws', async () => {
    sendOcppCommandAndWaitMock.mockResolvedValue({
      response: { setVariableResult: [{ attributeStatus: 'Accepted' }] },
    });
    selectState.failPushUpdateOnce = true;

    await expect(
      processConfigPush('ctp_1', [{ id: 'sta_1', stationId: 'CS-1' }], variables, '2.1'),
    ).resolves.toBeUndefined();

    // Two completed-mark attempts: the failing one and the retry in the catch.
    const pushWrites = updateCalls.filter(
      (c) => c.table === 'configTemplatePushes' && c.set['status'] === 'completed',
    );
    expect(pushWrites.length).toBe(2);
  });
});

describe('pushTemplateToSiteStations', () => {
  it('returns empty string when the template is not found', async () => {
    templateRow = [];
    const result = await pushTemplateToSiteStations('ctm_missing', 'sit_1');
    expect(result).toBe('');
  });

  it('returns empty string when the template has no variables', async () => {
    templateRow = [{ id: 'ctm_1', ocppVersion: '2.1', variables: [] }];
    const result = await pushTemplateToSiteStations('ctm_1', 'sit_1');
    expect(result).toBe('');
  });

  it('returns empty string when no online stations match the site/protocol', async () => {
    templateRow = [{ id: 'ctm_1', ocppVersion: '2.1', variables }];
    targetStationRows = [];
    const result = await pushTemplateToSiteStations('ctm_1', 'sit_1');
    expect(result).toBe('');
  });

  it('creates a push row and inserts per-station rows for matching stations', async () => {
    templateRow = [{ id: 'ctm_1', ocppVersion: '2.1', variables }];
    targetStationRows = [{ id: 'sta_1', stationId: 'CS-1' }];
    sendOcppCommandAndWaitMock.mockResolvedValue({
      response: { setVariableResult: [{ attributeStatus: 'Accepted' }] },
    });

    const result = await pushTemplateToSiteStations('ctm_1', 'sit_1');
    expect(result).toBe('ctp_1');
  });
});
