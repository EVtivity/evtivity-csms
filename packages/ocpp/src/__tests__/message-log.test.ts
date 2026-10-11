// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent, EventBus } from '@evtivity/lib';
import { REDACTED } from '@evtivity/lib/secret-config';
import { MESSAGE_LOG_EVENT, publishMessageLog } from '../server/message-log.js';
import { upsertStationConfiguration } from '../server/station-configurations.js';

const PASSWORD = 'SeedStationPass1234';

function bus(): { eventBus: EventBus; events: DomainEvent[] } {
  const events: DomainEvent[] = [];
  const eventBus = {
    publish: (e: DomainEvent) => {
      events.push(e);
      return Promise.resolve();
    },
    subscribe: vi.fn(),
  } as unknown as EventBus;
  return { eventBus, events };
}

describe('OCPP message log credential masking', () => {
  it('masks a 2.1 SetVariables password in the outbound CALL', () => {
    const { eventBus, events } = bus();
    const payload = {
      setVariableData: [
        {
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'BasicAuthPassword' },
          attributeValue: PASSWORD,
        },
      ],
    };
    publishMessageLog(eventBus, {
      stationId: 'CS-1',
      direction: 'outbound',
      messageType: 2,
      messageId: 'm1',
      action: 'SetVariables',
      payload,
    });
    expect(events[0]?.eventType).toBe(MESSAGE_LOG_EVENT);
    expect(JSON.stringify(events[0]?.payload)).not.toContain(PASSWORD);
    expect(JSON.stringify(events[0]?.payload)).toContain(REDACTED);
    // The payload sent to the station is untouched.
    expect(payload.setVariableData[0]?.attributeValue).toBe(PASSWORD);
  });

  it('masks a 1.6 AuthorizationKey and a GetConfiguration CALLRESULT', () => {
    const { eventBus, events } = bus();
    publishMessageLog(eventBus, {
      stationId: 'CS-16',
      direction: 'outbound',
      messageType: 2,
      messageId: 'm2',
      action: 'ChangeConfiguration',
      payload: { key: 'AuthorizationKey', value: '53656564' },
    });
    publishMessageLog(eventBus, {
      stationId: 'CS-16',
      stationDbId: 'sta_1',
      direction: 'inbound',
      messageType: 3,
      messageId: 'm3',
      action: null,
      payload: { configurationKey: [{ key: 'AuthorizationKey', readonly: false, value: 'ab' }] },
    });
    expect(events.map((e) => JSON.stringify(e.payload))).toEqual([
      expect.stringContaining(`"value":"${REDACTED}"`),
      expect.stringContaining(`"value":"${REDACTED}"`),
    ]);
    expect(events[1]?.payload.stationDbId).toBe('sta_1');
  });

  it('keeps a CALLERROR without a payload', () => {
    const { eventBus, events } = bus();
    publishMessageLog(eventBus, {
      stationId: 'CS-1',
      direction: 'inbound',
      messageType: 4,
      messageId: 'm4',
      action: null,
      errorCode: 'InternalError',
      errorDescription: 'boom',
    });
    expect(events[0]?.payload).toEqual({
      stationId: 'CS-1',
      direction: 'inbound',
      messageType: 4,
      messageId: 'm4',
      action: null,
      errorCode: 'InternalError',
      errorDescription: 'boom',
    });
  });

  it('publishMessageLog is the only publisher of the message log event', () => {
    const root = resolve(import.meta.dirname, '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (!name.startsWith('__')) walk(path);
        } else if (name.endsWith('.ts')) {
          files.push(path);
        }
      }
    };
    walk(root);
    const publishers = files
      .filter((f) => /eventType:\s*['"`]ocpp\.MessageLog/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f));
    expect(publishers).toEqual([]);
  });

  it('stores a reported credential variable as redacted in station_configurations', async () => {
    const values: unknown[][] = [];
    const sql = ((_strings: TemplateStringsArray, ...args: unknown[]) => {
      values.push(args);
      return Promise.resolve([]);
    }) as never;
    const base = {
      stationUuid: 'sta_1',
      component: 'SecurityCtrlr',
      componentInstance: null,
      evseId: null,
      connectorId: null,
      variableInstance: null,
      attributeType: 'Actual',
      source: 'GetVariables' as const,
    };
    await upsertStationConfiguration(sql, {
      ...base,
      variable: 'BasicAuthPassword',
      value: PASSWORD,
    });
    await upsertStationConfiguration(sql, { ...base, variable: 'HeartbeatInterval', value: '300' });
    expect(values[0]).toContain(REDACTED);
    expect(values[0]).not.toContain(PASSWORD);
    expect(values[1]).toContain('300');
  });
});
