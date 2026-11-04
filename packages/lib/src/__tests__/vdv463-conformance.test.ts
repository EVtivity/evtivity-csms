// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Conformance of the pure VDV 463 parts to the communication sequences of the
// interface (section 6.2): every frame a depot system sends parses and reads
// as expected, every state EVtivity reports builds the expected payload, and
// every built payload passes the payload schema. The integration test
// 166-vdv463-websocket replays the same sequences against a real server.

import { describe, expect, it } from 'vitest';
import {
  VDV463_REQUEST_SCHEMAS,
  buildChargingInformation,
  checkChargingRequest,
  parseVdv463Frame,
  provideChargingInformationRequestSchema,
  type Vdv463ChargingRequest,
} from '../vdv463/index.js';
import { SEQUENCES, cleanPayload } from './fixtures/vdv463/sequences.js';

describe('VDV 463 conformance sequences', () => {
  it('covers every sequence of section 6.2', () => {
    expect(SEQUENCES.map((s) => s.follows)).toEqual([
      'VDV 463 6.2.1',
      'VDV 463 6.2.2',
      'VDV 463 6.2.3',
      'VDV 463 6.2.4',
      'VDV 463 6.2.5',
      'VDV 463 6.2.6',
      'VDV 463 6.2.7',
      'VDV 463 6.2.8',
      'VDV 463 6.2.9',
    ]);
  });

  for (const sequence of SEQUENCES) {
    describe(`${sequence.follows}: ${sequence.title}`, () => {
      sequence.steps.forEach((step, index) => {
        if (step.kind === 'in') {
          it(`step ${String(index + 1)}: the depot system frame parses and validates`, () => {
            const parsed = parseVdv463Frame(JSON.stringify(step.frame));
            expect(parsed.ok).toBe(true);
            if (!parsed.ok) return;
            const schema = VDV463_REQUEST_SCHEMAS[parsed.frame.action];
            const payload = schema.safeParse(parsed.frame.payload);
            expect(payload.success).toBe(true);
            if (step.expected == null || !payload.success) return;
            const list = (payload.data as { chargingRequestList: Vdv463ChargingRequest[] })
              .chargingRequestList;
            // The time of the request: the frame's own timestamp.
            const now = new Date(parsed.frame.timestamp);
            list.forEach((request, i) => {
              const expected = step.expected?.[i];
              const checked = checkChargingRequest(request, now);
              if (expected != null && 'refused' in expected) {
                // Refused only by a database rule (here: the vehicle is no bus),
                // so the pure checks pass it on to the service.
                expect(checked.ok).toBe(true);
              } else {
                expect(checked).toEqual({ ok: true, request: expected });
              }
            });
          });
        } else {
          it(`step ${String(index + 1)}: EVtivity reports the expected charging information`, () => {
            const built = buildChargingInformation(step.snapshot, new Date(step.now));
            expect(built).toEqual(cleanPayload(step.payload));
            expect(provideChargingInformationRequestSchema.safeParse(built).success).toBe(true);
          });
        }
      });
    });
  }
});
