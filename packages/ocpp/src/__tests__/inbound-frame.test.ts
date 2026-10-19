// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  InboundFrameStats,
  MAX_FRAME_DEPTH,
  exceedsDepth,
  parseInboundFrame,
} from '../server/inbound-frame.js';
import { OcppErrorCode, errorCodeForProtocol } from '../protocol/error-codes.js';

function nestedJson(depth: number): string {
  return '['.repeat(depth) + '{}' + ']'.repeat(depth);
}

describe('exceedsDepth', () => {
  it('counts the outer container as level 1', () => {
    expect(exceedsDepth([], 1)).toBe(false);
    expect(exceedsDepth([[]], 1)).toBe(true);
    expect(exceedsDepth({ a: { b: [] } }, 3)).toBe(false);
    expect(exceedsDepth({ a: { b: [] } }, 2)).toBe(true);
  });

  it('ignores primitives', () => {
    expect(exceedsDepth('text', 0)).toBe(false);
    expect(exceedsDepth(null, 0)).toBe(false);
  });

  it('handles very deep values without recursion', () => {
    const deep = JSON.parse(nestedJson(10_000)) as unknown;
    expect(exceedsDepth(deep, MAX_FRAME_DEPTH)).toBe(true);
  });
});

describe('parseInboundFrame', () => {
  it('parses a CALL', () => {
    expect(parseInboundFrame('[2,"id-1","Heartbeat",{}]', 'ocpp2.1')).toEqual({
      kind: 'call',
      messageId: 'id-1',
      action: 'Heartbeat',
      payload: {},
    });
  });

  it('parses a CALLRESULT and a CALLERROR as responses', () => {
    expect(parseInboundFrame('[3,"id-1",{"status":"Accepted"}]', 'ocpp2.1')).toEqual({
      kind: 'response',
      message: [3, 'id-1', { status: 'Accepted' }],
    });
    expect(parseInboundFrame('[4,"id-1","InternalError","x",{}]', 'ocpp1.6').kind).toBe('response');
  });

  it('drops invalid JSON and frames that are not arrays', () => {
    expect(parseInboundFrame('not json', 'ocpp2.1')).toEqual({
      kind: 'drop',
      reason: 'invalid_json',
    });
    expect(parseInboundFrame('{"a":1}', 'ocpp2.1')).toEqual({ kind: 'drop', reason: 'not_array' });
  });

  it('drops a response whose message id is missing, not a string, empty or over 36 characters', () => {
    for (const id of [null, 5, '', 'x'.repeat(37)]) {
      for (const type of [3, 4]) {
        expect(parseInboundFrame(JSON.stringify([type, id, 'Heartbeat', {}]), 'ocpp2.1')).toEqual({
          kind: 'drop',
          reason: 'invalid_message_id',
        });
      }
    }
  });

  it('refuses a CALL whose message id cannot be read with message id "-1" and RpcFrameworkError', () => {
    for (const id of [null, 5, '', 'x'.repeat(37)]) {
      for (const version of ['ocpp2.1', 'ocpp1.6']) {
        expect(parseInboundFrame(JSON.stringify([2, id, 'Heartbeat', {}]), version)).toEqual({
          kind: 'refuse',
          messageId: '-1',
          errorCode: OcppErrorCode.RpcFrameworkError,
          description: 'The message id must be a string of 1 to 36 characters',
          reason: 'invalid_message_id',
        });
      }
    }
    expect(
      parseInboundFrame(JSON.stringify([2, 'x'.repeat(36), 'Heartbeat', {}]), 'ocpp2.1'),
    ).toMatchObject({ kind: 'call' });
  });

  it('refuses a deeply nested CALL with FormatViolation and drops a deeply nested response', () => {
    expect(
      parseInboundFrame(`[2,"deep","DataTransfer",${nestedJson(40)}]`, 'ocpp2.1'),
    ).toMatchObject({
      kind: 'refuse',
      messageId: 'deep',
      errorCode: 'FormatViolation',
      reason: 'too_deep',
    });
    expect(parseInboundFrame(`[3,"deep",${nestedJson(40)}]`, 'ocpp2.1')).toEqual({
      kind: 'drop',
      reason: 'too_deep',
    });
  });

  it('accepts a CALL nested exactly to the limit', () => {
    // Frame (1) + payload object (2) + arrays: the innermost {} sits at the limit.
    const arrays = MAX_FRAME_DEPTH - 3;
    const frame = `[2,"ok","DataTransfer",{"data":${nestedJson(arrays)}}]`;
    expect(parseInboundFrame(frame, 'ocpp2.1').kind).toBe('call');
    const tooDeep = `[2,"ok","DataTransfer",{"data":${nestedJson(arrays + 1)}}]`;
    expect(parseInboundFrame(tooDeep, 'ocpp2.1').kind).toBe('refuse');
  });

  it('refuses a CALL without a payload or with an invalid action with RpcFrameworkError', () => {
    expect(parseInboundFrame('[2,"a","Heartbeat"]', 'ocpp2.1')).toMatchObject({
      kind: 'refuse',
      errorCode: 'RpcFrameworkError',
      reason: 'malformed_call',
    });
    for (const action of [42, '', 'A'.repeat(101), null]) {
      expect(parseInboundFrame(JSON.stringify([2, 'a', action, {}]), 'ocpp2.1')).toMatchObject({
        kind: 'refuse',
        errorCode: 'RpcFrameworkError',
        reason: 'invalid_action',
      });
    }
    expect(parseInboundFrame(JSON.stringify([2, 'a', 'A'.repeat(100), {}]), 'ocpp2.1').kind).toBe(
      'call',
    );
  });

  it('drops a short response', () => {
    expect(parseInboundFrame('[3,"a"]', 'ocpp2.1')).toEqual({
      kind: 'drop',
      reason: 'malformed_response',
    });
  });

  it('never answers an OCPP 2.1 CALLRESULTERROR or SEND', () => {
    expect(parseInboundFrame('[5,"a","InternalError","x",{}]', 'ocpp2.1')).toEqual({
      kind: 'drop',
      reason: 'unanswered_type',
    });
    expect(parseInboundFrame('[6,"a","NotifyPeriodicEventStream",{}]', 'ocpp2.1')).toEqual({
      kind: 'drop',
      reason: 'unanswered_type',
    });
  });

  it('refuses an unknown message type with a usable id, else drops it', () => {
    expect(parseInboundFrame('[7,"a",{}]', 'ocpp2.1')).toMatchObject({
      kind: 'refuse',
      messageId: 'a',
      errorCode: 'MessageTypeNotSupported',
    });
    expect(parseInboundFrame('[6,"a",{}]', 'ocpp1.6')).toMatchObject({
      kind: 'refuse',
      errorCode: 'MessageTypeNotSupported',
    });
    // Message types 5 and 6 are OCPP 2.1 only.
    expect(parseInboundFrame('[6,"a",{}]', 'ocpp2.0.1')).toMatchObject({
      kind: 'refuse',
      errorCode: 'MessageTypeNotSupported',
    });
    expect(parseInboundFrame('["2","a",{}]', 'ocpp2.1')).toMatchObject({ kind: 'refuse' });
    expect(parseInboundFrame('[7,{},{}]', 'ocpp2.1')).toEqual({
      kind: 'drop',
      reason: 'unknown_type',
    });
  });
});

describe('errorCodeForProtocol', () => {
  it('keeps every code on OCPP 2.1', () => {
    for (const code of ['FormatViolation', 'RpcFrameworkError', 'MessageTypeNotSupported']) {
      expect(errorCodeForProtocol(code, 'ocpp2.1')).toBe(code);
    }
  });

  it('uses the OCPP-J 1.6 names on OCPP 1.6', () => {
    expect(errorCodeForProtocol('FormatViolation', 'ocpp1.6')).toBe('FormationViolation');
    expect(errorCodeForProtocol('OccurrenceConstraintViolation', 'ocpp1.6')).toBe(
      'OccurenceConstraintViolation',
    );
    expect(errorCodeForProtocol('RpcFrameworkError', 'ocpp1.6')).toBe('ProtocolError');
    expect(errorCodeForProtocol('MessageTypeNotSupported', 'ocpp1.6')).toBe('GenericError');
  });

  it('keeps codes both versions share, and ignores Object.prototype names', () => {
    for (const code of ['SecurityError', 'NotImplemented', 'TypeConstraintViolation', 'toString']) {
      expect(errorCodeForProtocol(code, 'ocpp1.6')).toBe(code);
    }
  });
});

describe('InboundFrameStats', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts by reason and logs at most once per interval', () => {
    vi.useFakeTimers({ now: 10_000 });
    const warn = vi.fn();
    const logger = { warn } as unknown as ConstructorParameters<typeof InboundFrameStats>[0];
    const counted = new InboundFrameStats(logger, 5_000);

    counted.record('CS-1', 'too_deep');
    counted.record('CS-1', 'too_deep');
    counted.record('CS-2', 'unknown_response');
    expect(warn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    counted.record('CS-2', 'unknown_response');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      { counts: { too_deep: 1, unknown_response: 2 }, lastStationId: 'CS-2' },
      'Inbound OCPP frames dropped, refused or not logged',
    );
    expect(counted.snapshot()).toEqual({ too_deep: 2, unknown_response: 2 });
  });
});
