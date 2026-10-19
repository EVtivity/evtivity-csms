// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { WebSocketServer } from 'ws';
import type { OcppVersion, TestContext } from '../types.js';
import { TC_B_58_CSMS } from '../tests/v2_1/csms/B-provisioning/TC_B_30_CSMS.js';

const SUPPORTED = ['ocpp2.1', 'ocpp2.0.1', 'ocpp1.6'];
const pick = (offered: Set<string>): string | false =>
  SUPPORTED.find((p) => offered.has(p)) ?? false;

let server: WebSocketServer | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server == null) resolve();
    else server.close(() => resolve());
  });
  server = null;
});

/** A CSMS endpoint; `rejectUnsupported` refuses an upgrade that offers no supported subprotocol. */
async function startCsms(rejectUnsupported: boolean): Promise<string> {
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    handleProtocols: (protocols) => pick(protocols),
    ...(rejectUnsupported
      ? {
          verifyClient: (
            info: { req: { headers: Record<string, string | string[] | undefined> } },
            done: (ok: boolean, code?: number) => void,
          ) => {
            const header = info.req.headers['sec-websocket-protocol'];
            const offered = new Set(
              String(header ?? '')
                .split(',')
                .map((p) => p.trim()),
            );
            done(pick(offered) !== false, 400);
          },
        }
      : {}),
  });
  server = wss;
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  return `ws://127.0.0.1:${String((wss.address() as AddressInfo).port)}`;
}

function context(serverUrl: string, version: OcppVersion): TestContext {
  return {
    client: {
      setDisconnectedHandler: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as TestContext['client'],
    version,
    stationId: 'OCTT-B-provisioning-TC_B_58_CSMS-test',
    tokens: {} as TestContext['tokens'],
    stationDbId: 'sta_test',
    logger: pino({ level: 'silent' }),
    config: { serverUrl },
  };
}

describe('TC_B_58_CSMS (OCPP-J 3.1.2 subprotocol negotiation)', () => {
  for (const version of ['ocpp2.1', 'ocpp2.0.1'] as const) {
    it(`${version}: passes when the CSMS refuses ocpp0.1 alone and selects ${version}`, async () => {
      const url = await startCsms(true);
      const result = await TC_B_58_CSMS.execute(context(url, version));
      expect(result.steps.map((s) => [s.step, s.status])).toEqual([
        [2, 'passed'],
        [4, 'passed'],
      ]);
      expect(result.steps[1]?.actual).toBe(`101 with Sec-WebSocket-Protocol: ${version}`);
      expect(result.status).toBe('passed');
    });
  }

  it('fails when the CSMS upgrades a connection that offered no supported subprotocol', async () => {
    const url = await startCsms(false);
    const result = await TC_B_58_CSMS.execute(context(url, 'ocpp2.0.1'));
    expect(result.steps[0]).toMatchObject({
      step: 2,
      status: 'failed',
      actual: 'Upgraded (101) with Sec-WebSocket-Protocol (none)',
    });
    expect(result.steps[1]?.status).toBe('passed');
    expect(result.status).toBe('failed');
  });
});
