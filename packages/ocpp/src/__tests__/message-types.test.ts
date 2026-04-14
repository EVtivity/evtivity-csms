// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  createCall,
  createCallResult,
  createCallError,
  isCall,
  isCallResult,
  isCallError,
  MESSAGE_TYPE_CALL,
  MESSAGE_TYPE_CALLRESULT,
  MESSAGE_TYPE_CALLERROR,
} from '../protocol/message-types.js';

describe('message-types', () => {
  describe('createCall', () => {
    it('creates a CALL tuple', () => {
      const call = createCall('msg-1', 'BootNotification', { reason: 'PowerUp' });
      expect(call).toEqual([2, 'msg-1', 'BootNotification', { reason: 'PowerUp' }]);
    });
  });

  describe('createCallResult', () => {
    it('creates a CALLRESULT tuple', () => {
      const result = createCallResult('msg-1', { status: 'Accepted' });
      expect(result).toEqual([3, 'msg-1', { status: 'Accepted' }]);
    });
  });

  describe('createCallError', () => {
    it('creates a CALLERROR tuple with defaults', () => {
      const error = createCallError('msg-1', 'NotImplemented', 'Unknown action');
      expect(error).toEqual([4, 'msg-1', 'NotImplemented', 'Unknown action', {}]);
    });

    it('creates a CALLERROR tuple with details', () => {
      const details = { info: 'test' };
      const error = createCallError('msg-1', 'InternalError', 'Server error', details);
      expect(error[4]).toEqual(details);
    });
  });

  describe('type guards', () => {
    it('isCall identifies CALL messages', () => {
      const call = createCall('msg-1', 'Heartbeat', {});
      expect(isCall(call)).toBe(true);
      expect(isCallResult(call)).toBe(false);
      expect(isCallError(call)).toBe(false);
    });

    it('isCallResult identifies CALLRESULT messages', () => {
      const result = createCallResult('msg-1', {});
      expect(isCallResult(result)).toBe(true);
      expect(isCall(result)).toBe(false);
    });

    it('isCallError identifies CALLERROR messages', () => {
      const error = createCallError('msg-1', 'InternalError', 'fail');
      expect(isCallError(error)).toBe(true);
      expect(isCall(error)).toBe(false);
    });
  });

  describe('message type constants', () => {
    it('has correct values', () => {
      expect(MESSAGE_TYPE_CALL).toBe(2);
      expect(MESSAGE_TYPE_CALLRESULT).toBe(3);
      expect(MESSAGE_TYPE_CALLERROR).toBe(4);
    });
  });
});
