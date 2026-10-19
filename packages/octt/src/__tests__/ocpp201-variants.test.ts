// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Runs every OCPP 2.0.1 CSMS case against a fake CSMS and checks what reaches
 * the wire: each command the case has the CSMS send (`triggerCommand` and the
 * generic command route) passes the CSMS's own 2.0.1 command check
 * (`prepareOcpp201Command`, refused commands answer OCPP_VERSION_MISMATCH),
 * each station message and reply passes the test station's 2.0.1 edge without
 * losing a field the case set and validates against the strict 2.0.1 schemas.
 * The fake answers every station message positively and delivers each command
 * to the case's handler, so most cases run their whole scenario; waits on CSMS
 * state end on fake timers.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pino from 'pino';
import { isOcpp21OnlyAction } from '@evtivity/lib/ocpp-version';
import type { CallApiFn, OcppVersion, TestContext, TriggerCommandFn } from '../types.js';
import { TestOcppClient } from '../client.js';
import { getRegistry } from '../registry.js';
import { prepareOcpp201Command } from '../../../ocpp/src/server/ocpp201/to-ocpp201.js';
import {
  ocpp201ActionSchemaEntry,
  ocpp21ActionSchemaEntry,
} from '../../../ocpp/src/server/ocpp-registry.js';

vi.mock('../../../../packages/database/src/config.ts', () => ({ db: {}, client: vi.fn() }));
vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['set', 'where', 'values', 'from', 'limit', 'returning']) {
    chain[m] = () => chain;
  }
  chain['then'] = (resolve?: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
  return {
    db: { update: () => chain, select: () => chain, insert: () => chain, delete: () => chain },
    chargingStations: { id: 'id', stationId: 'station_id' },
  };
});

type Handler = (
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown> | null>;

/** What the run reached: station messages sent and commands delivered, over all cases. */
const reached = { messages: 0, commands: 0, casesWithCommand: new Set<string>() };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function schemaErrors(validate: { errors?: unknown }): string {
  return JSON.stringify(validate.errors ?? []).slice(0, 300);
}

/** Positive CSMS answers, so a case runs on past each station message. */
function csmsResponse(action: string, payload: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  switch (action) {
    case 'BootNotification':
      return { status: 'Accepted', currentTime: now, interval: 300 };
    case 'Heartbeat':
      return { currentTime: now };
    case 'Authorize':
      return { idTokenInfo: { status: 'Accepted' } };
    case 'TransactionEvent':
      return payload['idToken'] != null ? { idTokenInfo: { status: 'Accepted' } } : {};
    case 'NotifyEVChargingNeeds':
    case 'NotifyEVChargingSchedule':
    case 'SignCertificate':
    case 'DataTransfer':
      return { status: 'Accepted' };
    case 'Get15118EVCertificate':
      return { status: 'Accepted', exiResponse: '' };
    case 'GetCertificateStatus':
      return { status: 'Accepted', ocspResult: '' };
    default:
      return {};
  }
}

/** The test station against the fake CSMS: no socket, every message checked. */
class FakeStation extends TestOcppClient {
  readonly violations: string[] = [];
  private handler: Handler | null = null;
  private connectedHandler: (() => void) | null = null;
  private online = true;
  private nextId = 0;

  override get isConnected(): boolean {
    return this.online;
  }

  override connect(): Promise<void> {
    this.online = true;
    return Promise.resolve();
  }

  override disconnect(): void {
    this.online = false;
  }

  override simulateConnectionLoss(): void {
    this.online = true;
    this.connectedHandler?.();
  }

  override updateConnection(): void {}

  override setConnectedHandler(handler: () => void): void {
    this.connectedHandler = handler;
    super.setConnectedHandler(handler);
  }

  override setIncomingCallHandler(handler: Handler): void {
    this.handler = handler;
    super.setIncomingCallHandler(handler);
  }

  override sendCall(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let wire: Record<string, unknown> | null;
    try {
      wire = this.callPayload(action, payload);
    } catch (err) {
      this.violations.push(`station ${action}: ${errorText(err)}`);
      return Promise.reject(err instanceof Error ? err : new Error(errorText(err)));
    }
    if (wire == null) return Promise.resolve({});
    reached.messages++;
    const entry = ocpp201ActionSchemaEntry(action);
    if (entry != null && !entry.validateRequest(wire)) {
      this.violations.push(
        `station ${action}: not valid 2.0.1 (${schemaErrors(entry.validateRequest)})`,
      );
    }
    return Promise.resolve(csmsResponse(action, wire));
  }

  /** The CSMS sends a command the way the OCPP server does to a 2.0.1 station. */
  async deliver(action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'stationId'));
    const entry21 = ocpp21ActionSchemaEntry(action);
    if (entry21 == null) {
      this.violations.push(`command ${action}: unknown action`);
      return { error: 'Unknown OCPP action', code: 'UNKNOWN_ACTION' };
    }
    if (!entry21.validateRequest(payload)) {
      this.violations.push(
        `command ${action}: not valid 2.1 (${schemaErrors(entry21.validateRequest)})`,
      );
      return { error: 'Invalid OCPP payload', code: 'INVALID_PAYLOAD' };
    }
    let wire: Record<string, unknown> = payload;
    if (this.protocol === 'ocpp2.0.1') {
      if (isOcpp21OnlyAction(action)) {
        this.violations.push(`command ${action}: defined in OCPP 2.1 only`);
        return { code: 'OCPP_VERSION_MISMATCH' };
      }
      try {
        wire = prepareOcpp201Command(action, payload);
      } catch (err) {
        this.violations.push(`command ${action}: ${errorText(err)}`);
        return { error: errorText(err), code: 'OCPP_VERSION_MISMATCH' };
      }
    }
    reached.commands++;
    reached.casesWithCommand.add(this.stationId);
    if (this.handler == null) return { status: 'error', error: 'NotImplemented' };
    try {
      const reply = await this.handler(`fake-${String(++this.nextId)}`, action, wire);
      if (reply == null) return { status: 'timeout', code: 'COMMAND_TIMEOUT' };
      const sent = this.callResultPayload(action, reply);
      const entry = ocpp201ActionSchemaEntry(action);
      if (this.protocol === 'ocpp2.0.1' && entry != null && !entry.validateResponse(sent)) {
        this.violations.push(
          `reply ${action}: not valid 2.0.1 (${schemaErrors(entry.validateResponse)})`,
        );
      }
      return { status: 'accepted', response: sent };
    } catch (err) {
      return { status: 'error', code: 'COMMAND_ERROR', error: errorText(err) };
    }
  }
}

function fakeContext(version: OcppVersion, id: string): { ctx: TestContext; station: FakeStation } {
  const stationId = `OCTT-FAKE-${id}`;
  const station = new FakeStation({
    serverUrl: 'ws://127.0.0.1:9',
    stationId,
    ocppProtocol: version,
  });
  const triggerCommand: TriggerCommandFn = (v, action, body) => {
    if (v !== 'v21') station.violations.push(`command ${action}: sent on the ${v} route`);
    return station.deliver(action, body);
  };
  const callApi: CallApiFn = async (method, path, body) => {
    const command = /^\/ocpp\/commands\/v21\/(\w+)$/.exec(path);
    if (method === 'POST' && command?.[1] != null) {
      const res = await station.deliver(command[1], body ?? {});
      return { status: res['code'] == null ? 200 : 400, body: res };
    }
    if (method === 'GET' && /^\/stations\/[^/]+$/.test(path)) {
      return { status: 200, body: { isOnline: true, ocppProtocol: version } };
    }
    return { status: 200, body: {} };
  };
  const ctx: TestContext = {
    client: station,
    version,
    stationId,
    tokens: {
      valid: 'OCTTVALID0000001',
      valid2: 'OCTTVALID0000002',
      masterpass: 'OCTTMASTER000001',
      blocked: 'OCTTBLOCKED00001',
      expired: 'OCTTEXPIRED00001',
      prepaid: 'OCTTPREPAID00001',
      noCredit: 'OCTTNOCREDIT0001',
      emaid: 'USOCTC12345678',
    },
    stationDbId: 'sta_fake',
    logger: pino({ level: 'silent' }),
    config: { serverUrl: 'ws://127.0.0.1:9', provisionStations: false },
    triggerCommand,
    callApi,
    testDriverId: 'drv_fake',
  };
  return { ctx, station };
}

/** Runs a case to its end on fake timers (at most an hour of fake time). */
async function runToEnd(run: Promise<unknown>): Promise<void> {
  const state = { done: false };
  void run.finally(() => {
    state.done = true;
  });
  for (let i = 0; i < 720 && !state.done; i++) {
    await vi.advanceTimersByTimeAsync(5_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const VERSION: OcppVersion = 'ocpp2.0.1';

describe('OCPP 2.0.1 CSMS cases against a fake CSMS', () => {
  beforeAll(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  const cases = getRegistry(VERSION);

  it('covers the 251 cases', () => {
    expect(cases).toHaveLength(251);
  });

  it('catches a 2.1-only command value, a dropped station field and a 2.1-only message', async () => {
    const { ctx, station } = fakeContext(VERSION, 'CHECK');
    ctx.client.setIncomingCallHandler(() => Promise.resolve({ status: 'Accepted' }));
    await ctx.triggerCommand?.('v21', 'TriggerMessage', {
      stationId: ctx.stationId,
      requestedMessage: 'CustomTrigger',
    });
    await ctx.client.sendCall('NotifyEvent', {
      generatedAt: new Date().toISOString(),
      seqNo: 0,
      eventData: [
        {
          eventId: 1,
          timestamp: new Date().toISOString(),
          trigger: 'Delta',
          actualValue: 'Available',
          component: { name: 'Connector' },
          variable: { name: 'AvailabilityState' },
          eventNotificationType: 'HardWiredNotification',
          severity: 2,
        },
      ],
    });
    await expect(ctx.client.sendCall('NotifyPeriodicEventStream', {})).rejects.toThrow(
      'not defined in OCPP 2.0.1',
    );
    expect(station.violations).toEqual([
      expect.stringContaining('command TriggerMessage: TriggerMessage cannot be sent'),
      expect.stringContaining('station NotifyPeriodicEventStream'),
    ]);
    expect(station.mappingLosses).toEqual(['NotifyEventRequest: eventData[0].severity removed']);
  });

  for (const tc of cases) {
    it(`${tc.id} sends only what OCPP 2.0.1 carries`, async () => {
      const { ctx, station } = fakeContext(VERSION, tc.id);
      await runToEnd(tc.execute(ctx).catch(() => undefined));
      expect([...station.violations, ...station.mappingLosses]).toEqual([]);
    }, 120_000);
  }

  it('reached the scenarios (station messages and commands of most cases)', () => {
    expect(reached.messages).toBeGreaterThan(600);
    expect(reached.casesWithCommand.size).toBeGreaterThan(150);
  });
});
