// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  limitMightKw,
  limitTransition,
  parseLimitRecord,
  profiledLimit,
  UNKNOWN_LIMIT,
  type LimitRecord,
} from '../load-limit-state.js';

describe('limitTransition', () => {
  const sent = limitTransition(profiledLimit(5), { type: 'send', commandId: 'c1', kw: 11 });

  it('carries what the station may hold before a send', () => {
    expect(sent).toEqual({ state: 'awaiting', commandId: 'c1', sentKw: 11, mightKw: 5 });
    expect(limitMightKw(sent)).toBe(11);
  });

  it('accepts only the reply to the current command', () => {
    const cut = limitTransition(sent, { type: 'send', commandId: 'c2', kw: 5 });
    expect(limitMightKw(cut)).toBe(11);
    expect(limitTransition(cut, { type: 'accepted', commandId: 'c1' })).toBe(cut);
    const accepted = limitTransition(cut, { type: 'accepted', commandId: 'c2' });
    expect(accepted.state).toBe('accepted');
    expect(limitMightKw(accepted)).toBe(5);
  });

  it('keeps the highest limit after a timeout and the earlier one after a failed publish', () => {
    expect(limitMightKw(limitTransition(sent, { type: 'timeout', commandId: 'c1' }))).toBe(11);
    expect(limitMightKw(limitTransition(sent, { type: 'unpublished', commandId: 'c1' }))).toBe(5);
    // A late Accepted of the lost command still confirms it.
    const lost = limitTransition(sent, { type: 'timeout', commandId: 'c1' });
    expect(limitTransition(lost, { type: 'accepted', commandId: 'c1' }).state).toBe('accepted');
  });

  it('counts a refusing, booted or cleared station as unlimited', () => {
    expect(limitMightKw(limitTransition(sent, { type: 'rejected', commandId: 'c1' }))).toBeNull();
    expect(limitTransition(sent, { type: 'boot' })).toEqual(UNKNOWN_LIMIT);
    expect(limitTransition(sent, { type: 'cleared' })).toEqual(UNKNOWN_LIMIT);
    // A send from an unlimited station may still be unlimited until it is accepted.
    const fromUnknown = limitTransition(UNKNOWN_LIMIT, { type: 'send', commandId: 'c3', kw: 7 });
    expect(limitMightKw(fromUnknown)).toBeNull();
  });

  it('reads a damaged stored record as unknown', () => {
    expect(parseLimitRecord(null)).toEqual(UNKNOWN_LIMIT);
    expect(parseLimitRecord({ state: 'accepted', mightKw: 4 })).toEqual(UNKNOWN_LIMIT);
    expect(parseLimitRecord({ state: 'bogus' })).toEqual(UNKNOWN_LIMIT);
    expect(parseLimitRecord(sent)).toEqual(sent);
  });
});

// An independent station model: it holds what it last applied, applies the
// commands it receives in order, and its replies can be lost, delayed and
// delivered out of order. After every step the record never claims less
// than the station may hold.
describe('limitTransition against a station model (property)', () => {
  type Op =
    | { op: 'send'; kw: number; publish: boolean }
    | { op: 'process'; accept: boolean }
    | { op: 'deliver'; index: number }
    | { op: 'timeout' }
    | { op: 'boot' };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      op: fc.constant('send' as const),
      kw: fc.integer({ min: 0, max: 50 }),
      publish: fc.boolean(),
    }),
    fc.record({ op: fc.constant('process' as const), accept: fc.boolean() }),
    fc.record({ op: fc.constant('deliver' as const), index: fc.nat(5) }),
    fc.record({ op: fc.constant('timeout' as const) }),
    fc.record({ op: fc.constant('boot' as const) }),
  );

  it('never under-counts what the station may enforce', () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 0, max: 50 }), { nil: null }),
        fc.array(opArb, { maxLength: 40 }),
        (start, ops) => {
          // The station's real limit (null: none of ours) and the record.
          let actual: number | null = start;
          let record: LimitRecord = start == null ? UNKNOWN_LIMIT : profiledLimit(start);
          const inbox: Array<{ commandId: string; kw: number }> = [];
          const replies: Array<{ commandId: string; accepted: boolean }> = [];
          let n = 0;
          for (const step of ops) {
            if (step.op === 'send') {
              const commandId = `c${String(++n)}`;
              record = limitTransition(record, { type: 'send', commandId, kw: step.kw });
              if (step.publish) inbox.push({ commandId, kw: step.kw });
              else record = limitTransition(record, { type: 'unpublished', commandId });
            } else if (step.op === 'process') {
              const command = inbox.shift();
              if (command != null) {
                if (step.accept) actual = command.kw;
                replies.push({ commandId: command.commandId, accepted: step.accept });
              }
            } else if (step.op === 'deliver') {
              const [reply] = replies.splice(step.index % Math.max(1, replies.length), 1);
              if (reply != null) {
                record = limitTransition(record, {
                  type: reply.accepted ? 'accepted' : 'rejected',
                  commandId: reply.commandId,
                });
              }
            } else if (step.op === 'timeout') {
              if (record.commandId != null) {
                record = limitTransition(record, { type: 'timeout', commandId: record.commandId });
              }
            } else {
              actual = null;
              inbox.length = 0;
              record = limitTransition(record, { type: 'boot' });
            }
            const might = limitMightKw(record);
            if (might != null && (actual == null || actual > might + 1e-9)) return false;
          }
          return true;
        },
      ),
      { numRuns: 5000, seed: 20261124 },
    );
  });
});
