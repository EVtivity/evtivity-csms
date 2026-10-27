// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent, EventBus } from '@evtivity/lib';
import { REDACTED } from '@evtivity/lib/secret-config';
import {
  MESSAGE_LOG_EVENT,
  MESSAGE_LOG_MAX_ERROR_TEXT_LENGTH,
  MESSAGE_LOG_MAX_PAYLOAD_BYTES,
  MESSAGE_LOG_MAX_PENDING_PER_LANE,
  publishMessageLog,
} from '../server/message-log.js';
import { projectionQueueFor } from '../server/projection-queue.js';
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

  it('masks the password of file transfer URLs in both directions and versions', () => {
    const url = 'sftp://logs:UrlSecret99@logs.example.com:22/upload';
    const masked = `sftp://logs:${REDACTED}@logs.example.com:22/upload`;
    const cases: Array<{ action: string; direction: 'inbound' | 'outbound'; payload: unknown }> = [
      // 2.1 GetLog CALL
      {
        action: 'GetLog',
        direction: 'outbound',
        payload: { logType: 'DiagnosticsLog', requestId: 7, log: { remoteLocation: url } },
      },
      // 1.6 GetDiagnostics CALL
      { action: 'GetDiagnostics', direction: 'outbound', payload: { location: url, retries: 1 } },
      // 2.1 and 1.6 signed UpdateFirmware CALL
      {
        action: 'UpdateFirmware',
        direction: 'outbound',
        payload: { requestId: 8, firmware: { location: url, retrieveDateTime: 'now' } },
      },
      {
        action: 'SignedUpdateFirmware',
        direction: 'outbound',
        payload: { requestId: 9, firmware: { location: url, retrieveDateTime: 'now' } },
      },
      // 1.6 UpdateFirmware CALL
      {
        action: 'UpdateFirmware',
        direction: 'outbound',
        payload: { location: url, retrieveDate: 'now' },
      },
      // 2.1 PublishFirmware CALL
      {
        action: 'PublishFirmware',
        direction: 'outbound',
        payload: { location: url, checksum: 'abc', requestId: 10 },
      },
      // A station that echoes the URL in an inbound status
      {
        action: 'LogStatusNotification',
        direction: 'inbound',
        payload: { status: 'UploadFailure', statusInfo: { additionalInfo: `PUT ${url} 403` } },
      },
    ];
    for (const c of cases) {
      const { eventBus, events } = bus();
      publishMessageLog(eventBus, {
        stationId: 'CS-1',
        direction: c.direction,
        messageType: 2,
        messageId: 'm',
        action: c.action,
        payload: c.payload,
      });
      const stored = JSON.stringify(events[0]?.payload);
      expect(stored, c.action).not.toContain('UrlSecret99');
      expect(stored, c.action).toContain(masked);
      // The payload sent to the station is untouched.
      expect(JSON.stringify(c.payload), c.action).toContain(url);
    }
    const { eventBus, events } = bus();
    publishMessageLog(eventBus, {
      stationId: 'CS-1',
      direction: 'inbound',
      messageType: 4,
      messageId: 'm',
      action: 'GetLog',
      errorCode: 'GenericError',
      errorDescription: `cannot reach ${url}`,
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain('UrlSecret99');
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

  it('bounds a CALLERROR errorCode and errorDescription and stores a non-string as text', () => {
    const { eventBus, events } = bus();
    publishMessageLog(eventBus, {
      stationId: 'CS-1',
      direction: 'inbound',
      messageType: 4,
      messageId: 'm5',
      action: null,
      errorCode: { nested: 'x'.repeat(5000) },
      errorDescription: 'd'.repeat(100 * 1024),
    });
    const payload = events[0]?.payload as { errorCode: string; errorDescription: string };
    expect(typeof payload.errorCode).toBe('string');
    expect(payload.errorCode.length).toBeLessThanOrEqual(MESSAGE_LOG_MAX_ERROR_TEXT_LENGTH + 3);
    expect(payload.errorDescription.length).toBeLessThanOrEqual(
      MESSAGE_LOG_MAX_ERROR_TEXT_LENGTH + 3,
    );
    expect(payload.errorDescription.startsWith('ddd')).toBe(true);
  });

  it('publishes a payload over 64 KiB as a truncated marker', () => {
    const { eventBus, events } = bus();
    const big = { data: 'x'.repeat(200 * 1024), other: 1 };
    publishMessageLog(eventBus, {
      stationId: 'CS-BIG',
      direction: 'inbound',
      messageType: 2,
      messageId: 'm-big',
      action: 'DataTransfer',
      payload: big,
    });
    const logged = events[0]?.payload['payload'] as Record<string, unknown>;
    expect(logged).toEqual({
      truncated: true,
      bytes: Buffer.byteLength(JSON.stringify(big)),
      keys: ['data', 'other'],
    });
    expect(JSON.stringify(logged).length).toBeLessThanOrEqual(MESSAGE_LOG_MAX_PAYLOAD_BYTES);
    // A payload under the cap is kept as is.
    publishMessageLog(eventBus, {
      stationId: 'CS-BIG',
      direction: 'inbound',
      messageType: 2,
      messageId: 'm-small',
      action: 'Heartbeat',
      payload: { a: 1 },
    });
    expect(events[1]?.payload['payload']).toEqual({ a: 1 });
  });

  it('drops a log entry while the station lane holds too many log tasks', () => {
    const { eventBus, events } = bus();
    const queue = projectionQueueFor(eventBus);
    const blocked = new Promise<void>(() => undefined);
    for (let i = 0; i < MESSAGE_LOG_MAX_PENDING_PER_LANE; i++) {
      void queue.enqueue('CS-FULL', () => blocked, {
        kind: MESSAGE_LOG_EVENT,
        maxPending: MESSAGE_LOG_MAX_PENDING_PER_LANE,
      });
    }
    const published = publishMessageLog(eventBus, {
      stationId: 'CS-FULL',
      direction: 'inbound',
      messageType: 2,
      messageId: 'm-drop',
      action: 'Heartbeat',
      payload: {},
    });
    expect(published).toBe(false);
    expect(events).toEqual([]);
    // Another station's log still goes out.
    expect(
      publishMessageLog(eventBus, {
        stationId: 'CS-OTHER',
        direction: 'inbound',
        messageType: 2,
        messageId: 'm-ok',
        action: 'Heartbeat',
        payload: {},
      }),
    ).toBe(true);
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
